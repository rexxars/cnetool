import {orientMesh} from './mesh.ts'
import type {ObjUp} from './mesh.ts'
import type {Mesh, MeshFace} from './types.ts'

/** A material referenced by {@link GltfMeshInput.materialFor}. */
export interface GltfMaterialInput {
  name: string
  /** Base-color texture as PNG bytes (RGBA to carry transparency). */
  texture?: Uint8Array
  /** Base-color factor RGBA (0-1); used when there's no texture. Defaults to white. */
  baseColor?: [number, number, number, number]
  /** glTF alpha mode. `MASK` (cutoff 0.5) suits a color-keyed texture; default `OPAQUE`. */
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND'
}

/** A named mesh for {@link meshesToGltf}/{@link meshesToGlb}. */
export interface GltfMeshInput {
  name: string
  mesh: Mesh
  /** Material name for a face, or `null`/absent for an untextured face (coloured per-face). */
  materialFor?: (face: MeshFace) => string | null
}

export interface GltfOptions {
  /** Up-axis (default `'y'`, upright - glTF is Y-up). See {@link ObjUp}. */
  up?: ObjUp
  /** Textured materials referenced by `materialFor`. */
  materials?: GltfMaterialInput[]
  /** External buffer filename written into the `.gltf` JSON (default `model.bin`). */
  bufferName?: string
}

/** The text glTF form: a `.gltf` JSON plus its external `.bin` buffer and image files. */
export interface GltfFiles {
  json: Uint8Array
  bin: Uint8Array
  images: Array<{name: string; data: Uint8Array}>
}

const FLOAT = 5126
const ARRAY_BUFFER = 34962
const TRIANGLES = 4

interface Group {
  material: string
  textured: boolean
  positions: number[]
  normals: number[]
  texcoords: number[]
}

interface Built {
  doc: Record<string, unknown>
  bin: Uint8Array
  images: Array<{name: string; data: Uint8Array}>
}

function pad4(n: number): number {
  return (4 - (n % 4)) % 4
}

/** Build the shared glTF document with geometry in buffer 0; images left external. */
function build(items: GltfMeshInput[], options: GltfOptions): Built {
  const up = options.up ?? 'y'
  const matByName = new Map((options.materials ?? []).map((m) => [m.name, m]))
  const used = new Map<string, GltfMaterialInput>()

  // Group every triangle by its material; unweld vertices (non-indexed primitives).
  const nodeGroups: Array<{name: string; groups: Group[]}> = []
  for (const item of items) {
    const mesh = orientMesh(item.mesh, up)
    const groups = new Map<string, Group>()
    for (const face of mesh.faces) {
      const name = item.materialFor?.(face) ?? null
      let key: string
      let textured: boolean
      if (name && matByName.has(name)) {
        key = name
        textured = matByName.get(name)!.texture !== undefined
        used.set(name, matByName.get(name)!)
      } else {
        // untextured: a per-face-colour material
        const {r, g, b} = face.color
        const a = face.alpha
        key = `col_${r}_${g}_${b}_${a}`
        textured = false
        if (!used.has(key)) {
          used.set(key, {
            name: key,
            baseColor: [r / 255, g / 255, b / 255, a / 255],
            alphaMode: a < 255 ? 'BLEND' : 'OPAQUE',
          })
        }
      }
      let group = groups.get(key)
      if (!group) {
        group = {material: key, textured, positions: [], normals: [], texcoords: []}
        groups.set(key, group)
      }
      // fan-triangulate
      for (let k = 1; k + 1 < face.vertices.length; k++) {
        const corners = [0, k, k + 1]
        const p = corners.map((c) => mesh.vertices[face.vertices[c]!]!)
        const ux = p[1]!.x - p[0]!.x,
          uy = p[1]!.y - p[0]!.y,
          uz = p[1]!.z - p[0]!.z
        const vx = p[2]!.x - p[0]!.x,
          vy = p[2]!.y - p[0]!.y,
          vz = p[2]!.z - p[0]!.z
        let nx = uy * vz - uz * vy,
          ny = uz * vx - ux * vz,
          nz = ux * vy - uy * vx
        const nl = Math.hypot(nx, ny, nz) || 1
        nx /= nl
        ny /= nl
        nz /= nl
        for (let c = 0; c < 3; c++) {
          const vtx = p[c]!
          group.positions.push(vtx.x, vtx.y, vtx.z)
          group.normals.push(nx, ny, nz)
          if (textured) {
            const uv = face.uv?.[corners[c]!]
            // glTF UV origin is top-left; CE/OBJ store V bottom-up, so flip.
            group.texcoords.push(uv ? uv[0] : 0, uv ? 1 - uv[1] : 0)
          }
        }
      }
    }
    nodeGroups.push({
      name: item.name,
      groups: [...groups.values()].filter((g) => g.positions.length > 0),
    })
  }

  // Assign material indices in first-seen order.
  const materialNames = [...used.keys()]
  const materialIndex = new Map(materialNames.map((n, i) => [n, i]))

  // Lay out geometry into one binary buffer; build accessors/bufferViews.
  const chunks: Uint8Array[] = []
  let offset = 0
  const bufferViews: Array<Record<string, unknown>> = []
  const accessors: Array<Record<string, unknown>> = []
  const addAccessor = (values: number[], type: 'VEC3' | 'VEC2', minmax: boolean): number => {
    const arr = Float32Array.from(values)
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
    const p = pad4(offset)
    if (p) {
      chunks.push(new Uint8Array(p))
      offset += p
    }
    bufferViews.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: bytes.length,
      target: ARRAY_BUFFER,
    })
    chunks.push(bytes)
    offset += bytes.length
    const dim = type === 'VEC3' ? 3 : 2
    const accessor: Record<string, unknown> = {
      bufferView: bufferViews.length - 1,
      componentType: FLOAT,
      count: values.length / dim,
      type,
    }
    if (minmax) {
      const min = Array.from({length: dim}, () => Infinity)
      const max = Array.from({length: dim}, () => -Infinity)
      for (let i = 0; i < values.length; i += dim) {
        for (let d = 0; d < dim; d++) {
          const v = values[i + d]!
          if (v < min[d]!) min[d] = v
          if (v > max[d]!) max[d] = v
        }
      }
      accessor.min = min
      accessor.max = max
    }
    accessors.push(accessor)
    return accessors.length - 1
  }

  const meshes: Array<Record<string, unknown>> = []
  const nodes: Array<Record<string, unknown>> = []
  for (const {name, groups} of nodeGroups) {
    const primitives = groups.map((g) => {
      const attributes: Record<string, number> = {
        POSITION: addAccessor(g.positions, 'VEC3', true),
        NORMAL: addAccessor(g.normals, 'VEC3', false),
      }
      if (g.textured) attributes.TEXCOORD_0 = addAccessor(g.texcoords, 'VEC2', false)
      return {attributes, mode: TRIANGLES, material: materialIndex.get(g.material)!}
    })
    meshes.push({name, primitives})
    nodes.push({name, mesh: meshes.length - 1})
  }

  // Materials + textures + images (images stay external here; finalised per format).
  const images: Array<{name: string; data: Uint8Array}> = []
  const gltfImages: Array<Record<string, unknown>> = []
  const gltfTextures: Array<Record<string, unknown>> = []
  const imageIndexByName = new Map<string, number>()
  const materials = materialNames.map((mname) => {
    const def = used.get(mname)!
    const m: Record<string, unknown> = {name: mname, alphaMode: def.alphaMode ?? 'OPAQUE'}
    if (def.alphaMode === 'MASK') m.alphaCutoff = 0.5
    const pbr: Record<string, unknown> = {metallicFactor: 0, roughnessFactor: 1}
    if (def.texture) {
      let imageIdx = imageIndexByName.get(mname)
      if (imageIdx === undefined) {
        imageIdx = gltfImages.length
        imageIndexByName.set(mname, imageIdx)
        gltfImages.push({}) // uri/bufferView filled in per format
        gltfTextures.push({source: imageIdx, sampler: 0}) // textures are 1:1 with images
        images.push({name: `${mname}.png`, data: def.texture})
      }
      pbr.baseColorTexture = {index: imageIdx} // texture index == image index (1:1)
    } else {
      pbr.baseColorFactor = def.baseColor ?? [1, 1, 1, 1]
    }
    m.pbrMetallicRoughness = pbr
    m.doubleSided = true
    return m
  })

  const doc: Record<string, unknown> = {
    asset: {version: '2.0', generator: 'cnetool'},
    scene: 0,
    scenes: [{nodes: nodes.map((_, i) => i)}],
    nodes,
    meshes,
    accessors,
    bufferViews,
    materials,
    buffers: [{byteLength: offset}],
  }
  if (gltfImages.length) {
    doc.images = gltfImages
    doc.textures = gltfTextures
    doc.samplers = [{wrapS: 10497, wrapT: 10497}] // REPEAT
  }

  const bin = new Uint8Array(offset)
  let at = 0
  for (const c of chunks) {
    bin.set(c, at)
    at += c.length
  }
  return {doc, bin, images}
}

/**
 * Serialise meshes to the text glTF form: a `.gltf` JSON that references an external
 * `.bin` buffer and external PNG image files (returned alongside). Per-face colour and
 * UVs are preserved; textured materials use the given PNGs with their alpha mode.
 */
export function meshesToGltf(items: GltfMeshInput[], options: GltfOptions = {}): GltfFiles {
  const {doc, bin, images} = build(items, options)
  ;(doc.buffers as Array<Record<string, unknown>>)[0]!.uri = encodeURIComponent(
    options.bufferName ?? 'model.bin',
  )
  const docImages = (doc.images as Array<Record<string, unknown>> | undefined) ?? []
  docImages.forEach((img, i) => {
    img.uri = encodeURIComponent(images[i]!.name)
  })
  const json = new TextEncoder().encode(JSON.stringify(doc, null, 2))
  return {json, bin, images}
}

/**
 * Serialise meshes to a single self-contained binary glTF (`.glb`): JSON + geometry +
 * all textures packed into one file. The easiest form to share or open in a viewer.
 */
export function meshesToGlb(items: GltfMeshInput[], options: GltfOptions = {}): Uint8Array {
  const {doc, bin, images} = build(items, options)
  const bufferViews = doc.bufferViews as Array<Record<string, unknown>>
  const docImages = (doc.images as Array<Record<string, unknown>> | undefined) ?? []

  // Append each PNG into buffer 0 as a bufferView the image references.
  const extra: Uint8Array[] = []
  let offset = bin.length
  docImages.forEach((img, i) => {
    const p = pad4(offset)
    if (p) {
      extra.push(new Uint8Array(p))
      offset += p
    }
    const data = images[i]!.data
    bufferViews.push({buffer: 0, byteOffset: offset, byteLength: data.length})
    extra.push(data)
    offset += data.length
    img.bufferView = bufferViews.length - 1
    img.mimeType = 'image/png'
  })
  ;(doc.buffers as Array<Record<string, unknown>>)[0]!.byteLength = offset

  const binChunk = new Uint8Array(offset + pad4(offset))
  binChunk.set(bin, 0)
  let at = bin.length
  for (const e of extra) {
    binChunk.set(e, at)
    at += e.length
  }
  for (let i = at; i < binChunk.length; i++) binChunk[i] = 0 // pad with 0

  let json = new TextEncoder().encode(JSON.stringify(doc))
  const jsonPad = pad4(json.length)
  if (jsonPad) {
    const padded = new Uint8Array(json.length + jsonPad)
    padded.set(json)
    for (let i = json.length; i < padded.length; i++) padded[i] = 0x20 // space-pad JSON
    json = padded
  }

  const total = 12 + 8 + json.length + 8 + binChunk.length
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x46546c67, true) // 'glTF'
  dv.setUint32(4, 2, true) // version
  dv.setUint32(8, total, true)
  dv.setUint32(12, json.length, true)
  dv.setUint32(16, 0x4e4f534a, true) // 'JSON'
  out.set(json, 20)
  const binStart = 20 + json.length
  dv.setUint32(binStart, binChunk.length, true)
  dv.setUint32(binStart + 4, 0x004e4942, true) // 'BIN\0'
  out.set(binChunk, binStart + 8)
  return out
}
