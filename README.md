# cnetool

[![npm version](https://img.shields.io/npm/v/cnetool.svg?style=flat-square)](https://www.npmjs.com/package/cnetool)

Tools for working with [Codename Eagle](https://en.wikipedia.org/wiki/Codename_Eagle) game data files. Use it programmatically as a library, or through the `cnetool` command line interface. The library is split into an `api` layer (operates on `Uint8Array`) and a Node.js `cli` layer that wraps it - the CLI is a thin shell around the same API methods you can call yourself.

It can unpack the game's `.dat` archives (`textures.dat`, `MENU/menupics.dat`, `objects.dat`, …) into their individual entries. Texture entries are rebuilt into standalone TGA files; entries whose payload isn't a known format are written out as their raw stored blobs. The reverse-engineered file format is documented in [`docs/formats.md`](./docs/formats.md).

For more info about the game, see [Codename Eagle Nation](https://codenameeagle.net/).

Requires Node.js 22.19 or higher. Pure ESM.

## Installation

```bash
npm install --save cnetool
```

To use the CLI without installing it as a dependency:

```bash
npx cnetool extract textures.dat
```

## CLI usage

### `cnetool extract <archive...>`

Extract every entry from one or more archives. Textures become standalone TGA files; other entries are written as their raw stored blobs.

```bash
# Extract into ./textures/ (a directory named after the archive)
cnetool extract textures.dat

# Extract as PNG instead of TGA
cnetool extract textures.dat --png

# Extract from multiple archives at once (any payload type)
cnetool extract textures.dat menupics.dat objects.dat
```

| Option         | Description                                                         |
| -------------- | ------------------------------------------------------------------- |
| `-p, --png`    | Write textures as PNG instead of TGA.                               |
| `-o, --output` | Output directory. Defaults to a directory named after each archive. |
| `-h, --help`   | Show help.                                                          |

Extraction is a faithful raw unpack: the game makes a 24-bit texture's black see-through at draw time (a per-draw color key, not part of the texture - see [`docs/formats.md`](./docs/formats.md)), so extracted images keep their black pixels. The model export commands below apply the key per face, matching the engine.

### `cnetool mesh <objects.dat> [name...]`

Export `objects.dat` "project" meshes - including level terrain (`land<n>` / `level<n>`) - to Wavefront OBJ files you can open in Blender. With no names, every project with geometry is exported.

```bash
# Export every model + terrain to ./objects-meshes/
cnetool mesh objects.dat

# Export specific projects
cnetool mesh objects.dat land1 level12 -o ./terrain

# Textured: also write .mtl + extract the referenced textures (needs 24bits/textures.dat)
cnetool mesh objects.dat dm1 --textures -o ./dm1
```

| Option           | Description                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `-t, --textures` | Also emit `.mtl` materials and extract the referenced textures (needs `24bits/textures.dat` next to `objects.dat`). |
| `-p, --png`      | Write extracted textures as PNG instead of TGA.                                                                     |
| `--lod <level>`  | Which level-of-detail layer to export: `high` (default), `medium`, `low`, or a 0-based index.                       |
| `--up <axis>`    | Up-axis of the export: `y` (default, upright), `z` (Blender Z-up), or `raw` (game's −Y-up).                         |
| `-o, --output`   | Output directory. Defaults to `<archive>-meshes`.                                                                   |
| `-h, --help`     | Show help.                                                                                                          |

`mesh` exports raw single-project blobs. To export a **controllable vehicle** (which is an empty stub in `objects.dat` that the engine fills at runtime from several parts), use `object`.

### `cnetool object <objects.dat> <name...>`

Export one **assembled** model per name to a Wavefront OBJ. A name is either a plain project (eg `StBody`) or a controllable vehicle/turret key (eg `car`, `helicopter`, `tank2`, `aagun3`) - the latter is built from its body + parts at the body-local offsets the engine uses. `OBJECTS2.DAT` next to `objects.dat` (helicopter, zeppelin, battleships) is included automatically.

```bash
# Single self-contained .glb per vehicle (geometry + textures + transparency) into ./models/
cnetool object objects.dat car helicopter tank2 --glb -o ./models

# Textured OBJ instead (.obj + .mtl + PNGs)
cnetool object objects.dat car -t -p -o ./models

# A plain project works too (same as `mesh objects.dat StBody`)
cnetool object objects.dat StBody --glb
```

Default output is OBJ; `--glb`/`--gltf` produce glTF, which carries textures and the black-key transparency with the model (and `.glb` is a single file that opens correctly in web viewers, Blender, and Preview - unlike OBJ, where transparency support varies).

| Option           | Description                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `--glb`          | Export a single self-contained binary glTF (`.glb`) per model - geometry + textures + transparency in one file. |
| `--gltf`         | Export text glTF (`.gltf` + `.bin` + `.png` images) per model.                                                  |
| `-t, --textures` | (OBJ) emit a `.mtl` per model and extract the referenced textures. glTF/GLB resolve textures automatically.     |
| `-p, --png`      | (OBJ) write extracted textures as PNG instead of TGA.                                                           |
| `--up <axis>`    | Up-axis: `y` (default, upright), `z` (Blender Z-up), or `raw` (game's −Y-up).                                   |
| `-o, --output`   | Output directory. Defaults to `<archive>-objects`.                                                              |
| `-h, --help`     | Show help.                                                                                                      |

### `cnetool level <levelDir> [objects.dat]`

Assemble a whole level - terrain plus every object placed in its `data1.bin`, positioned and rotated - into one OBJ. The terrain project is auto-detected from the level's `MAINSCR.SCR`. A second object archive (`OBJECTS2.DAT`, added by the 1.33+ multiplayer patches) and a second texture archive (`24bits/texsec.dat`) are picked up automatically when present next to `objects.dat`. By default the export matches what's actually in-game: it skips `World.dat` `Dele` entries and objects whose startup script self-destructs at spawn (e.g. No Man's Land's cacti/palms, which call `REFSetTTL(MYSELF, 0)`) - pass `--keep-removed` to include them.

```bash
# Geometry only
cnetool level path/to/LEVEL128 -o nomansland.obj

# Textured + with controllable vehicles/turrets (tanks, AA guns, 1.41 helicopters…)
cnetool level path/to/LEVEL128 --textures --controllable -o out/nomansland.obj
```

| Option               | Description                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--glb` / `--gltf`   | Export the scene as glTF (`.glb` single file, or `.gltf` + `.bin` + PNGs) instead of OBJ.                                                                           |
| `-t, --textures`     | (OBJ) emit a `.mtl` + extract the referenced textures next to the `.obj`.                                                                                           |
| `-p, --png`          | (OBJ) write extracted textures as PNG instead of TGA.                                                                                                               |
| `--world`            | Source placements from the level's text `World.dat` instead of `data1.bin` (used automatically when `data1.bin` is absent).                                         |
| `--terrain <p>`      | Use this terrain project instead of auto-detecting.                                                                                                                 |
| `--no-terrain`       | Export only the placed objects.                                                                                                                                     |
| `-c, --controllable` | Render controllable vehicles/turrets (tanks, cars, AA turrets, …) using their body geometry. Off by default - these are empty stubs the engine fills in at runtime. |
| `--keep-removed`     | Include objects the engine removes at spawn (`World.dat` `Dele` entries + scripts that self-destruct). They are skipped by default so the export matches the game.  |
| `--up <axis>`        | Up-axis of the export: `y` (default, upright Y-up), `z` (Z-up, eg Blender), or `raw` (as stored - the game is −Y-up).                                               |
| `-o, --output`       | Output path. Defaults to `<levelDir name>-scene.{obj,glb,gltf}` to match the format.                                                                                |

### `cnetool tabmap <levelDir> [objects.dat]`

Generate a level's in-game tab map (the full-screen map): render the terrain top-down by sampling its actual textures, pack the four 256×256 tiles into a `leveltex.bin`, and compute the matching `MAPMTX.DAT` so the player marker lands in the right place. By default the map frames the level's object placements (the gameplay area) with some surrounding water, then applies the shipped maps' look: grayscale with a diagonal light gradient, a white border, and a graph-paper grid. Install by copying the generated `leveltex.bin` + `MAPMTX.DAT` into the level directory.

```bash
# Generate map tiles + matrix + preview PNG into ./LEVEL128-tabmap/
cnetool tabmap path/to/LEVEL128

# Keep the full-color render and frame a custom world window
cnetool tabmap path/to/LEVEL128 --color --center 1024,1024 --size 4096

# Extract a level's existing shipped tab map to a PNG instead
cnetool tabmap path/to/LEVEL128 --extract
```

| Option                | Description                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `--extract`           | Extract the level's existing `map<n>*` tiles, assembled as the engine shows them, to a PNG (instead of generating).                |
| `--map <n>`           | Map number for the tile names. Defaults to the level's existing tiles, else derived from the level number.                         |
| `--terrain <project>` | Terrain project to render. Defaults to auto-detection from the level's `MAINSCR.SCR`.                                              |
| `--center <x,z>`      | World center of the (square) map window. Defaults to auto-framing the placements.                                                  |
| `--size <units>`      | World extent the map covers. Defaults to auto-framing.                                                                             |
| `--water-padding <f>` | How much surrounding terrain (water) to frame around the gameplay area, per side, as a fraction (default `0.25`).                  |
| `--margin <spec>`     | Black margin in pixels: one number for all sides, or four in CSS order. Default is bottom-only 32px (the engine crops the bottom). |
| `--no-border`         | Skip the white frame; `--border-width <px>` sets its width (default 16).                                                           |
| `--no-grid`           | Skip the graph-paper grid overlay; `--grid-spacing <px>` sets the spacing (default 46).                                            |
| `--color`             | Keep the full-color render instead of the default grayscale + light gradient.                                                      |
| `--resolution <px>`   | Full map size in pixels, even (default 512).                                                                                       |
| `--no-preview`        | Don't write the preview PNG.                                                                                                       |
| `-o, --output`        | Output directory (default `<levelDir name>-tabmap`).                                                                               |
| `-h, --help`          | Show help.                                                                                                                         |

### `cnetool world <data1.bin | World.dat> [output]`

Convert a level's object placements between the binary `data1.bin` and the editable text `World.dat` (same data - name, position, 3×3 rotation). The direction is auto-detected. `data1.bin → World.dat` is the "give me something I can edit" step; edit the text, then convert back.

```bash
cnetool world LEVEL3/data1.bin -o World.dat   # binary -> editable text
cnetool world World.dat -o LEVEL3/data1.bin   # text -> binary (output required)
cnetool world LEVEL3/data1.bin                # prints World.dat text to stdout
```

`World.dat`'s `Dele:` entries (a delete directive) are dropped when writing `data1.bin`, which has no equivalent; the `World.dat → data1.bin → World.dat` round trip is otherwise value-identical. `--marker <hex>` sets `data1.bin`'s record marker field (a stale per-file pointer in shipped files that the engine ignores; default 0).

### `cnetool convert <file> [output]`

Convert a texture between TGA and PNG (by extension). `.png → .tga` produces a game-style TGA (BGR, bottom-origin), so an edited PNG can be turned back into the game's format.

```bash
cnetool convert Water.tga          # -> Water.png
cnetool convert Water.png Out.tga  # -> Out.tga
```

### `cnetool servinfo <servinfo.dat> [options]`

Read or edit the host multiplayer match settings in `servinfo.dat` (fraglimit, scorelimit, timelimit in minutes, and the map-rotation "nextmap"). The game host loads these on session start and saves them on session end, so they persist across restarts - set them once for a dedicated server instead of typing console commands each launch. With no write options it prints the current settings; passing any write option edits the file in place (unspecified fields are preserved).

```bash
cnetool servinfo servinfo.dat                                   # show current settings
cnetool servinfo servinfo.dat --time 30 --nextmap Breakpoint    # 30-min rounds, then rotate
cnetool servinfo servinfo.dat --frag 25 --nextmap off           # 25 frags, rotation off
```

`--nextmap` takes a level number, a map name (resolved case-insensitively against `LEVELS.NFO`, default `./levels.nfo` or `--levels <file>`), or `off`. The map switch is broadcast to clients by name, so numbering can differ between machines as long as the display names match.

## API usage

Everything the CLI does is available as plain functions that take and return `Uint8Array`s and data structures: only the CLI touches the filesystem, so the API works in Node, browsers and workers alike. The sections below tour the most common operations; the complete reference covering every export is in [`docs/api.md`](./docs/api.md).

```ts
import {readFile, writeFile} from 'node:fs/promises'
import {extractEntries} from 'cnetool'

const data = await readFile('textures.dat')

// Extract every entry, rebuilding textures into TGAs and passing other
// payloads through as raw blobs. Each entry's `data` is a `Uint8Array`.
for (const entry of extractEntries(data)) {
  console.log('%s (%s)', entry.name, entry.kind) // eg "Water.tga (tga)" or "TankPjb (raw)"
  await writeFile(entry.name, entry.data)
}
```

### `extractEntries(data)`

The high-level entry point. Parses the archive and extracts every entry, choosing the best representation for each: texture entries are rebuilt into standalone TGA files (`kind: 'tga'`), and everything else is returned as its raw stored blob (`kind: 'raw'`). Works for any archive in this format, regardless of payload.

### `parseArchive(data)`

Parses an archive's table of contents and returns the declared entry count along with one `ArchiveEntry` per entry (name, data offset and blob length). It does not read any payload, making it cheap for inspecting an archive.

### `getTextureInfo(data, entry)`

Returns the image geometry (`{width, height, depth, descriptor}`) for a texture entry, or `null` if the entry is not a texture this library can rebuild.

### `extractTexture(data, entry)` / `extractFile(data, entry)`

Lower-level single-entry helpers: `extractTexture` rebuilds a standalone TGA (throwing if the entry isn't a supported texture), while `extractFile` returns the entry's raw stored blob unchanged.

All of these operate on a `Uint8Array` - only the CLI touches the filesystem.

## Text-config files

Most of the game's other `.dat` files are not archives but plain `Key:Value` text (`MOBJS.DAT`, `BRIEF.DAT`, `MATS.DAT`, `KEYCONF.DAT`, …). `parseConfig` reads that family, and `groupRecords` splits the repeated-key files into records. See [`docs/formats.md`](./docs/formats.md) for what each file is.

```ts
import {readFile} from 'node:fs/promises'
import {groupRecords, parseConfig} from 'cnetool'

const entries = parseConfig(await readFile('LEVEL12/MOBJS.DAT'))
// entries: [{key: 'Name', value: 'plane2.1'}, {key: 'Type', value: 'enemyplane'}, …]

// Repeated keys form records - split them on the key that starts each one:
for (const record of groupRecords(entries, 'Name')) {
  const fields = Object.fromEntries(record.map((e) => [e.key, e.value]))
  console.log(fields.Name, '->', fields.Type)
}
```

`parseConfig` accepts a string or raw (Latin-1) bytes. It is line-oriented: blank lines, `//` comments and lines without a `:` are skipped. The localization files have their own parsers (below).

### Obfuscated stat tables (`data3.bin` / `data4.bin`)

The unit and weapon stat tables are the same `Key:Value` text, but obfuscated (every byte has `0x78` added) and interleaved with binary numeric fields. `deobfuscate` reverses the byte shift, and `parseConfig(..., {scan: true})` matches `Key:Value` pairs anywhere, skipping the binary:

```ts
import {deobfuscate, groupRecords, parseConfig} from 'cnetool'

const data = deobfuscate(await readFile('data4.bin'))
for (const record of groupRecords(parseConfig(data, {scan: true}), 'Name')) {
  const w = Object.fromEntries(record.map((e) => [e.key, e.value]))
  console.log(w.Name, w.Damage, w.AmmoType) // eg "6-FLAMETHROWER 8.0 gas"
}
```

## Localization files

The game's localized text comes in two related formats, each with a dedicated parser. Both accept a string or raw (Latin-1) bytes. See [`docs/formats.md`](./docs/formats.md) for details.

`parseDialogue` reads `DIALOGUE.DAT` - a `Languages:N` header followed by records, each a `Filename:` id and one quoted line per language (multi-line cutscene values are handled):

```ts
import {readFile} from 'node:fs/promises'
import {parseDialogue} from 'cnetool'

const {languageCount, entries} = parseDialogue(await readFile('DIALOGUE.DAT'))
for (const {filename, translations} of entries) {
  const byLang = Object.fromEntries(translations.map((t) => [t.language, t.text]))
  console.log(filename, '->', byLang.Eng)
}
```

`parseBriefing` reads `MISSION.DAT` / `ENDBRF.DAT` - free-form text split into sections by `//<language>:----` delimiter lines:

```ts
import {parseBriefing} from 'cnetool'

for (const {language, text} of parseBriefing(await readFile('LEVEL12/MISSION.DAT'))) {
  console.log(`--- ${language} ---\n${text}`)
}
```

## Binary level files

Two of the small per-level binary files have decoders. Both take raw bytes. See [`docs/formats.md`](./docs/formats.md) for the byte layouts.

`parseMatrix` reads `MAPMTX.DAT` - a 3×3 affine matrix (9 float32) that maps world coordinates to minimap pixels. `projectToMap` applies it:

```ts
import {readFile} from 'node:fs/promises'
import {parseMatrix, projectToMap} from 'cnetool'

const matrix = parseMatrix(await readFile('LEVEL12/MAPMTX.DAT'))
const pixel = projectToMap(matrix, worldX, worldZ) // -> {x, y}
```

`parseLights` reads `LIGHTS.DAT` - a header-less array of light sources (range, id, RGB color, world position). It returns `[]` for the empty files most levels ship:

```ts
import {parseLights} from 'cnetool'

for (const light of parseLights(await readFile('LEVEL3/LIGHTS.DAT'))) {
  console.log(light.id, light.color, light.position)
}
```

`parseServerInfo` / `formatServerInfo` read and write `servinfo.dat`, the host's persisted multiplayer match settings (`{fragLimit, scoreLimit, timeLimit, nextMap}` - four uint32). `parseLevelIndex` / `formatLevelIndex` read and write `LEVELS.NFO`, the level index (`{name, number}[]`), which the `nextMap` level number refers to:

```ts
import {formatServerInfo, parseLevelIndex, parseServerInfo} from 'cnetool'

const levels = parseLevelIndex(await readFile('levels.nfo'))
const nextMap = levels.find((l) => l.name.toLowerCase() === 'breakpoint')!.number
const info = parseServerInfo(await readFile('servinfo.dat'))
await writeFile('servinfo.dat', formatServerInfo({...info, timeLimit: 30, nextMap}))
```

## Meshes

`parseMesh` decodes an `objects.dat` "project" blob into a 3D mesh (vertices + polygon faces with color, texture id and UVs); `meshToObj` serializes it to Wavefront OBJ. Level terrain is stored as projects named `land<n>` / `level<n>`.

A project is a **level-of-detail chain** (high → medium → low); `parseMesh` returns the highest by default. Pass `{lod: 'medium' | 'low' | <index>}` for a specific LOD, or `parseMeshLayers(blob)` to get every layer (ordered high→low).

The game stores models **−Y-up**, so exports are flipped to a conventional upright **Y-up** by default. Pass `meshToObj`/`meshesToObj` an `up` option - `'z'` (Z-up, eg Blender/Unreal) or `'raw'` (untouched, −Y-up) - or call `orientMesh(mesh, up)` directly. Reflecting transforms reverse face winding so normals stay outward.

```ts
import {extractFile, meshToObj, parseArchive, parseMesh} from 'cnetool'

const data = await readFile('objects.dat')
const {entries} = parseArchive(data)
const land = entries.find((e) => e.name === 'land1')!

const mesh = parseMesh(extractFile(data, land))
console.log(mesh.vertices.length, mesh.faces.length) // 1768 3499
await writeFile('land1.obj', meshToObj(mesh, {name: 'land1'}))
```

A face's `texId` indexes a texture-name table in `objects.dat`; `parseObjectTextures` returns it (`texId → filename`), which you resolve against `textures.dat`. `meshToObj`'s `material` / `mtllib` options and `buildMtl` produce textured exports (this is what `cnetool mesh --textures` does):

```ts
import {parseObjectTextures} from 'cnetool'

const texNames = parseObjectTextures(data) // index by face.texId, e.g. 'MULT15.TGA'
```

### Whole-level assembly

`assembleLevel` builds a whole scene - terrain plus every object in `data1.bin`, positioned and rotated - from `objects.dat`; `readLandscape` finds a level's terrain project from its `MAINSCR.SCR`. This is exactly what `cnetool level` does (the CLI just reads the files and writes the OBJ).

```ts
import {assembleLevel, meshesToObj, readLandscape} from 'cnetool'

const objects = await readFile('objects.dat')
const terrain = readLandscape(await readFile('LEVEL128/MAINSCR.SCR'))?.landscape
const scene = assembleLevel(objects, {
  placements: await readFile('LEVEL128/data1.bin'),
  terrain,
})
console.log(scene.items.length, 'objects;', scene.missing.length, 'with no mesh')
await writeFile('scene.obj', meshesToObj(scene.items))
```

Lower-level building blocks are also exported: `parsePlacements` (decode `data1.bin`), `transformMesh` (apply a placement), `createTextureResolver` (`texId` → material + `textures.dat` entry).

### Text level placements (`World.dat`)

`World.dat` is the engine's human-readable placement file (the text twin of `data1.bin`, shipped for multiplayer levels). `parseWorld` reads it into placements you can feed straight to `assembleLevel`, and `formatWorld` writes them back - so you can edit or author levels.

```ts
import {assembleLevel, formatWorld, parseWorld} from 'cnetool'

const entries = parseWorld(await readFile('LEVEL128/World.dat')) // WorldEntry[] (≈ Placement[])
const scene = assembleLevel(objects, {placements: entries, terrain})

entries.push({
  kind: 'Name',
  name: 'tank_99',
  position: {x: 0, y: 0, z: 0},
  rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
})
await writeFile('LEVEL128/World.dat', formatWorld(entries))
```

## Scripts (`.scr` files)

The game's behavior is driven by compiled scripts (`MAINSCR.SCR` and the per-object `.scr` files inside `objects.dat`) running on a small stack VM in the engine. `parseScript` decodes the bytecode, `decompileScript` turns it into readable C-like source, and `compileScript` compiles that source back to bytecode the engine runs - so you can read, edit and rebuild the game's scripts. The language, the engine callbacks and all 128 built-in `REF` functions are documented in [`docs/scripts.md`](./docs/scripts.md).

```ts
import {readFile, writeFile} from 'node:fs/promises'
import {compileScript, decompileScript, parseScript} from 'cnetool'

const script = parseScript(await readFile('LEVEL128/MAINSCR.SCR'))
const source = decompileScript(script) // readable C-like source

// ...edit the source, then compile it back to bytecode:
await writeFile('LEVEL128/MAINSCR.SCR', compileScript(source))
```

`disassembleScript` gives a raw instruction listing instead, and `selfDestructsAtSpawn` tells you whether a script removes its object at spawn (which is how `cnetool level` knows what the game actually shows).

## Tab maps

The in-game full-screen map is four texture tiles plus a world-to-pixel matrix; `renderTabMap` renders a terrain mesh top-down with real texture sampling, `sliceTabMapTiles` + `buildTextureArchive` pack it into a `leveltex.bin`, and `tabMapMatrix` computes the matching `MAPMTX.DAT`. `extractTabMap` reassembles a level's existing map into one image. This is what `cnetool tabmap` drives; the individual steps (framing, grayscale styling, windowing) are all exported - see [`docs/api.md`](./docs/api.md#tab-maps) and the format notes in [`docs/formats.md`](./docs/formats.md).

## Images

Convert the game's TGA textures to/from PNG. The image module uses [`fflate`](https://github.com/101arrowz/fflate) for compression, so it has no native dependency.

```ts
import {decodePng, decodeTga, pngToTga, tgaToPng} from 'cnetool'

const png = tgaToPng(await readFile('Water.tga')) // game TGA -> PNG
const tga = pngToTga(await readFile('Edited.png')) // edited PNG -> game-style TGA

// or work with raw pixels: { width, height, channels (3|4), data } top-down RGB(A)
const {width, height, data} = decodeTga(await readFile('Water.tga'))
const pixels = decodePng(png)
```

`decodeTga`/`decodePng` give raw RGB(A) pixels; `encodePng`/`encodeTga` go back. TGAs are uncompressed true-color (24/32-bit); `decodePng` supports 8-bit RGB/RGBA PNGs (all five scanline filters).

## Documentation

The full API reference and the reverse-engineering notes on the game's data live in [`docs/`](./docs):

- [`api.md`](./docs/api.md) - the complete API reference, every exported function and type
- [`formats.md`](./docs/formats.md) - confirmed file formats
- [`scripts.md`](./docs/scripts.md) - the scripting guide: execution model, variables, engine callbacks, and the 128 `REF` built-in functions
- [`files.md`](./docs/files.md) - inventory of a Codename Eagle install, by kind
- [`game-flow.md`](./docs/game-flow.md) - how the formats tie together (boot → level → scripts)
- [`network.md`](./docs/network.md) - multiplayer: server discovery and the wire protocol
- [`new-level-recipe.md`](./docs/new-level-recipe.md) - step-by-step recipe for building a new level

Contributing - and the API-vs-CLI separation of concerns - is in [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

MIT © [Espen Hovlandsdal](https://espen.codes/)
