// @env node
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {basename, dirname, join} from 'node:path'
import {parseArgs} from 'node:util'

import {
  averageColor,
  buildTextureArchive,
  createTextureResolver,
  decodeTga,
  encodePng,
  extractEntries,
  extractTabMap,
  extractTexture,
  formatMatrix,
  frameTabMap,
  grayscaleTabMap,
  parseMesh,
  parseWorld,
  readLandscape,
  renderTabMap,
  sliceTabMapTiles,
  TAB_MAP_RESOLUTION,
  tabMapMatrix,
  tabMapWindowForMesh,
} from '../api/index.ts'
import type {
  ArchiveInputEntry,
  MeshFace,
  RawImage,
  RgbColor,
  TabMapMargin,
  TabMapWindow,
} from '../api/index.ts'

const usage = `Usage: cetool tabmap [options] <levelDir> [objects.dat]

Generate a level's tab map: render the terrain top-down, pack the four tiles
into a leveltex.bin (the only archive the engine loads tiles from), and compute
the matching MAPMTX.DAT (so the in-game player marker lands correctly).

objects.dat defaults to the level's own, else "<levelDir>/../objects.dat"; the
terrain project is auto-detected from the level's MAINSCR.SCR (its REFSetLandscape
call). Terrain faces are rendered by sampling their actual textures (from the
level's leveltex.bin and the global 24bits/textures.dat).

By default the map frames the level's object placements (the gameplay area) with
a margin; override with --center/--size to frame the terrain however you like.

Outputs (non-destructive) to the output dir: leveltex.bin (the new map tiles
merged into the level's existing textures, or a fresh archive), MAPMTX.DAT, and a
preview PNG. Install by copying leveltex.bin + MAPMTX.DAT into the level dir.

Options:
  -o, --output <dir>   Output directory (default: "<levelDir name>-tabmap").
  --map <n>            Map number for the tile names (default: the level's existing
                       map tiles, else derived from the level number - levels
                       133-247 default to 333, others to their own number).
  --terrain <project>  Terrain project to render (default: auto from MAINSCR.SCR).
  --center <x,z>       World center of the (square) map (default: auto-framed).
  --size <units>       World extent the map covers (default: auto-framed).

  Three independent knobs (world-space vs image-space):
  --water-padding <f>  WORLD: how much surrounding terrain (water) is framed around the
                       gameplay area, per side, fraction of the framed size (default 0.25).
                       Bigger = more water; rendered from the level's own water, not blank
                       fill. This is the only world-framing knob. Ignored with --size.
  --margin <spec>      IMAGE: black margin in PIXELS. Default is bottom-only (32px) - the
                       engine crops the bottom of the tab map. One number = all sides;
                       four = CSS order top,right,bottom,left (eg 0,0,48,0 for a bigger
                       bottom margin only). 0 to disable.
  --no-border          Don't draw the white frame (it's on by default, mirroring the
                       shipped maps); --border-width <px> sets its width (default 16).
  --no-grid            Don't overlay the graph-paper grid (on by default, inside the
                       border); --grid-spacing <px> sets the spacing (default 46).
  --color              Keep the full-color render. By default the map is grayscaled with a
                       diagonal light gradient (bright top-left → dark bottom-right),
                       matching the shipped maps' look.
  --resolution <px>    Full map size in pixels, even (default: ${TAB_MAP_RESOLUTION}).
  --no-preview         Don't write the preview PNG.
  --extract            Instead of generating, extract the level's EXISTING tab map (its
                       shipped map<n>* tiles) and write it as a PNG (-o, default
                       "<levelDir name>-minimap.png"). Render options are ignored.
  -h, --help           Show this help.
`

/**
 * Run the `tabmap` CLI command.
 *
 * @param argv - Arguments following the `tabmap` command.
 */
export async function runTabmap(argv: string[]): Promise<void> {
  const {values, positionals} = parseArgs({
    args: argv,
    options: {
      output: {type: 'string', short: 'o'},
      map: {type: 'string'},
      terrain: {type: 'string'},
      center: {type: 'string'},
      size: {type: 'string'},
      margin: {type: 'string'},
      border: {type: 'boolean', default: true},
      'border-width': {type: 'string'},
      grid: {type: 'boolean', default: true},
      'grid-spacing': {type: 'string'},
      color: {type: 'boolean'},
      'water-padding': {type: 'string'},
      resolution: {type: 'string'},
      preview: {type: 'boolean', default: true},
      extract: {type: 'boolean'},
      help: {type: 'boolean', short: 'h'},
    },
    allowPositionals: true,
    // `--no-border` / `--no-grid` / `--no-preview` negate the default-true flags above
    allowNegative: true,
  })

  if (values.help || positionals.length === 0) {
    process.stdout.write(usage)
    if (positionals.length === 0 && !values.help) process.exitCode = 1
    return
  }

  const levelDir = positionals[0]!

  // --extract: pull the level's *existing* shipped tab map and write it as a PNG (no rendering).
  if (values.extract) {
    await extractExistingMap(levelDir, values.map, values.output)
    return
  }

  const objectsPath = positionals[1] ?? (await defaultObjectsPath(levelDir))
  const objectsData = new Uint8Array(await readFile(objectsPath))

  const terrain = values.terrain ?? (await detectTerrain(levelDir))
  if (!terrain) {
    process.stderr.write('Could not detect the terrain project; pass --terrain <project>.\n')
    process.exitCode = 1
    return
  }
  const entry = extractEntries(objectsData).find(
    (e) => e.name.toLowerCase() === terrain.toLowerCase(),
  )
  if (!entry) {
    process.stderr.write(`Terrain project "${terrain}" not found in ${objectsPath}.\n`)
    process.exitCode = 1
    return
  }
  const mesh = parseMesh(entry.data)

  const resolution = values.resolution ? Number(values.resolution) : TAB_MAP_RESOLUTION
  if (!Number.isInteger(resolution) || resolution <= 0 || resolution % 2 !== 0) {
    process.stderr.write(
      `--resolution must be a positive even integer, got "${values.resolution}".\n`,
    )
    process.exitCode = 1
    return
  }

  const window = await resolveWindow(values, mesh, levelDir)
  const matrix = tabMapMatrix(window, resolution)

  // Render the terrain (sampling each face's actual texture; average color as a fallback) at full
  // resolution, then paint the image-space frame over its edges (black margin + white border). The
  // frame covers outer water/cropped pixels - the playable area stays central (water-padding), so
  // the MAPMTX needs no offset.
  const leveltex = await readLevelTextures(levelDir)
  const textureArchives = await readTextureArchives(dirname(objectsPath), leveltex)
  const {texture, faceColor} = makeFaceTextures(objectsData, textureArchives)
  const rendered = renderTabMap(mesh, window, {resolution, texture, faceColor, background: WATER})
  // Grayscale + diagonal light gradient by default (matches the shipped maps); --color keeps it.
  const content = values.color ? rendered : grayscaleTabMap(rendered)
  const image = frameTabMap(content, {
    margin: parseMargin(values.margin), // px; default bottom-only 32 (the engine crops the bottom)
    border: values.border ? (values['border-width'] ? Number(values['border-width']) : 16) : 0,
    grid: values.grid ? (values['grid-spacing'] ? Number(values['grid-spacing']) : 46) : 0,
  })

  const mapNumber = await resolveMapNumber(values.map, leveltex, levelDir)
  const tiles = sliceTabMapTiles(image, mapNumber)

  const outDir = values.output ?? `${basename(levelDir)}-tabmap`
  await mkdir(outDir, {recursive: true})

  // The engine only loads map tiles from a texture archive, so the deliverable is a leveltex.bin:
  // merge the new tiles into the level's existing one (replacing any old map<n>* set), or build a
  // fresh archive if the level has none. MAPMTX.DAT places the marker; the PNG is a human preview.
  await writeFile(join(outDir, 'leveltex.bin'), buildLeveltex(leveltex, tiles, mapNumber))
  await writeFile(join(outDir, 'MAPMTX.DAT'), formatMatrix(matrix))
  if (values.preview) await writeFile(join(outDir, `map${mapNumber}-preview.png`), encodePng(image))

  const s = matrix.values[0]!.toFixed(5)
  process.stdout.write(
    `Tab map for ${terrain} (map ${mapNumber}): leveltex.bin + MAPMTX.DAT${values.preview ? ' + preview.png' : ''} -> ${outDir}\n` +
      `  window: center ${window.centerX.toFixed(0)},${window.centerZ.toFixed(0)} size ${window.size.toFixed(0)} (scale ${s})\n` +
      `  install: copy leveltex.bin + MAPMTX.DAT into the level dir; the level's map number must be ${mapNumber}\n` +
      `  (levels 133-247 default to 333; otherwise the level's script must call REFUseMapNumber(${mapNumber})).\n`,
  )
}

/**
 * Build the level's `leveltex.bin` with the new tiles: merge them into the existing archive
 * (replacing any prior `map<n>*` set, keeping everything else) or build a fresh one if the level
 * had none. Uses {@link buildTextureArchive} (the fixed-TOC, internal-blob texture format).
 */
function buildLeveltex(
  existing: Uint8Array | null,
  tiles: ArchiveInputEntry[],
  mapNumber: number,
): Uint8Array {
  const stale = new RegExp(`^map${mapNumber}[0-3]\\.tga$`, 'i')
  const kept = existing
    ? extractEntries(existing)
        .filter((e) => !stale.test(e.name))
        .map((e) => ({name: e.name, data: e.data}))
    : []
  return buildTextureArchive([...kept, ...tiles])
}

/**
 * `--extract`: pull the level's existing shipped tab map (its `map<n>*` tiles, from its
 * `leveltex.bin` or the global pack) and write the reassembled minimap as a PNG.
 */
async function extractExistingMap(
  levelDir: string,
  mapFlag: string | undefined,
  output: string | undefined,
): Promise<void> {
  const leveltex = await readLevelTextures(levelDir)
  const archives = await readTextureArchives(dirname(levelDir), leveltex) // game dir = parent of level
  const mapNumber = await resolveMapNumber(mapFlag, leveltex, levelDir)
  const map = extractTabMap(archives, mapNumber)
  if (!map) {
    process.stderr.write(
      `No complete map${mapNumber} tile set found for ${basename(levelDir)} (pass --map <n>).\n`,
    )
    process.exitCode = 1
    return
  }
  const out = output ?? `${basename(levelDir)}-minimap.png`
  await writeFile(out, encodePng(map))
  process.stdout.write(
    `Extracted minimap (map${mapNumber}, ${map.width}×${map.height}) -> ${out}\n`,
  )
}

/** Tab-map background (unrendered) color - a muted water blue. */
const WATER: RgbColor = {r: 40, g: 58, b: 78}

/**
 * Build the render callbacks: `texture` decodes each face's resolved texture (for per-pixel
 * sampling), and `faceColor` returns its average color as a fallback for faces whose texture
 * can't be decoded. Both are cached by `texId`.
 */
function makeFaceTextures(
  objectsData: Uint8Array,
  textureArchives: Uint8Array[],
): {
  texture: (face: MeshFace) => RawImage | null
  faceColor: (face: MeshFace) => RgbColor | null
} {
  const resolve = createTextureResolver(objectsData, textureArchives)
  const images = new Map<number, RawImage | null>()
  const colors = new Map<number, RgbColor | null>()

  const image = (texId: number): RawImage | null => {
    const cached = images.get(texId)
    if (cached !== undefined) return cached
    let img: RawImage | null = null
    const found = resolve(texId)
    if (found) {
      try {
        img = decodeTga(extractTexture(found.textures, found.entry))
      } catch {
        img = null
      }
    }
    images.set(texId, img)
    return img
  }

  return {
    texture: (face) => (face.texId === null ? null : image(face.texId)),
    faceColor: (face) => {
      if (face.texId === null) return null
      const cached = colors.get(face.texId)
      if (cached !== undefined) return cached
      const img = image(face.texId)
      const color = img ? averageColor(img) : null
      colors.set(face.texId, color)
      return color
    },
  }
}

/**
 * Parse the `--margin` value into per-side **pixel** widths. Default (omitted) is **bottom-only**
 * `32px` - the engine crops the bottom of the tab map, so that's the only side that needs a margin.
 * A single number applies to all sides; four comma-separated values are CSS order
 * `top,right,bottom,left`.
 */
function parseMargin(spec: string | undefined): TabMapMargin {
  if (spec === undefined) return {bottom: 32}
  const parts = spec.split(',').map((p) => Number(p.trim()))
  if (parts.length === 1) return parts[0]! // all sides
  const [top = 0, right = 0, bottom = 0, left = 0] = parts
  return {top, right, bottom, left}
}

/**
 * Resolve the (world-space) map window. The base is the gameplay area - the object placements'
 * bounding box (or the terrain mesh's, as a fallback). `--water-padding` is the single world
 * knob: it zooms the window out so a border of the surrounding terrain (the level's own water
 * faces/textures, not a blank fill) is rendered around the land - keeping the marker placeable
 * over water. (Distinct from the image-space `--margin`/`--border`, which add pixels, not world.)
 */
async function resolveWindow(
  values: {center?: string; size?: string; 'water-padding'?: string},
  mesh: Parameters<typeof tabMapWindowForMesh>[0],
  levelDir: string,
): Promise<TabMapWindow> {
  const waterPadding =
    values['water-padding'] !== undefined ? Number(values['water-padding']) : 0.25

  // Base window: the placements bbox (gameplay area), else the mesh bbox (the raw mesh often has
  // a vast ocean skirt, so placements are preferred). No inherent padding - water-padding adds it.
  let auto = tabMapWindowForMesh(mesh, 0)
  const placements = await readPlacementWindow(levelDir, 0)
  if (placements) auto = placements

  let centerX = auto.centerX
  let centerZ = auto.centerZ
  if (values.center) {
    const [x, z] = values.center.split(',').map((p) => Number(p.trim()))
    if (Number.isFinite(x) && Number.isFinite(z)) {
      centerX = x!
      centerZ = z!
    }
  }
  const size = values.size ? Number(values.size) : auto.size * (1 + 2 * waterPadding)
  return {centerX, centerZ, size}
}

/** Frame the level's placements (World.dat) into a square window, or null if none. */
async function readPlacementWindow(levelDir: string, margin: number): Promise<TabMapWindow | null> {
  for (const name of ['World.dat', 'WORLD.DAT', 'world.dat']) {
    const data = await readFile(join(levelDir, name)).catch(() => null)
    if (!data) continue
    const placements = parseWorld(data)
    if (placements.length === 0) return null
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (const p of placements) {
      minX = Math.min(minX, p.position.x)
      maxX = Math.max(maxX, p.position.x)
      minZ = Math.min(minZ, p.position.z)
      maxZ = Math.max(maxZ, p.position.z)
    }
    const span = Math.max(maxX - minX, maxZ - minZ) * (1 + 2 * margin)
    return {centerX: (minX + maxX) / 2, centerZ: (minZ + maxZ) / 2, size: span > 0 ? span : 1}
  }
  return null
}

/**
 * Default objects.dat: the level's own (self-contained levels like Fortress keep their
 * terrain in `<levelDir>/objects.dat`), else the global `<levelDir>/../objects.dat`.
 */
async function defaultObjectsPath(levelDir: string): Promise<string> {
  const own = join(levelDir, 'objects.dat')
  if (
    await readFile(own).then(
      () => true,
      () => false,
    )
  )
    return own
  return join(dirname(levelDir), 'objects.dat')
}

/** Detect the terrain project from MAINSCR.SCR's REFSetLandscape call. */
async function detectTerrain(levelDir: string): Promise<string | null> {
  for (const name of ['MAINSCR.SCR', 'mainscr.scr']) {
    const data = await readFile(join(levelDir, name)).catch(() => null)
    if (data) return readLandscape(new Uint8Array(data))?.landscape ?? null
  }
  return null
}

/** Read the level's own leveltex.bin, if present. */
async function readLevelTextures(levelDir: string): Promise<Uint8Array | null> {
  for (const name of ['leveltex.bin', 'LEVELTEX.BIN', 'Leveltex.bin']) {
    const data = await readFile(join(levelDir, name)).catch(() => null)
    if (data) return new Uint8Array(data)
  }
  return null
}

/** Texture archives to search for terrain textures: leveltex.bin first, then the global pack. */
async function readTextureArchives(
  objectsDir: string,
  leveltex: Uint8Array | null,
): Promise<Uint8Array[]> {
  const dir24 = join(objectsDir, '24bits')
  const textures = await readFile(join(dir24, 'textures.dat')).catch(() => null)
  const texsec = await readFile(join(dir24, 'texsec.dat')).catch(() => null)
  return [
    ...(leveltex ? [leveltex] : []),
    ...(textures ? [new Uint8Array(textures)] : []),
    ...(texsec ? [new Uint8Array(texsec)] : []),
  ]
}

/**
 * Pick the map number the engine will look for: `--map` if given; else the level's existing
 * `map<n>*` tiles; else derived from the level number via the engine's rule - a level in
 * **[133, 247]** defaults to map **333** (hardcoded in `ce.exe`), any other level number maps to
 * itself. (When `--map` differs from this default, the level's script must call
 * `REFUseMapNumber(n)` to match.)
 */
async function resolveMapNumber(
  flag: string | undefined,
  leveltex: Uint8Array | null,
  levelDir: string,
): Promise<number> {
  if (flag !== undefined && Number.isInteger(Number(flag))) return Number(flag)
  if (leveltex) {
    for (const e of extractEntries(leveltex)) {
      const m = /^map(\d+)[0-3]\.tga$/i.exec(e.name)
      if (m) return Number(m[1])
    }
  }
  const fromDir = /(\d+)/.exec(basename(levelDir))
  const level = fromDir ? Number(fromDir[1]) : 0
  return level >= 133 && level <= 247 ? 333 : level
}
