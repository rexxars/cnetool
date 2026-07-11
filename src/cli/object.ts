// @env node
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {basename, dirname, extname, join} from 'node:path'
import {parseArgs} from 'node:util'

import {
  applyAnmFrame,
  buildMtl,
  controllableGeometry,
  controllableSkins,
  createTextureResolver,
  extractFile,
  meshesToGlb,
  meshesToGltf,
  meshesToObj,
  parseAnm,
  parseArchive,
  parseMesh,
  restPoses,
  transformMesh,
  yawRotation,
} from '../api/index.ts'
import type {
  ArchiveEntry,
  ControllableGeometryMap,
  GltfMaterialInput,
  GltfMeshInput,
  Mesh,
  MeshesToObjItem,
  MeshesToObjOptions,
  MeshLod,
  ObjUp,
  Vector3,
} from '../api/index.ts'
import {resolveGltfGroup, resolveGroup} from './textures.ts'

const usage = `Usage: cnetool object [options] <objects.dat> <name...>

Export one assembled model per name to a Wavefront OBJ. A name is either a plain
"project" in objects.dat (eg StBody) or a controllable vehicle/turret key (eg car,
helicopter, aagun3) - the latter is assembled from its body + parts at the body-local
offsets the engine uses, including parts that live in OBJECTS2.DAT.

OBJECTS2.DAT next to objects.dat is included automatically when present.

Default output is Wavefront OBJ. Pass --glb / --gltf for glTF (textures + transparency
travel with the model; --glb is a single self-contained file that opens anywhere).

Options:
  --glb                Export a single self-contained binary glTF (.glb) per model
                       instead of OBJ - geometry + textures + transparency in one file.
  --gltf               Export text glTF (.gltf + .bin + .png images) per model.
  -t, --textures       (OBJ) write a .mtl per model and extract the referenced images
                       (needs 24bits/textures.dat next to objects.dat). glTF/GLB resolve
                       textures automatically.
  -p, --png            (OBJ) write extracted textures as PNG instead of TGA.
  --up <axis>          Up-axis of the export: y (default, upright Y-up), z (Z-up,
                       eg Blender), or raw (as stored - the game is -Y-up).
  -o, --output <dir>   Output directory. Defaults to "<archive>-objects".
  -h, --help           Show this help.
`

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1]

/** Coerce a --up flag value to an {@link ObjUp}. */
function parseUp(value: string | undefined): ObjUp | undefined {
  return value === 'y' || value === 'z' || value === 'raw' ? value : undefined
}

/**
 * Run the `object` CLI command.
 *
 * @param argv - Arguments following the `object` command.
 */
export async function runObject(argv: string[]): Promise<void> {
  const {values, positionals} = parseArgs({
    args: argv,
    options: {
      output: {type: 'string', short: 'o'},
      glb: {type: 'boolean'},
      gltf: {type: 'boolean'},
      textures: {type: 'boolean', short: 't'},
      png: {type: 'boolean', short: 'p'},
      up: {type: 'string'},
      help: {type: 'boolean', short: 'h'},
    },
    allowPositionals: true,
  })

  if (values.help || positionals.length < 2) {
    process.stdout.write(usage)
    if (positionals.length < 2 && !values.help) process.exitCode = 1
    return
  }

  const [archivePath, ...names] = positionals
  const objectsData = await readFile(archivePath!)
  // The 1.41 patch ships extra models (helicopter, zeppelin, …) in OBJECTS2.DAT next
  // to objects.dat; include it automatically so those vehicles resolve.
  const extra = await readFile(join(dirname(archivePath!), 'OBJECTS2.DAT')).catch(() => null)
  const archives = [objectsData, ...(extra ? [extra] : [])]
  // Rest-pose frames for engine-animated projects (eg motobody's straight steering frame),
  // loaded from the .anm files in ANM/ beside objects.dat.
  const anmFrames = await loadRestPoses(dirname(archivePath!))
  const resolve = makeResolver(archives, anmFrames)

  const outDir = values.output ?? `${basename(archivePath!, extname(archivePath!))}-objects`
  await mkdir(outDir, {recursive: true})

  const up = parseUp(values.up)
  const written = new Set<string>()
  // glTF/GLB resolve textures automatically; OBJ only with -t.
  const wantGltf = values.glb === true || values.gltf === true
  let textureArchives: Uint8Array[] | null = null
  if (values.textures || wantGltf)
    textureArchives = await readTextureArchives(dirname(archivePath!))

  let writtenCount = 0
  for (const name of names) {
    const items = assemble(name, resolve)
    const skin = controllableSkins[name.toLowerCase()] // alt-variant texture swap (car2, plane4)
    if (!items) {
      process.stderr.write(`Unknown object "${name}" (not a project or controllable key)\n`)
      continue
    }

    if (wantGltf) {
      const meshes: GltfMeshInput[] = items.map(({name: itemName, mesh}) => ({
        name: itemName,
        mesh,
      }))
      const materials: GltfMaterialInput[] = []
      if (textureArchives) {
        const seen = new Set<string>()
        for (let source = 0; source < archives.length; source++) {
          const indices = items.flatMap((item, i) => (item.source === source ? [i] : []))
          if (indices.length === 0) continue
          const resolveTexture = createTextureResolver(archives[source]!, textureArchives, skin)
          const group = resolveGltfGroup(
            resolveTexture,
            indices.map((i) => items[i]!.mesh),
          )
          for (const i of indices) {
            meshes[i]!.materialFor = group.materialFor
          }
          for (const m of group.materials)
            if (!seen.has(m.name)) {
              seen.add(m.name)
              materials.push(m)
            }
        }
      }
      if (values.glb)
        await writeFile(join(outDir, `${name}.glb`), meshesToGlb(meshes, {up, materials}))
      if (values.gltf) {
        const {json, bin, images} = meshesToGltf(meshes, {up, materials, bufferName: `${name}.bin`})
        await writeFile(join(outDir, `${name}.gltf`), json)
        await writeFile(join(outDir, `${name}.bin`), bin)
        for (const img of images) {
          if (written.has(img.name.toLowerCase())) continue
          await writeFile(join(outDir, img.name), img.data)
          written.add(img.name.toLowerCase())
        }
      }
      writtenCount++
      continue
    }

    const objItems: MeshesToObjItem[] = items.map(({name: itemName, mesh}) => ({
      name: itemName,
      mesh,
    }))
    const objOptions: MeshesToObjOptions = {up}
    if (textureArchives) {
      const materials = new Map<string, {name: string; map: string; mask?: string}>()
      // A face's texId indexes its own object-archive's texture table, so resolve
      // each archive's items with that archive's resolver and assign per item.
      for (let source = 0; source < archives.length; source++) {
        const indices = items.flatMap((item, i) => (item.source === source ? [i] : []))
        if (indices.length === 0) continue
        const resolveTexture = createTextureResolver(archives[source]!, textureArchives, skin)
        const group = await resolveGroup(
          resolveTexture,
          indices.map((i) => items[i]!.mesh),
          outDir,
          written,
          {png: values.png},
        )
        for (const i of indices) objItems[i]!.material = group.materialFor
        for (const material of group.materials) materials.set(material.name, material)
      }
      if (materials.size > 0) {
        const mtlName = `${name}.mtl`
        await writeFile(join(outDir, mtlName), buildMtl([...materials.values()]))
        objOptions.mtllib = mtlName
      }
    }

    await writeFile(join(outDir, `${name}.obj`), meshesToObj(objItems, objOptions))
    writtenCount++
  }

  process.stdout.write(`Exported ${writtenCount}/${names.length} object(s) into ${outDir}/\n`)
}

export interface ResolvedMesh {
  mesh: Mesh
  source: number
}

/**
 * Build a name → mesh resolver over the given archives, searching each in order and
 * taking the first with usable (non-empty) geometry so an empty stub in objects.dat
 * falls through to a real mesh in OBJECTS2.DAT. Mirrors `assembleLevel`'s lookup.
 *
 * `lod` selects which level-of-detail layer to return (default the highest); projects
 * with fewer layers clamp, so 'low'/'medium' still resolve. See {@link MeshLod}.
 */
export function makeResolver(
  archives: Uint8Array[],
  anmFrames: Map<string, Vector3[]>,
  lod?: MeshLod,
): (name: string) => ResolvedMesh | null {
  const byName = archives.map((archive) => {
    const map = new Map<string, ArchiveEntry>()
    for (const entry of parseArchive(archive).entries) {
      if (!map.has(entry.name.toLowerCase())) map.set(entry.name.toLowerCase(), entry)
    }
    return map
  })
  const cache = new Map<string, ResolvedMesh | null>()
  return (name) => {
    const key = name.toLowerCase()
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    let result: ResolvedMesh | null = null
    for (let source = 0; source < archives.length; source++) {
      const entry = byName[source]!.get(key)
      if (!entry) continue
      let mesh = parseMesh(extractFile(archives[source]!, entry), {lod})
      if (mesh.faces.length > 0) {
        // use the engine's rest-pose frame for animated projects (eg motobody)
        const frame = anmFrames.get(key)
        if (frame && frame.length === mesh.vertices.length) mesh = applyAnmFrame(mesh, frame)
        result = {mesh, source}
        break
      }
    }
    cache.set(key, result)
    return result
  }
}

/** Load each {@link restPoses} project's rest-frame vertices from the `ANM/` directory. */
export async function loadRestPoses(objectsDir: string): Promise<Map<string, Vector3[]>> {
  const frames = new Map<string, Vector3[]>()
  for (const [project, {anm, frame}] of Object.entries(restPoses)) {
    const bytes = await readFile(join(objectsDir, 'ANM', anm)).catch(() => null)
    if (!bytes) continue
    try {
      const parsed = parseAnm(new Uint8Array(bytes))
      if (parsed.frames[frame]) frames.set(project, parsed.frames[frame]!)
    } catch {
      // malformed .anm; skip (project falls back to its static mesh)
    }
  }
  return frames
}

export interface AssembledItem {
  name: string
  mesh: Mesh
  source: number
}

/**
 * Assemble one named object: a plain project resolves to its direct mesh; a
 * controllable key (whose own project is an empty stub) is built from its parts at
 * their body-local offsets. Returns `null` if the name is neither. Unlike
 * `assembleLevel`, the name is used verbatim (no trailing-digit stripping), so an
 * explicit `tank2` resolves to `tank2` rather than `tank`.
 */
export function assemble(
  name: string,
  resolve: (name: string) => ResolvedMesh | null,
  geometry: ControllableGeometryMap = controllableGeometry,
): AssembledItem[] | null {
  // An assembly/controllable definition wins over a raw mesh of the same name (eg
  // the `train` assembly vs the `train` body mesh); only fall back to a direct mesh
  // when the name isn't a known assembly key.
  const parts = geometry[name.toLowerCase()]
  if (!parts) {
    const direct = resolve(name)
    return direct ? [{name, mesh: direct.mesh, source: direct.source}] : null
  }

  const items: AssembledItem[] = []
  for (const part of parts) {
    if (typeof part === 'string') {
      const found = resolve(part)
      if (found) items.push({name: `${name}__${part}`, mesh: found.mesh, source: found.source})
      continue
    }
    const found = resolve(part.project)
    if (!found) continue
    const rotation = part.yaw !== undefined ? yawRotation(part.yaw) : IDENTITY
    part.at.forEach((offset, k) => {
      const suffix = part.at.length > 1 ? `#${k}` : ''
      items.push({
        name: `${name}__${part.project}${suffix}`,
        mesh: transformMesh(found.mesh, {position: offset, rotation}),
        source: found.source,
      })
    })
  }
  return items
}

/** Read the model-texture archives (textures.dat [+ texsec.dat]) from `<dir>/24bits`. */
async function readTextureArchives(dir: string): Promise<Uint8Array[] | null> {
  const dir24 = join(dir, '24bits')
  const texturesData = await readFile(join(dir24, 'textures.dat')).catch(() => null)
  if (!texturesData) {
    process.stderr.write(
      `textures: ${join(dir24, 'textures.dat')} not found; exporting without materials\n`,
    )
    return null
  }
  // 1.41 splits model textures between textures.dat and texsec.dat; search both.
  const texsec = await readFile(join(dir24, 'texsec.dat')).catch(() => null)
  return [texturesData, ...(texsec ? [texsec] : [])]
}
