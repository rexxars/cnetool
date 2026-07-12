// @env node
import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises'
import {basename, dirname, extname, join} from 'node:path'
import {parseArgs} from 'node:util'

import {
  assembleLevel,
  buildMtl,
  createTextureResolver,
  meshesToGlb,
  meshesToGltf,
  meshesToObj,
  parsePlacements,
  parseScript,
  parseWorld,
  readLandscape,
  selfDestructsAtSpawn,
} from '../api/index.ts'
import type {
  GltfMaterialInput,
  GltfMeshInput,
  MeshesToObjItem,
  MeshesToObjOptions,
  ObjUp,
  Placement,
} from '../api/index.ts'
import {loadRestPoses} from './object.ts'
import {resolveGltfGroup, resolveGroup} from './textures.ts'

const usage = `Usage: cetool level [options] <levelDir> [objects.dat]

Assemble a whole level into one Wavefront OBJ: the terrain plus every object
placed in the level's data1.bin (positioned + rotated).

objects.dat defaults to "<levelDir>/../objects.dat". A level-local objects.dat
(eg Level133's own set, or 1.42's sebguard file) is merged in automatically and
its projects win. The terrain project is auto-detected from the level's
MAINSCR.SCR (its REFSetLandscape call).

Default output is Wavefront OBJ. Pass --glb / --gltf for glTF (textures + transparency
travel with the model; --glb is a single self-contained file that opens anywhere).

Options:
  --glb                 Export the scene as a single self-contained binary glTF (.glb)
                        instead of OBJ - geometry + textures + transparency in one file.
  --gltf                Export the scene as text glTF (.gltf + .bin + .png images).
  -t, --textures        (OBJ) emit a .mtl and extract the referenced textures next to
                        the .obj. glTF/GLB resolve textures automatically.
  -p, --png             (OBJ) write extracted textures as PNG instead of TGA.
  -o, --output <file>   Output path. Defaults to "<levelDir name>-scene.{obj,glb,gltf}".
  --terrain <project>   Use this terrain project instead of auto-detecting.
  --no-terrain          Skip the terrain; export only placed objects.
  -c, --controllable    Render controllable vehicles/turrets (tanks, cars, AA
                        turrets, …) using their body geometry. Off by default,
                        since these are empty stubs the engine fills at runtime.
  --world               Source placements from the level's text World.dat instead
                        of data1.bin (used automatically when data1.bin is absent).
  --keep-removed        Don't cull objects the engine removes at spawn. By default the
                        export drops World.dat "Dele" entries and objects whose startup
                        script self-destructs (eg No Man's Land cacti/palms that call
                        REFSetTTL(MYSELF, 0)) - so the render matches what's in-game.
  --up <axis>           Up-axis of the export: y (default, upright Y-up), z (Z-up,
                        eg Blender), or raw (as stored - the game is -Y-up).
  -h, --help            Show this help.
`

/** Coerce a --up flag value to an {@link ObjUp}. */
function parseUp(value: string | undefined): ObjUp | undefined {
  return value === 'y' || value === 'z' || value === 'raw' ? value : undefined
}

/**
 * Run the `level` CLI command.
 *
 * @param argv - Arguments following the `level` command.
 */
export async function runLevel(argv: string[]): Promise<void> {
  const {values, positionals} = parseArgs({
    args: argv,
    options: {
      output: {type: 'string', short: 'o'},
      glb: {type: 'boolean'},
      gltf: {type: 'boolean'},
      textures: {type: 'boolean', short: 't'},
      png: {type: 'boolean', short: 'p'},
      terrain: {type: 'string'},
      'no-terrain': {type: 'boolean'},
      controllable: {type: 'boolean', short: 'c'},
      world: {type: 'boolean'},
      'keep-removed': {type: 'boolean'},
      up: {type: 'string'},
      help: {type: 'boolean', short: 'h'},
    },
    allowPositionals: true,
  })

  if (values.help || positionals.length === 0) {
    process.stdout.write(usage)
    if (positionals.length === 0 && !values.help) process.exitCode = 1
    return
  }

  const levelDir = positionals[0]!
  const objectsPath = positionals[1] ?? join(dirname(levelDir), 'objects.dat')
  const objectsData = await readFile(objectsPath)
  const rawPlacements = await readPlacements(levelDir, values.world ?? false)

  // By default, drop objects the engine removes at spawn so the export matches the game:
  // World.dat `Dele` directives, and objects whose startup script self-destructs.
  let placements = rawPlacements
  let removedNote = ''
  if (rawPlacements !== undefined && !values['keep-removed']) {
    const all = Array.isArray(rawPlacements) ? rawPlacements : parsePlacements(rawPlacements)
    const named = all.filter((p) => (p as {kind?: string}).kind !== 'Dele')
    const selfDeleting = await selfDeletingProjects(
      new Set(named.map((p) => baseProject(p.name))),
      levelDir,
    )
    placements = named.filter((p) => !selfDeleting.has(baseProject(p.name)))
    const deleted = all.length - named.length
    const culled = named.length - placements.length
    if (deleted || culled) {
      const parts = [
        culled ? `${culled} self-deleting (eg cacti/palms)` : '',
        deleted ? `${deleted} Dele` : '',
      ].filter(Boolean)
      removedNote = `; skipped ${parts.join(' + ')} (--keep-removed to include)`
    }
  }

  // The 1.41 patch ships extra models (helicopter, zeppelin, battleships) in
  // OBJECTS2.DAT next to objects.dat; include it automatically when present.
  const extra = await readFile(join(dirname(objectsPath), 'OBJECTS2.DAT')).catch(() => null)
  // A level can carry its own objects.dat that the engine merges over the game
  // one (Level133/248 ship full sets; the unofficial 1.42 adds sebguard-only
  // files). Make it the primary so its projects win, with the game objects.dat
  // as fallback - unless the caller already pointed us at it explicitly.
  const levelObjectsPath = await findFileCI(levelDir, 'objects.dat')
  const levelObjects =
    levelObjectsPath && levelObjectsPath !== objectsPath
      ? await readFile(levelObjectsPath).catch(() => null)
      : null
  const primary = levelObjects ?? objectsData
  const fallbacks = [...(levelObjects ? [objectsData] : []), ...(extra ? [extra] : [])]
  const archives = [primary, ...fallbacks]

  let terrain = values.terrain ?? null
  if (!terrain && !values['no-terrain']) {
    const script = await readMainScript(levelDir)
    terrain = script ? (readLandscape(script)?.landscape ?? null) : null
  }

  const scene = assembleLevel(primary, {
    placements,
    terrain,
    controllable: values.controllable,
    extraObjects: fallbacks.length > 0 ? fallbacks : undefined,
    restFrames: await loadRestPoses(dirname(objectsPath)),
  })

  const up = parseUp(values.up)
  const wantGlb = values.glb === true
  const wantGltf = values.gltf === true
  const ext = wantGlb ? 'glb' : wantGltf ? 'gltf' : 'obj'
  const out = values.output ?? `${basename(levelDir)}-scene.${ext}`
  const outDir = dirname(out)
  await mkdir(outDir, {recursive: true})

  // glTF/GLB always resolve textures; OBJ only with -t.
  const textureArchives =
    values.textures || wantGlb || wantGltf
      ? await readTextureArchives(dirname(objectsPath), levelDir)
      : null

  if (wantGlb || wantGltf) {
    const meshes: GltfMeshInput[] = scene.items.map(({name, mesh}) => ({name, mesh}))
    const materials: GltfMaterialInput[] = []
    if (textureArchives) {
      const seen = new Set<string>()
      for (let source = 0; source < archives.length; source++) {
        const indices = scene.items.flatMap((item, i) => (item.source === source ? [i] : []))
        if (indices.length === 0) continue
        const resolve = createTextureResolver(archives[source]!, textureArchives)
        const group = resolveGltfGroup(
          resolve,
          indices.map((i) => scene.items[i]!.mesh),
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
    if (wantGlb) await writeFile(out, meshesToGlb(meshes, {up, materials}))
    else {
      const binName = `${basename(out, extname(out))}.bin`
      const {json, bin, images} = meshesToGltf(meshes, {up, materials, bufferName: binName})
      await writeFile(out, json)
      await writeFile(join(outDir, binName), bin)
      const written = new Set<string>()
      for (const img of images) {
        if (written.has(img.name.toLowerCase())) continue
        await writeFile(join(outDir, img.name), img.data)
        written.add(img.name.toLowerCase())
      }
    }
  } else {
    const objItems: MeshesToObjItem[] = scene.items.map(({name, mesh}) => ({name, mesh}))
    const objOptions: MeshesToObjOptions = {up}
    if (textureArchives) {
      // A face's texId is an index into *its own* object archive's texture table,
      // so resolve each archive's items with that archive's resolver and assign the
      // material per item; share `written` to extract each image only once.
      const written = new Set<string>()
      const materials = new Map<string, {name: string; map: string; mask?: string}>()
      for (let source = 0; source < archives.length; source++) {
        const indices = scene.items.flatMap((item, i) => (item.source === source ? [i] : []))
        if (indices.length === 0) continue
        const resolve = createTextureResolver(archives[source]!, textureArchives)
        const group = await resolveGroup(
          resolve,
          indices.map((i) => scene.items[i]!.mesh),
          outDir,
          written,
          {png: values.png},
        )
        for (const i of indices) objItems[i]!.material = group.materialFor
        for (const material of group.materials) materials.set(material.name, material)
      }
      if (materials.size > 0) {
        const mtlName = `${basename(out, extname(out))}.mtl`
        await writeFile(join(outDir, mtlName), buildMtl([...materials.values()]))
        objOptions.mtllib = mtlName
      }
    }
    await writeFile(out, meshesToObj(objItems, objOptions))
  }

  const placed =
    scene.items.length - (terrain && scene.items.some((i) => i.name.startsWith('terrain_')) ? 1 : 0)
  const missingNote =
    scene.missing.length > 0 ? `; ${scene.missing.length} project(s) had no mesh` : ''
  process.stdout.write(
    `Assembled ${out}: terrain=${terrain ?? 'none'}, ${placed} objects placed${missingNote}${removedNote}\n`,
  )
}

/** A placement's `objects.dat` project: its name with the trailing `_NN` instance removed. */
function baseProject(name: string): string {
  return name.replace(/_\d+$/, '')
}

/**
 * Of the given project names, which self-destruct the instant they spawn - so the engine
 * never shows them (eg No Man's Land cacti/palms). Resolves each project's script the way
 * the engine does (the level dir overriding `GLOBAL/`) and checks its `startup` handler for
 * `REFSetTTL(MYSELF, 0)` (TTL 0 = destroy now) or `REFDestroy(MYSELF)`.
 */
async function selfDeletingProjects(projects: Set<string>, levelDir: string): Promise<Set<string>> {
  const index = await buildScriptIndex(levelDir)
  const out = new Set<string>()
  for (const project of projects) {
    const path = index.get(project.toLowerCase())
    if (!path) continue
    const bytes = await readFile(path).catch(() => null)
    if (bytes && selfDestructsAtSpawn(parseScript(new Uint8Array(bytes)))) out.add(project)
  }
  return out
}

/** Find `name` in `dir` case-insensitively (`objects.dat` vs `OBJECTS.DAT`); null if absent. */
async function findFileCI(dir: string, name: string): Promise<string | null> {
  const files = await readdir(dir).catch(() => [] as string[])
  const match = files.find((file) => file.toLowerCase() === name.toLowerCase())
  return match === undefined ? null : join(dir, match)
}

/** Case-insensitive map of script base-name → path, from `GLOBAL/` then the level dir (which wins). */
async function buildScriptIndex(levelDir: string): Promise<Map<string, string>> {
  const index = new Map<string, string>()
  for (const dir of [join(dirname(levelDir), 'GLOBAL'), levelDir]) {
    const files = await readdir(dir).catch(() => [] as string[])
    for (const file of files) {
      if (/\.scr$/i.test(file)) index.set(file.slice(0, -4).toLowerCase(), join(dir, file))
    }
  }
  return index
}

/**
 * Read a level's placements: the text `World.dat` if forced or if `data1.bin` is
 * absent, otherwise the binary `data1.bin`. Returns `undefined` if neither exists.
 */
async function readPlacements(
  levelDir: string,
  preferWorld: boolean,
): Promise<Uint8Array | Placement[] | undefined> {
  const readWorld = async (): Promise<Placement[] | null> => {
    for (const fileName of ['World.dat', 'WORLD.DAT', 'world.dat']) {
      const data = await readFile(join(levelDir, fileName)).catch(() => null)
      if (data) return parseWorld(data)
    }
    return null
  }

  if (preferWorld) return (await readWorld()) ?? undefined
  const bin = await readFile(join(levelDir, 'data1.bin')).catch(() => null)
  if (bin) return bin
  return (await readWorld()) ?? undefined
}

/**
 * The texture archives to search, in priority order: the level's own `leveltex.bin`
 * (level-specific art - some levels, e.g. `LEVEL248`/`Level133`, ship their textures here
 * rather than in the global pack), then the global model textures (`textures.dat` [+
 * `texsec.dat`] in `<dir>/24bits`). `leveltex.bin` is searched first so a level texture
 * overrides a global one of the same name. Same container format as `textures.dat`.
 */
async function readTextureArchives(dir: string, levelDir: string): Promise<Uint8Array[] | null> {
  const dir24 = join(dir, '24bits')
  const texturesData = await readFile(join(dir24, 'textures.dat')).catch(() => null)
  const texsec = await readFile(join(dir24, 'texsec.dat')).catch(() => null)
  const leveltex = await readLevelTextures(levelDir)
  if (!texturesData && !leveltex) {
    process.stderr.write(
      `textures: ${join(dir24, 'textures.dat')} not found; exporting without materials\n`,
    )
    return null
  }
  // 1.41 splits model textures between textures.dat and texsec.dat; search both.
  return [
    ...(leveltex ? [leveltex] : []),
    ...(texturesData ? [texturesData] : []),
    ...(texsec ? [texsec] : []),
  ]
}

/** Read the level's own `leveltex.bin` texture archive, if present (tries common casings). */
async function readLevelTextures(levelDir: string): Promise<Uint8Array | null> {
  for (const fileName of ['leveltex.bin', 'LEVELTEX.BIN', 'Leveltex.bin']) {
    const data = await readFile(join(levelDir, fileName)).catch(() => null)
    if (data) {
      process.stderr.write(`textures: also searching ${join(levelDir, fileName)}\n`)
      return data
    }
  }
  return null
}

/** Read a level's main script (MAINSCR.SCR), trying common casings. */
async function readMainScript(levelDir: string): Promise<Uint8Array | null> {
  for (const fileName of ['MAINSCR.SCR', 'mainscr.scr']) {
    const data = await readFile(join(levelDir, fileName)).catch(() => null)
    if (data) return data
  }
  return null
}
