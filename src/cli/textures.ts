// @env node
import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import {decodePng, encodePng, extractTexture, tgaToPng} from '../api/index.ts'
import type {GltfMaterialInput, Mesh, MeshFace, ResolvedTexture} from '../api/index.ts'

// CE keys a 24-bit texture's black to transparent only on faces whose material
// carries file flag 0x02 (see docs/formats.md); the same texture can be drawn
// keyed on one face and opaque on another (eg LOCOMTV: transparent wheels,
// solid body). Models capture this exactly, since the flag is per face: keyed
// faces get a `<name>_key` material with black cut out, plain faces the opaque
// texture. 32-bit textures carry real alpha and render it either way.
const COLOR_KEY_FACE_FLAG = 0x02
const faceKeyed = (face: MeshFace): boolean => (face.flags & COLOR_KEY_FACE_FLAG) !== 0

export interface GroupMaterials {
  /** Material name for a face, or `null` if untextured/unresolved. */
  materialFor: (face: MeshFace) => string | null
  /** Distinct materials used by the group, for `buildMtl`. */
  materials: Array<{name: string; map: string; mask?: string}>
}

/**
 * Resolve the textures used by a group of meshes, extracting each referenced image
 * (once, tracked in `written`) into `outDir`, and return the material wiring for the
 * group's faces. The resolution itself is the API's job ({@link createTextureResolver});
 * this only does the filesystem I/O. Each resolved texture carries the archive it belongs
 * to, so a group may draw images from several archives (eg `textures.dat` + `texsec.dat`).
 *
 * Faces flagged for CE's color-key get a `<name>_key` material whose 24-bit black is cut
 * to transparency (plus a grayscale `map_d` mask for OBJ viewers); plain faces get the
 * opaque texture. 32-bit textures (real alpha) always get a `map_d` mask.
 */
export async function resolveGroup(
  resolve: (texId: number) => ResolvedTexture | null,
  meshes: Iterable<Mesh>,
  outDir: string,
  written: Set<string>,
  options: {png?: boolean} = {},
): Promise<GroupMaterials> {
  const byVariant = new Map<string, string | null>()
  const materials = new Map<string, {name: string; map: string; mask?: string}>()

  // Write `bytes` as `image` once; if RGBA, also write a grayscale map_d mask and return
  // its name. A grayscale mask reads correctly whether a viewer samples alpha, green, or
  // luminance (three.js viewers, Blender, Preview), unlike pointing map_d at the RGBA map.
  const writeImage = async (image: string, bytes: Uint8Array): Promise<string | undefined> => {
    if (!written.has(image.toLowerCase())) {
      await writeFile(join(outDir, image), bytes)
      written.add(image.toLowerCase())
    }
    if (!options.png || decodePng(bytes).channels !== 4) return undefined
    const mask = image.replace(/\.png$/i, '_alpha.png')
    if (!written.has(mask.toLowerCase())) {
      const img = decodePng(bytes)
      const gray = new Uint8Array(img.width * img.height * 3)
      for (let p = 0; p < img.width * img.height; p++) {
        const a = img.data[p * 4 + 3]!
        gray[p * 3] = a
        gray[p * 3 + 1] = a
        gray[p * 3 + 2] = a
      }
      await writeFile(
        join(outDir, mask),
        encodePng({width: img.width, height: img.height, channels: 3, data: gray}),
      )
      written.add(mask.toLowerCase())
    }
    return mask
  }

  for (const mesh of meshes) {
    for (const face of mesh.faces) {
      if (face.texId === null) continue
      const keyed = options.png === true && faceKeyed(face)
      const variant = `${face.texId}|${keyed ? 'k' : 'p'}`
      if (byVariant.has(variant)) continue
      const ref = resolve(face.texId)
      if (!ref) {
        byVariant.set(variant, null)
        continue
      }
      const name = keyed ? `${ref.material}_key` : ref.material
      if (!materials.has(name)) {
        try {
          const tga = extractTexture(ref.textures, ref.entry)
          const image = options.png ? `${name}.png` : ref.entry.name
          const bytes = options.png ? tgaToPng(tga, {colorKey: keyed}) : tga
          const mask = await writeImage(image, bytes)
          materials.set(name, {name, map: image, mask})
        } catch {
          // unsupported texture format; emit the material without a usable map
          materials.set(name, {name, map: options.png ? `${name}.png` : ref.entry.name})
        }
      }
      byVariant.set(variant, name)
    }
  }

  return {
    materialFor: (face) => {
      if (face.texId === null) return null
      const keyed = options.png === true && faceKeyed(face)
      return byVariant.get(`${face.texId}|${keyed ? 'k' : 'p'}`) ?? null
    },
    materials: [...materials.values()],
  }
}

export interface GltfGroup {
  /** Material name for a face, or `null` if untextured/unresolved. */
  materialFor: (face: MeshFace) => string | null
  /** Materials with their texture PNG bytes, for the glTF/GLB writers. */
  materials: GltfMaterialInput[]
}

/**
 * Like {@link resolveGroup}, but for glTF output: returns each material's texture as
 * **in-memory PNG bytes** (no files written) with an alpha mode. Faces flagged for the
 * color-key get a `<name>_key` `MASK` material with 24-bit black cut out; plain faces get
 * the plain texture (`OPAQUE` for 24-bit, `MASK` for 32-bit's native alpha).
 */
export function resolveGltfGroup(
  resolve: (texId: number) => ResolvedTexture | null,
  meshes: Iterable<Mesh>,
): GltfGroup {
  const byVariant = new Map<string, string | null>()
  const materials = new Map<string, GltfMaterialInput>()
  for (const mesh of meshes) {
    for (const face of mesh.faces) {
      if (face.texId === null) continue
      const keyed = faceKeyed(face)
      const variant = `${face.texId}|${keyed ? 'k' : 'p'}`
      if (byVariant.has(variant)) continue
      const ref = resolve(face.texId)
      if (!ref) {
        byVariant.set(variant, null)
        continue
      }
      const name = keyed ? `${ref.material}_key` : ref.material
      if (!materials.has(name)) {
        try {
          const png = tgaToPng(extractTexture(ref.textures, ref.entry), {colorKey: keyed})
          materials.set(name, {
            name,
            texture: png,
            alphaMode: decodePng(png).channels === 4 ? 'MASK' : 'OPAQUE',
          })
        } catch {
          // unsupported texture format; leave the material out (faces fall back to colour)
        }
      }
      byVariant.set(variant, materials.has(name) ? name : null)
    }
  }
  return {
    materialFor: (face) => {
      if (face.texId === null) return null
      return byVariant.get(`${face.texId}|${faceKeyed(face) ? 'k' : 'p'}`) ?? null
    },
    materials: [...materials.values()],
  }
}
