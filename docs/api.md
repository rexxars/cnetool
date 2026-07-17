# API reference

`cnetool` is a TypeScript library for reading and writing the data files of Codename Eagle (1999). Everything is exported as named, import-what-you-need functions from the package root:

```ts
import {parseArchive, extractEntries, parseMesh} from 'cnetool'
```

The library is pure ESM and operates on bytes and strings: functions take `Uint8Array` (or `string` for text formats) and return `Uint8Array`, strings, or plain objects. There is no file I/O in the API, so it runs unchanged in Node, browsers, and workers; read and write files yourself with `node:fs/promises` (or `fetch` in a browser). The examples below use Node.

The one exception is [server discovery and queries](#server-discovery-and-queries): those functions do network I/O (UDP via `node:dgram`, HTTP via `fetch`) and so are Node-only. Everything else remains byte-oriented.

File formats referenced throughout are documented in [formats.md](./formats.md); the scripting system in [scripts.md](./scripts.md).

## Contents

- [Archives](#archives)
- [Images](#images)
- [Meshes and 3D export](#meshes-and-3d-export)
- [Level assembly](#level-assembly)
- [Tab maps](#tab-maps)
- [Scripts: the .scr VM](#scripts-the-scr-vm)
- [Controllables and animation](#controllables-and-animation)
- [Text configs and stat tables](#text-configs-and-stat-tables)
- [Localization](#localization)
- [Level metadata and misc binary](#level-metadata-and-misc-binary)
- [Server discovery and queries](#server-discovery-and-queries)
- [Exported types](#exported-types)

## Archives

Most of the game's assets live in `.dat` archives (see [formats.md](./formats.md#archive-format-dat)): a `uint32` entry count, a table of contents of fixed 17-byte records (13-byte NUL-terminated name + `uint32` absolute blob offset), then the data blobs. Two container layouts exist:

- **Plain/object archives** (`objects.dat`, `menupics.dat`, ...): the TOC is exactly as long as the entry count. `objects.dat` additionally carries a texture-name list between the TOC and the blobs.
- **Texture archives** (`textures.dat`, `texsec.dat`, per-level `leveltex.bin`): the TOC always reserves a fixed 2048 slots (unused slots filled with `0xCC`), and each blob is a TGA with its constant first 8 header bytes stripped. The engine only loads this layout for texture packs.

`parseArchive`/`extractEntries` read both layouts; when writing you must pick the matching builder (`buildArchive` vs `buildTextureArchive`).

### `extractEntries(data: Uint8Array): ExtractedEntry[]`

High-level extraction: parses the archive and returns every entry in archive order, choosing the best representation per entry. Texture entries (a `.tga` name whose blob is a valid partial-header TGA) are rebuilt into standalone TGA files (`kind: 'tga'`); everything else comes back as its raw stored blob (`kind: 'raw'`). Each `ExtractedEntry` also carries the underlying `ArchiveEntry`.

```ts
import {readFile, writeFile} from 'node:fs/promises'
import {extractEntries} from 'cnetool'

const archive = await readFile('textures.dat')
for (const entry of extractEntries(archive)) {
  await writeFile(`out/${entry.name}`, entry.data) // .tga files ready to open
}
```

### `parseArchive(data: Uint8Array): ParsedArchive`

Parses an archive's table of contents into `{declaredCount, entries}` without interpreting any payloads, so it works for texture archives and object archives alike. Each `ArchiveEntry` has `name`, `dataOffset`, and `blobLength` (blobs are stored contiguously in TOC order, so a blob runs to the next entry's offset). Throws if the data does not look like an archive.

### `extractFile(data: Uint8Array, entry: ArchiveEntry): Uint8Array`

Returns an entry's raw stored blob as an independent copy, without interpreting its contents. Use it to get a project blob for `parseMesh`, a `.scr` for `parseScript`, and so on.

### `extractTexture(data: Uint8Array, entry: ArchiveEntry): Uint8Array`

Rebuilds a standalone TGA file for a texture entry by prepending the constant 8 header bytes the archive strips (see [formats.md](./formats.md#texture-payloads)). Throws if the entry is not a supported texture; check with `getTextureInfo` first.

### `getTextureInfo(data: Uint8Array, entry: ArchiveEntry): TextureInfo | null`

Inspects an entry and returns its image geometry (`width`, `height`, `depth`, `descriptor`) if, and only if, it is a texture this library can rebuild: a `.tga` name whose blob is a partial-header TGA of the exact size implied by its dimensions and depth (24- or 32-bit). Returns `null` otherwise, which is also how `extractEntries` decides between `'tga'` and `'raw'`.

### `buildArchive(entries: ArchiveInputEntry[], options?: {textures?: string[]}): Uint8Array`

Builds a plain/object archive from named blobs, the inverse of `parseArchive`: entry count, tight TOC, then the blobs contiguously in the given order. Combine with `extractEntries` to add, replace, or remove whole entries and round-trip the file (output is byte-identical to the original except zero-filled name padding). For `objects.dat`, pass `options.textures` to write the texture-name list the engine reads between the TOC and the blobs (each name at most 12 chars; a face's `texId` indexes this list): use `parseObjectTextures(original)` for a round-trip. Omit it for plain archives. Throws if an entry name exceeds the 13-byte field.

```ts
import {readFile, writeFile} from 'node:fs/promises'
import {buildArchive, extractEntries, parseObjectTextures} from 'cnetool'

const objects = await readFile('objects.dat')
const entries = extractEntries(objects).map((e) => ({name: e.name, data: e.data}))
entries.push({name: 'MyTank', data: myProjectBlob}) // or splice/filter to replace/remove
await writeFile('objects.dat', buildArchive(entries, {textures: parseObjectTextures(objects)}))
```

### `buildTextureArchive(entries: ArchiveInputEntry[]): Uint8Array`

Builds a **texture archive** (`textures.dat`, `leveltex.bin`): the fixed 2048-slot TOC (blobs always start at byte `4 + 2048 * 17`; unused slots and padding are filled `0xCC`, matching the original `CEADDTGA` tool), with each blob stored as the engine's internal texture format. Pass full standard TGAs as each entry's `data` (from `encodeTga`, `pngToTga`, or `extractTexture`); the constant 8-byte TGA prefix is stripped for you. The engine will not load `buildArchive`'s tight layout as a texture pack, so always use this for texture archives. Throws on more than 2048 entries, an over-long name, or a blob too short to be a TGA.

## Images

CE textures are uncompressed true-color TGAs (24-bit opaque or 32-bit with alpha). These helpers convert to and from PNG for editing, and encode/decode the raw pixel form (`RawImage`: top-down rows, 3 or 4 channels). Transparency rules and texture size limits are covered in [formats.md](./formats.md#texture-payloads).

### `tgaToPng(tga: Uint8Array, options?: TgaToPngOptions): Uint8Array`

Decodes an uncompressed true-color TGA and re-encodes it as a PNG. A 32-bit TGA keeps its alpha (RGBA PNG); a 24-bit TGA stays opaque RGB. Two options:

- `colorKey`: map CE's 24-bit black color-key to transparent alpha. Off by default, because a texture has no inherent transparency: the engine keys black only on draws that enable it (a mesh face's `0x02` flag). Matching happens at RGB565 resolution (near-black quantizes to black in-game too). 32-bit images are unaffected; they already carry alpha.
- `topOrigin`: treat the pixel rows as stored top-down regardless of the TGA descriptor. CE's archive texture blobs store rows top-down while their descriptor claims bottom-left origin (the engine reads rows verbatim), so decode archive textures with this on or they come out upside-down. Loose on-disk `.tga` files have truthful descriptors and do not need it.

```ts
import {readFile, writeFile} from 'node:fs/promises'
import {extractEntries, tgaToPng} from 'cnetool'

const archive = await readFile('textures.dat')
for (const entry of extractEntries(archive)) {
  if (entry.kind !== 'tga') continue
  await writeFile(
    `out/${entry.name.replace(/\.tga$/i, '.png')}`,
    tgaToPng(entry.data, {topOrigin: true}),
  )
}
```

### `pngToTga(png: Uint8Array, options?: PngToTgaOptions): Uint8Array`

Decodes a PNG and re-encodes it as a game-ready TGA. An RGB PNG becomes a 24-bit TGA; an RGBA PNG becomes a 32-bit TGA with alpha preserved, which is how you author a transparent texture. The result is always validated against CE's texture rules (square, power-of-two, 24/32-bit) and the call throws if the image cannot load in-game. Set `options.topDown` to store the rows top-down (the layout archive blobs use); this is required when injecting the texture into an archive with `buildTextureArchive`, otherwise it renders upside-down in-game.

### `decodeTga(tga: Uint8Array): RawImage`

Decodes an uncompressed true-color TGA (image type 2, 24- or 32-bit) into top-down RGB(A) pixels, converting the stored BGR(A) and flipping bottom-origin images so the result is always top-down. Throws on other TGA variants.

### `decodePng(png: Uint8Array): RawImage`

Decodes an 8-bit RGB or RGBA PNG into top-down RGB(A) pixels, reversing all five PNG scanline filters. Paletted, grayscale, 16-bit, and interlaced PNGs are not supported and throw.

### `encodeTga(image: RawImage): Uint8Array`

Encodes top-down RGB(A) pixels into an uncompressed true-color TGA matching the game's convention (BGR(A) channel order, bottom-left origin). Round-trips with `decodeTga`.

### `encodePng(image: RawImage): Uint8Array`

Encodes raw RGB(A) pixels into a PNG (color type 2 for 3 channels, 6 for 4). Lossless.

### `averageColor(image: RawImage): RgbColor`

Averages a decoded image down to a single representative color (the mean of every pixel's RGB; alpha ignored). Useful as a `faceColor` source for `renderTabMap`, where a grass/rock/water texture collapses to one recognizable tint.

### `validateCeTexture(image: RawImage): string[]`

Checks an image against CE's texture rules: square, power-of-two dimensions, 24- or 32-bit. Returns a list of human-readable violations, empty when the image is CE-compatible. `pngToTga` runs this for you.

## Meshes and 3D export

`objects.dat` entries ("projects") are 3D models: a shared vertex array plus up to three render LOD layers and an optional collision hull (see [formats.md](./formats.md#objectsdat-payloads---projects-models--terrain)). These functions parse projects into a plain `Mesh` (`{vertices, faces}`), export to OBJ/MTL or glTF/GLB, and import edited OBJ back into the game's format.

A note on orientation: the game stores models with **-Y as up**. Every exporter takes an `up` option (`ObjUp`): `'y'` (default) reflects to conventional upright Y-up, `'z'` rotates to Z-up (Blender/Unreal), `'raw'` leaves the data as stored. Reflecting transforms also reverse face winding so normals stay outward.

### `parseMesh(blob: Uint8Array, options?: ParseMeshOptions): Mesh`

Parses an `objects.dat` project blob into a mesh. A project is a level-of-detail chain (the same model at decreasing detail, sharing one vertex array); by default the highest-detail layer is returned, since rendering all of them would overlay lower-poly copies as artifacts. `options.lod` picks another layer: `'high'` (default), `'medium'`, `'low'`, or a 0-based index (clamped to the layers present). Degenerate and redundant sliver faces that would z-fight in single-sided viewers are dropped.

```ts
import {readFile, writeFile} from 'node:fs/promises'
import {extractFile, meshToObj, parseArchive, parseMesh} from 'cnetool'

const objects = await readFile('objects.dat')
const entry = parseArchive(objects).entries.find((e) => e.name.toLowerCase() === 'stbody')!
const mesh = parseMesh(extractFile(objects, entry))
await writeFile('stbody.obj', meshToObj(mesh, {name: 'STBody'}))
```

### `parseMeshLayers(blob: Uint8Array, limit?: number): Mesh[]`

Parses every LOD layer of a project as a separate `Mesh`, ordered highest-detail first (index 0 is what `parseMesh` returns by default). Each returned mesh shares the project's full vertex array and carries only that layer's faces. Pass `limit` to stop after that many layers.

### `parseDetectMesh(blob: Uint8Array): Mesh | null`

Parses a project's detect/collision mesh: the low-poly hull appended after the render LODs, with its own vertex array (see [formats.md](./formats.md#mesh-layers-lod--detect)). Returns `null` when the project has none (simple/static entries).

### `serializeMesh(mesh: Mesh, options?: SerializeMeshOptions): Uint8Array`

Serializes a `Mesh` to an `objects.dat` project blob, the inverse of `parseMesh`. The engine's loader expects a fixed shape: three render LOD layers sharing one vertex array, then a fourth detect/collision layer with its own vertices. A single `mesh` is written to all three render slots (mirroring how shipped data triplicates simple models); pass `options.lods` for genuine decreasing-detail layers (at most three layers total, more throws) and `options.detect` for the collision hull. Each layer's edge table is regenerated from face topology; the output round-trips through `parseMesh`/`parseMeshLayers`/`parseDetectMesh` and loads in the real engine. Pair with `buildArchive` to put the project into `objects.dat`.

### `objToMesh(text: string, options?: ObjToMeshOptions): Mesh`

Parses Wavefront OBJ text into a `Mesh`, the inverse of `meshToObj`, so a model can round-trip out to OBJ, be edited in Blender, and come back. Reads `v`/`vt`/`f` and `usemtl`; faces default to opaque white with the raw-color flag (OBJ carries no per-face color) and become textured when their `usemtl` resolves to a texture id and the face has UVs. Options: `up` (the OBJ's up-axis, default `'y'`, inverted back to the game's -Y-up storage), `material` (map a `usemtl` name to a texture id; the default recognizes `tex<n>`), and `mtl` (companion `.mtl` contents, so faces take their color/opacity from each material's `Kd`/`d`). Feed the result to `serializeMesh`, then `buildArchive`.

### `meshToObj(mesh: Mesh, options?: MeshToObjOptions): string`

Serializes a `Mesh` to Wavefront OBJ text. UVs are emitted per face-vertex when present. Options: `name` (an `o` line), `up`, and `mtllib` + `material` (a face-to-material-name resolver) to group faces with `usemtl` so the mesh imports textured.

### `meshesToObj(items: MeshesToObjItem[], options?: MeshesToObjOptions): string`

Serializes several named meshes into one OBJ, each under its own `o` group with globally-correct vertex and texcoord indices; this is the OBJ backend for whole level scenes. Each item is `{name, mesh, material?}`; a per-item `material` resolver overrides the call-level one (useful when items come from different texture-table namespaces, such as `objects.dat` vs `OBJECTS2.DAT`).

### `buildMtl(materials: Iterable<MtlMaterial>): string`

Builds a Wavefront MTL from a list of materials, each with an optional diffuse color (`Kd`), opacity (`d`), texture image (`map_Kd`), and a grayscale opacity mask (`map_d`, so a color-keyed texture renders transparent instead of as a black box). `Kd` is written as floats that `objToMesh` reads back to the exact 0-255 channel values.

### `meshesToGltf(items: GltfMeshInput[], options?: GltfOptions): GltfFiles`

Serializes meshes to the text glTF form: a `.gltf` JSON plus its external `.bin` geometry buffer and external PNG images, returned as `{json, bin, images}` for you to write side by side. Per-face color and UVs are preserved (faces are grouped by material and fan-triangulated; normals are computed per triangle); textured materials use the PNGs given in `options.materials` with their alpha mode (`MASK` with cutoff 0.5 suits a color-keyed texture). `options.bufferName` sets the buffer filename written into the JSON (default `model.bin`).

### `meshesToGlb(items: GltfMeshInput[], options?: GltfOptions): Uint8Array`

Same as `meshesToGltf` but packs JSON, geometry, and all textures into a single self-contained binary glTF (`.glb`): the easiest form to share or drop into a viewer.

### `orientMesh(mesh: Mesh, up: ObjUp): Mesh`

Returns a copy of the mesh re-oriented to the given up-axis. For reflecting transforms (`'y'`), face winding and per-vertex UVs are reversed so normals keep pointing outward. The exporters call this internally; use it directly when doing your own geometry processing.

### `transformMesh(mesh: Mesh, placement: Pick<Placement, 'position' | 'rotation'>): Mesh`

Applies a placement (3x3 rotation + translation) to a mesh's vertices, returning a new mesh that shares the original faces. The stored matrix follows the engine's DirectX row-vector convention (`v * M`), which this handles for you; applying it the transposed way silently flips 90/270-degree rotations.

### `yawRotation(degrees: number): number[]`

Builds a row-major 3x3 rotation about the vertical (Y) axis, in the form `transformMesh` and `Placement` expect. Used, for example, to yaw a steered front wheel before applying its body-local offset.

### `parseObjectTextures(data: Uint8Array): string[]`

Parses the texture-name table from `objects.dat` (a `uint32` count + 13-byte name records after the project TOC). A mesh face's `texId` indexes this table, giving the texture's source filename to resolve against a texture archive (see [formats.md](./formats.md#texture-references-texid)).

### `createTextureResolver(objectsData: Uint8Array, textures: Uint8Array | Uint8Array[], skin?: TextureSkin): (texId: number) => ResolvedTexture | null`

Builds a memoized resolver mapping a face's `texId` to a material name and the texture-archive entry holding its image: `texId` -> name in `objects.dat`'s texture table -> entry in one of the texture archives (normalizing source extensions like `.TIF` to `.TGA`). Pass several archives to search them in order (the 1.41 patch splits model textures between `textures.dat` and `texsec.dat`); the resolved `{material, entry, textures}` carries the specific archive its entry came from, so extract the image with `extractTexture(resolved.textures, resolved.entry)`. An optional `skin` map applies a vehicle alt-skin's texture-name swap (see `controllableSkins`). Returns `null` for unmapped textures.

## Level assembly

A level's placed objects live in its binary `data1.bin` or the text `World.dat` (both formats in [formats.md](./formats.md#per-level-data1bin---object-placements)); the terrain is a regular `objects.dat` project named by the level's `MAINSCR.SCR`. `assembleLevel` combines all of it into world-space meshes ready for `meshesToObj` or `meshesToGlb`.

### `assembleLevel(objectsData: Uint8Array, options?: AssembleLevelOptions): LevelScene`

Assembles a level scene from `objects.dat`: optionally the terrain project, plus every placed object positioned and rotated into world space. Returns `{items, missing}`: one named, transformed mesh per item (terrain first), plus the project names that had no usable geometry. Options:

- `placements`: the level's object placements, either raw `data1.bin` bytes or an already-parsed `Placement[]` (from `parsePlacements` or `parseWorld`).
- `terrain`: the terrain project name (e.g. `dm1`); get it from `readLandscape`.
- `extraObjects`: additional object archives searched in order after the primary one, e.g. the multiplayer patch's `OBJECTS2.DAT` (helicopter, zeppelin, battleship bodies). Each item's `source` index tells you which archive its geometry came from, so you can resolve `texId`s against the right texture table.
- `controllable`: vehicles and turrets are placed under logical names whose own project is an empty stub (the engine attaches the body at runtime, see [formats.md](./formats.md#enterable-vehicles--turrets-why-theyre-missing-from-a-level-export)). Pass `true` to substitute the built-in `controllableGeometry` part map so they render, or pass your own `ControllableGeometryMap` to override it. Default `false` leaves them as stubs.
- `restFrames`: rest-pose vertex frames for engine-animated projects (lowercased project name -> frame vertices), so, for example, the motorcycle exports with a straight fork. See `restPoses` and `parseAnm`.

```ts
import {readFile, writeFile} from 'node:fs/promises'
import {assembleLevel, meshesToObj, readLandscape} from 'cnetool'

const objects = await readFile('objects.dat')
const scene = assembleLevel(objects, {
  terrain: readLandscape(await readFile('LEVEL1/MAINSCR.SCR'))?.landscape,
  placements: await readFile('LEVEL1/data1.bin'),
  controllable: true,
})
await writeFile('level1.obj', meshesToObj(scene.items))
```

### `readLandscape(script: Uint8Array): {landscape: string, horizon: string | null} | null`

Reads the landscape (and horizon) project names from a level's `MAINSCR.SCR`: the string arguments of its `REFSetLandscape` call. Returns `null` if the call is not found.

### `parsePlacements(data: Uint8Array): Placement[]`

Parses the object placements from a level's `data1.bin`: fixed 80-byte records, each a name, a world position (3 float32), and a row-major 3x3 rotation matrix. Records are validated structurally, so all-zero/garbage slots are skipped, and the stale per-file heap-pointer "marker" at offset 28 is ignored. Strip the trailing `_NN` from a name to get its `objects.dat` project (`aagun3_03` -> `aagun3`).

### `serializePlacements(placements: readonly Placement[], options?: SerializePlacementsOptions): Uint8Array`

Serializes placements back into `data1.bin` bytes, the inverse of `parsePlacements`; round-trips exactly (float32 in/out). Names longer than 28 bytes are truncated and a short `rotation` is filled from the identity matrix. `options.marker` sets the 4-byte don't-care value written at offset 28 of every record (default `0`, which shipped files also use).

### `parseWorld(data: Uint8Array | string): WorldEntry[]`

Parses a level's text `World.dat` (the human-readable twin of `data1.bin`, see [formats.md](./formats.md#per-level-worlddat---text-object-placements)) into placements. Each block's `Dof`/`Up`/`Right` basis vectors map onto the same 9-value rotation matrix as a `Placement` (row order `[Dof, Up, Right]`, verified byte-identical to `data1.bin`), so the result drops straight into `transformMesh`/`assembleLevel`. Each entry also carries its keyword: `Name` places an object, `Dele` is a removal directive seen in patch files.

### `formatWorld(entries: Iterable<WorldPlacement>): string`

Serializes placements back into `World.dat` text (CRLF line endings, as the game writes), emitting each entry's `kind` when present (else `Name`) and its rotation as `Dof`/`Up`/`Right`. Round-trips through `parseWorld` losslessly in value, though float formatting may differ from the original editor's bytes.

## Tab maps

The in-game "tab" map is a 512x512 top-down image stored as four 256x256 tiles named `map<mapNumber><0..3>.tga` in a texture archive, paired with a `MAPMTX.DAT` affine that projects world coordinates onto it. This group extracts existing maps and renders new ones from terrain geometry.

### `extractTabMap(archives: Uint8Array[], mapNumber: number): RawImage | null`

Extracts a level's existing tab map: finds the four `map<mapNumber><0..3>.tga` tiles in the given texture archives (searched in order; e.g. the level's `leveltex.bin`, then `textures.dat`/`texsec.dat`), decodes them, and reassembles the full map as the engine shows it. Returns `null` if the complete set is not present.

```ts
import {readFile, writeFile} from 'node:fs/promises'
import {encodePng, extractTabMap} from 'cnetool'

const map = extractTabMap(
  [await readFile('LEVEL1/leveltex.bin'), await readFile('textures.dat')],
  1,
)
if (map) await writeFile('map1.png', encodePng(map))
```

### `renderTabMap(mesh: Mesh, window: TabMapWindow, options?: RenderTabMapOptions): RawImage`

Renders a mesh (typically a level's terrain project) top-down orthographically into a `RawImage`, framing the given window. Each face is either sampled per-pixel from `options.texture` (a face-to-`RawImage` resolver, using the face's UVs with wrapping) or filled with its flat `options.faceColor` (default mid-gray; return `null` from either resolver to skip a face). Where faces overlap, the one nearer the top-down camera wins (CE is -Y-up, so most-negative average Y). `options.resolution` sets the output size (default `TAB_MAP_RESOLUTION`) and `options.background` the uncovered-pixel color (default black). The result is top-down with row 0 = north, matching `tabMapMatrix`.

A full authoring pipeline: `parseMesh` the terrain, `tabMapWindowForMesh` to frame it, `renderTabMap` (with `averageColor`-based or texture-sampling coloring), optionally `grayscaleTabMap` and `frameTabMap` for the shipped look, `sliceTabMapTiles` into tiles, `buildTextureArchive` into a loadable `leveltex.bin`, and `formatMatrix(tabMapMatrix(window))` for the matching `MAPMTX.DAT`.

### `tabMapWindowForMesh(mesh: Mesh, marginFraction?: number): TabMapWindow`

Derives a square world-space window that frames a mesh's horizontal (X/Z) extent, with padding on each side (`marginFraction` of the larger span, default 0.04). Use this to auto-frame a level's terrain.

### `tabMapMatrix(window: TabMapWindow, resolution?: number): MapMatrix`

Builds the `MAPMTX.DAT` affine that maps world `(x, z)` to a tab-map pixel for a window: uniform scale, Z flipped so world +Z (north) points up, centered (the engine convention, confirmed against shipped levels). Pairs with `renderTabMap`: a marker projected through this matrix (via `projectToMap`) lands on the rendered map. Serialize with `formatMatrix`.

### `sliceTabMapTiles(image: RawImage, mapNumber: number): ArchiveInputEntry[]`

Slices a full square, even-sized map image into the engine's four tiles, named `map<mapNumber><0..3>.tga` and laid out row-major (0 = top-left, 1 = top-right, 2 = bottom-left, 3 = bottom-right), each encoded as a 24-bit TGA in the orientation the engine's map renderer expects. Feed the result to `buildTextureArchive` to produce a loadable `leveltex.bin`. `mapNumber` is the value the level's script passes to `REFUseMapNumber`.

### `frameTabMap(content: RawImage, options?: FrameTabMapOptions): RawImage`

Paints a margin and decorative border over the edges of a rendered (square) map, matching the shipped maps' look. The content keeps its size and position, so the matching `MAPMTX` needs no offset. Options: `margin` (per-side pixel widths or one number; the engine crops the bottom of the tab map, so a bottom margin keeps content out of the cropped region), `border` (a frame just inside the margin), `marginColor`/`borderColor` (default black/white), and a subtle graph-paper overlay via `grid` (line spacing in pixels), `gridColor`, and `gridAlpha` (default 0.18).

### `grayscaleTabMap(image: RawImage, options?: GrayscaleTabMapOptions): RawImage`

Desaturates a rendered map and applies a diagonal light gradient (brighter top-left, darker bottom-right), reproducing the shipped maps' lit, heightmap-like look. `options.light` and `options.shadow` set the corner brightness multipliers (defaults 2.0 and 0.7).

### `assembleTabMap(tiles: RawImage[]): RawImage`

Reassembles four decoded tiles into the full map as the engine displays it, the inverse of `sliceTabMapTiles`. Tiles are given in index order 0..3 as decoded from the archive (bottom-origin); each is flipped to the engine's top-origin orientation and placed row-major. All four must be the same square size.

### `TAB_MAP_RESOLUTION`, `TAB_MAP_TILE`

Constants: the full tab-map resolution (`512`) and the side length of a single tile (`256`).

## Scripts: the .scr VM

Object behavior is scripted in compiled `.scr` files: event handlers (`startup`, `Touched`, `SeePlayer`, ...) of stack-machine bytecode that calls the engine's `REF*` builtins. The format and opcode set are documented in [formats.md](./formats.md#scripts-scr) and the whole scripting system (builtins, callbacks, slot tables) in [scripts.md](./scripts.md). This group gives you a full round-trip: parse -> decompile to readable pseudocode -> edit -> compile back to a loadable `.scr`.

### `parseScript(blob: Uint8Array): ParsedScript`

Parses a compiled `.scr` into `{paramBytes, handlers}`: the total variable storage plus each event handler's name, parameter count, and decoded bytecode (`ScriptInstruction[]` with resolved operands). The exact descriptor layout is parsed first (handles multi-handler files precisely, across both known compiler variants); files that do not match fall back to a heuristic bytecode scan, where multi-handler splitting is approximate (`paramCount` may come back `-1`) but single-handler scripts, the common case, are exact.

```ts
import {readFile, writeFile} from 'node:fs/promises'
import {decompileScript, parseScript} from 'cnetool'

const script = parseScript(await readFile('LEVEL1/palm.scr'))
await writeFile('palm.scr.c', decompileScript(script))
```

### `decompileScript(script: ParsedScript): string`

Decompiles a parsed script into readable C-like pseudocode: expressions are reconstructed off the VM stack, each `REF*` call's arguments are grouped by its known arity, synthesized comparisons are folded back (`sub`+`ltz` -> `<`, etc), and jumps become `if`/`else`/`while` (with a `goto`/label fallback for irreducible control flow). Shared globals render as `g0, g1, ...`, handler parameters as `v0, v1, ...` (original names are not in the bytecode), well-known callback parameters get friendly names (`SeePlayer(player)`), `-1` renders as `MYSELF`, and known magic-number arguments are symbolized to their SDK constant names. The output is designed to compile back byte-identically with `compileScript`.

### `disassembleScript(script: ParsedScript): string`

Renders a parsed script as a flat disassembly listing: one line per instruction with resolved jump targets and `REF*` call names. Use this when the decompiler's reconstruction is not what you want to look at.

### `selfDestructsAtSpawn(script: ParsedScript): boolean`

Whether a script destroys its own object the instant it spawns: its `startup` handler calls `REFSetTTL(MYSELF, 0)` or `REFDestroy(MYSELF)`. Such objects are placed in a level's `data1.bin`/`World.dat` but never appear in-game (e.g. No Man's Land's cacti), so a faithful level export should skip them.

### `compileScript(src: string): Uint8Array`

Compiles `.scr` C-subset source to a complete, loadable `.scr` file (header + per-handler descriptors + bytecode). The instruction stream is byte-identical to the original `CPARSE.EXE` compiler's output, and the files load and run in the real engine. The language is small: `float`-only values, string literals as `REF*` arguments, handler functions with parameters, `if`/`else`/`while`/`return`, the operators `+ - * / %`, `< > == !=`, and unary `- !`. There is no `<= >= && ||` (the original compiler rejects them too). Module-level `float g;` declarations are persistent globals shared across handlers; function-body locals do not exist and are a compile error (initializers on globals are accepted but dropped, matching CPARSE's zero-init). Named SDK constants (`MYSELF`, `ON`, `PATROL`, ...) resolve to their numbers. Handler names may be up to 27 characters (longer throws) - a stricter limit than the engine, which reads names up to 31, while the game's original `CPARSE.EXE` compiler corrupts names longer than 7 (see [formats.md](./formats.md) and [scripts.md](./scripts.md)).

```ts
import {writeFile} from 'node:fs/promises'
import {compileScript} from 'cnetool'

const src = `
startup() {
  REFSetTTL(MYSELF, 60);
}
Touched(other, velX, velY, velZ) {
  REFExplode(MYSELF);
}
`
await writeFile('LEVEL1/mything.scr', compileScript(src))
```

### `compileSource(src: string): CompiledHandler[]`

Compiles source to per-handler instruction streams without the file wrapper: each `CompiledHandler` carries its name, parameters, slot assignments, `varBytes`, and `CompiledInstruction[]` with jump targets resolved to instruction indices. Useful for testing or inspecting codegen; `compileScript` is this plus the on-disk header/descriptors.

### `tokenize(src: string): Token[]`

Tokenizes `.scr` source into the token stream `parse` consumes (numbers, identifiers, strings, punctuators; `//` and `/* */` comments skipped). Throws on an unexpected character. The `Token` type itself is internal; treat the result as opaque input to `parse`.

### `parse(tokens: ReturnType<typeof tokenize>): Program`

Parses a token stream into a `Program`: module-level global names (in declaration order) and handler functions as an AST. Exposed for tooling that wants the AST without codegen; most callers just use `compileScript`/`compileSource`.

## Controllables and animation

Vehicles and turrets ("controllables") are placed under logical project names whose `objects.dat` entry is an empty stub; the engine assembles the real multi-part body at runtime. These exports encode the reverse-engineered part layouts so static exports can render them, plus the `.anm` vertex-animation format some parts use (see [formats.md](./formats.md#vertex-animations-anmanm)).

### `controllableGeometry: ControllableGeometryMap`

The built-in map from a controllable's logical name (`tank`, `car`, `plane2`, `helicopter`, ...) to the parts that make up its visible geometry, with body-local part offsets recovered from the engine's vehicle setup code. Each part is either a plain project-name string (drawn once at the placement transform) or `{project, at, yaw?}` (a copy at each body-local offset, optionally yawed). Keys match case-insensitively against a placement's base name. Several bodies live in the multiplayer patches' `OBJECTS2.DAT`; pass it via `assembleLevel`'s `extraObjects` so they resolve. The map is a plain object, so you can override entries: `{...controllableGeometry, tank: ['STBody']}`.

### `assemblyGeometry: ControllableGeometryMap`

The same idea for non-controllable multi-part scenery ("assemblies"): placements like the staff car (`mercedes`), the flak bunkers (`bunkers`/`bunkerl`), and the passenger airship (`zeppelinp`), whose stub projects the engine likewise replaces with a body plus offset parts. Same shape as `controllableGeometry`; merge it into `assembleLevel`'s `controllable` option if you want these rendered too.

### `controllableSkins: Record<string, TextureSkin>`

Alt-skin texture swaps per vehicle variant (`car2`, `plane3`, `plane4`): some vehicles are one mesh with two skins picked by the placement name, applied in-engine as a face-texture rename (`Carnew` -> `Carnew2`). Pass the matching entry as the `skin` argument to `createTextureResolver` so an export shows the variant's skin.

### `restPoses: Record<string, {anm: string, frame: number}>`

Projects the engine draws via a `.anm` vertex animation rather than their static mesh, mapped to the animation file and the frame that is their rest pose. The stored mesh (= frame 0) is in an animated extreme; e.g. `motobody`'s fork is baked steered, and `MC.ANM` frame 4 is straight. Use with `parseAnm` + `applyAnmFrame`, or via `assembleLevel`'s `restFrames` option.

### `parseAnm(bytes: Uint8Array): ParsedAnm`

Parses a `.anm` vertex animation: `{frameCount, vertexCount, frames, transforms}`, where `frames[f]` holds the frame's vertex positions (parallel to the project mesh's vertices; frame 0 equals the base mesh) and `transforms[f]` is the frame's trailer transform for an attached sub-part (position, row-major 3x3 rotation, translation), or `null` when a frame has no trailer. Throws on an inconsistent header/stride.

```ts
import {readFile} from 'node:fs/promises'
import {applyAnmFrame, parseAnm, restPoses} from 'cnetool'

const anm = parseAnm(await readFile(`ANM/${restPoses.motobody.anm}`))
const restedBike = applyAnmFrame(motobodyMesh, anm.frames[restPoses.motobody.frame])
```

### `applyAnmFrame(mesh: Mesh, frame: Vector3[]): Mesh`

Returns a copy of the mesh with its vertices replaced by the frame's positions (faces kept). The frame must have the same vertex count as the mesh; throws otherwise.

## Text configs and stat tables

Several game files are `Key:Value` text (`MOBJS.DAT`, `KEYCONF.DAT`, ...) and two, `data3.bin`/`data4.bin`, are byte-obfuscated stat tables the engine reads as text in fixed-size chunks. See [formats.md](./formats.md#text-config-family-keyvalue) and [formats.md](./formats.md#data3bin-data4bin---obfuscated-stat-tables).

### `parseConfig(input: string | Uint8Array, options?: ParseConfigOptions): ConfigEntry[]`

Parses a `Key:Value` text config. Each line is split on its first `:` into a trimmed key and value; blank lines, `//` comments, and colon-less lines are skipped. Order and duplicate keys are preserved (several files repeat keys), so use `groupRecords` to split them into records. With `{scan: true}`, pairs are instead matched anywhere in the input via a `bareword:printable` pattern, ignoring line structure: use this on deobfuscated stat tables where text is interleaved with binary. Line mode does not join multi-line quoted values; the localization files need `parseDialogue`/`parseBriefing`.

### `formatConfig(entries: Iterable<ConfigEntry>): string`

Serializes config entries back to text, one `Key:Value` line per entry, CRLF-terminated as the game's files are. The inverse of `parseConfig` (line mode).

### `groupRecords<T extends ConfigEntry>(entries: T[], startKey: string): T[][]`

Splits flat config entries into records, starting a new record at each entry whose key equals `startKey` (case-insensitive). Entries before the first `startKey` are dropped. For example, `groupRecords(parseConfig(mobjs), 'Name')` yields one record per object.

### `deobfuscate(data: Uint8Array): Uint8Array`

Reverses the byte obfuscation used by `data3.bin`/`data4.bin` (subtracts a constant key from every byte), returning the plain content: text records interleaved with binary filler.

### `obfuscate(data: Uint8Array): Uint8Array`

The inverse of `deobfuscate`: re-obfuscates plain bytes for writing back.

### `parseStatTable(data: Uint8Array): StatField[]`

Parses an obfuscated fixed-chunk stat table (`data4.bin` weapon stats, `mdata4.bin`, `data3.bin`). The engine stores each field as its own 127-byte chunk (`STAT_CHUNK_SIZE`): an obfuscated `Key:Value` line followed by ignored filler. Returns one `StatField` per chunk in file order, each carrying its `chunk` index so a value can be written back. Use `groupRecords(fields, 'Name')` to split the weapon table into one record per weapon; a weapon's class index equals its position in that grouped list.

```ts
import {readFile, writeFile} from 'node:fs/promises'
import {parseStatTable, setStatValue} from 'cnetool'

const data4 = await readFile('data4.bin')
const damage = parseStatTable(data4).find((f) => f.key === 'Damage')! // first weapon's Damage
await writeFile('data4.bin', setStatValue(data4, damage.chunk, '50'))
```

### `setStatField(data: Uint8Array, chunk: number, key: string, value: string): Uint8Array`

Returns a copy of the obfuscated table with one chunk's leading line rewritten to `key:value`. Only that line is overwritten; the chunk's trailing filler and every other chunk are preserved byte-for-byte, so the change is a minimal diff. Throws a `RangeError` if the chunk index is out of range or the line does not fit in a chunk.

### `setStatValue(data: Uint8Array, chunk: number, value: string): Uint8Array`

Like `setStatField` but keeps the chunk's existing key, replacing only its value: the convenient way to retune a stat. Throws a `RangeError` if the chunk does not hold a `Key:Value` line.

### `formatStatTable(fields: Iterable<ConfigEntry>): Uint8Array`

Rebuilds a whole obfuscated stat table from fields, one chunk each (`Key:Value` line + zero filler), in the given order. A functional rebuild, not byte-identical to shipped files (those carry non-zero filler the engine ignores); for an in-place change that preserves the rest of the file exactly, use `setStatValue`.

### `STAT_CHUNK_SIZE`

Constant `0x7f` (127): the size of one field chunk in the stat tables. A valid table's length is a multiple of this.

## Localization

The dialogue and briefing files hold the game's localized text (see [formats.md](./formats.md#localization-files)).

### `parseDialogue(input: string | Uint8Array): DialogueFile`

Parses a dialogue file (`DIALOGUE.DAT`): a `Languages:N` header followed by records, each a `Filename:<id>` line (the id matches a sound file) and one `<Language>:"…"` line per language. Translation values may span multiple lines; a value runs until the next `Key:` field line, which makes the parser resilient to the source's occasional missing closing quotes. Returns `{languageCount, entries}` with per-entry `{filename, translations}`.

```ts
import {readFile} from 'node:fs/promises'
import {parseDialogue} from 'cnetool'

const dialogue = parseDialogue(await readFile('DIALOGUE.DAT'))
for (const entry of dialogue.entries) {
  console.log(entry.filename, entry.translations.find((t) => t.language === 'Eng')?.text)
}
```

### `parseBriefing(input: string | Uint8Array): BriefingSection[]`

Parses a briefing file (`MISSION.DAT`, `ENDBRF.DAT`): free-form localized text split into sections by `//<language>:----` delimiter lines. Each section's body is kept verbatim apart from trimmed surrounding blank lines.

## Level metadata and misc binary

Small per-level binary files, and the level's ambient configuration recovered from its main script. Formats are in [formats.md](./formats.md#binary-files).

### `getLevelInfo(mainscr: ParsedScript): LevelInfo`

Resolves a level's ambient configuration (terrain, water, lighting, sky, weather, ground sounds) from its parsed `mainscr.scr`. A level's `startup` handler issues a run of `REF*` setup calls with constant arguments; this evaluates them (folding simple literal arithmetic) and maps the well-understood ones to typed fields, while `info.calls` keeps every call in order with its literal arguments so any other setting is still reachable.

```ts
import {readFile} from 'node:fs/promises'
import {getLevelInfo, parseScript} from 'cnetool'

const info = getLevelInfo(parseScript(await readFile('LEVEL1/MAINSCR.SCR')))
console.log(info.landscape?.name, info.light.color, info.weather?.type)
```

### `parseMatrix(data: Uint8Array): MapMatrix`

Parses `MAPMTX.DAT`: a 3x3 affine matrix of 9 row-major little-endian float32 values that maps world coordinates to minimap pixels. Throws if the data is too short.

### `formatMatrix(matrix: MapMatrix): Uint8Array`

Serializes a `MapMatrix` back to `MAPMTX.DAT` bytes, the inverse of `parseMatrix` (missing values default to 0). Round-trips losslessly.

### `projectToMap(matrix: MapMatrix, a: number, b: number): {x: number, y: number}`

Applies a `MapMatrix` to a pair of horizontal-plane world coordinates, returning the minimap pixel position (the vertical/altitude axis is not part of the projection). Use it to place markers on a tab map.

### `parseLights(data: Uint8Array): LightSource[]`

Parses `LIGHTS.DAT`: a header-less array of 23-byte light records (`f32 range`, `u32 id`, RGB bytes, `3 x f32` position, packed unaligned). An empty file yields an empty array; a length that is not a multiple of 23 throws.

### `formatLights(lights: Iterable<LightSource>): Uint8Array`

Serializes light sources back to `LIGHTS.DAT` bytes, the inverse of `parseLights`. Round-trips losslessly.

### `parseServerInfo(data: Uint8Array): ServerInfo`

Parses `servinfo.dat`: the host's persisted multiplayer match settings, four little-endian uint32 fields (`fragLimit`, `scoreLimit`, `timeLimit` in minutes, `nextMap` level number). Throws if the data is shorter than 16 bytes.

### `formatServerInfo(info: ServerInfo): Uint8Array`

Serializes a `ServerInfo` back to `servinfo.dat` bytes (16 bytes), the inverse of `parseServerInfo`. Round-trips losslessly.

### `parseLevelIndex(input: string | Uint8Array): LevelIndexEntry[]`

Parses `LEVELS.NFO`: the level index, one `Name:<display name> Val:<number>` line per level, into `{name, number}` records (name → `LEVEL<n>/` folder number). Order and duplicates are preserved; blank and malformed lines are skipped. This handles the two-keys-per-line shape that the generic `parseConfig` does not. The `nextMap` field of `parseServerInfo` refers to these numbers.

### `formatLevelIndex(entries: Iterable<LevelIndexEntry>): string`

Serializes a level index back to `LEVELS.NFO` text, one CRLF-terminated `Name:<name> Val:<number>` line per entry. The inverse of `parseLevelIndex`.

## Server discovery and queries

Read the community master list, discover LAN hosts, and query a server's live status over the GameSpy protocol. Unlike the rest of the API these do network I/O and are **Node-only** (UDP via `node:dgram`, HTTP via `fetch`). The wire protocols are documented in [network.md](./network.md); the corresponding CLI is `cnetool server`.

```ts
import {findServers, queryServer, fetchIpList} from 'cnetool'

const servers = await findServers() // master list + LAN, resolved to live status
const one = await queryServer('89.38.98.12') // includes the player roster
```

### `parseIpList(text: string): string[]`

Parses an `IPLIST.TXT`-format list (the game's own file and the community master list share it): one address per line, `#`-comment and blank lines skipped, whitespace and CRLF tolerated. Deduplicates, preserves order, and returns addresses as-is (no liveness check).

### `fetchIpList(url?: string, options?: FetchIpListOptions): Promise<string[]>`

Fetches a master list over HTTPS (default `https://ceservers.net/iplist.txt`) and runs it through `parseIpList`. The community list is best-effort: only servers patched to announce to ceservers.net (or running 1.50+) appear. `FetchIpListOptions` carries an `AbortSignal`.

### `queryServer(ip: string, port?: number, options?: QueryServerOptions): Promise<GameServer | GameServerStatus>`

Queries a server's GameSpy `\status\` (and, unless `includePlayers` is `false`, `\players\`) on its query port (default `4711`), reassembling the multi-packet reply, and returns the parsed status with a measured `ping`. Overloaded on `includePlayers`: the default returns a `GameServer` (with `players`); `{includePlayers: false}` sends only `\status\` and returns a `GameServerStatus` (no `players` field). `QueryServerOptions` also carries `timeout` (ms, default 5000) and an `AbortSignal`.

### `discoverLanServers(options?: DiscoverLanOptions): Promise<LanServer[]>`

Listens for CE `'D'` LAN beacons and returns the hosts that announced themselves, deduplicated by source IP. Push-based: it only listens (no probe sent). `DiscoverLanOptions`: `timeout` (listen window ms, default 1500), `port` (bind port, default `210` — privileged on Unix; override only behind a relay or in tests), and an `AbortSignal`.

### `parseBeacon(datagram: Uint8Array): LanBeacon | null`

Parses one 24-byte `'D'` beacon into `{name, numPlayers, maxPlayers}`, or `null` if it is not a beacon. See the corrected offset table in [network.md §3](./network.md#lan-beacon-d--210-confirmed---live-capture).

### `findServers(options?: FindServersOptions): Promise<GameServerStatus[]>`

The high-level browser: fetches the master list and (unless `lan` is `false`) scans the LAN, merges and deduplicates the two, then queries each host's `\status\` concurrently (counts only, no roster). Mirrors the in-game browser — internet hosts appear only if they answer, LAN hosts fall back to their beacon, and a list-fetch failure yields no internet rows rather than rejecting. `FindServersOptions`: `lan`, `url`, `lanTimeout`, `queryTimeout`, and an `AbortSignal`.

## Exported types

All types are exported from the package root (`import type {...} from 'cnetool'`).

### Core primitives

- `RawImage`: decoded raw pixels, top-down and row-major, with `width`, `height`, `channels` (3 = RGB, 4 = RGBA), and `data`.
- `RgbColor`: an RGB color, each channel 0-255.
- `Vector3`: a 3D position (`x`, `y`, `z`) in world coordinates.

### Archives

- `ParsedArchive`: a parsed table of contents, `{declaredCount, entries}`.
- `ArchiveEntry`: one TOC entry, `{name, dataOffset, blobLength}`, without payload interpretation.
- `ArchiveInputEntry`: one entry to write into an archive, `{name, data}`.
- `TextureInfo`: a texture entry's image geometry (`width`, `height`, `depth`, `descriptor`).
- `ExtractedEntry` / `ExtractedKind`: an `extractEntries` result (rebuilt `'tga'` or `'raw'` blob) and its kind tag.

### Images

- `TgaToPngOptions`: `tgaToPng` options (`colorKey`, `topOrigin`).
- `PngToTgaOptions`: `pngToTga` options (`topDown`).

### Meshes and 3D export

- `Mesh`: a parsed 3D model, `{vertices, faces}`.
- `MeshFace`: one polygon face: vertex indices, `color`, `alpha` (0-255), the raw render `flags` byte, `texId` (or `null` if untextured), and per-face-vertex `uv`.
- `MeshLod`: which LOD layer to pick: `'high' | 'medium' | 'low'` or a 0-based index.
- `ParseMeshOptions`: `parseMesh` options (`lod`).
- `SerializeMeshOptions`: `serializeMesh` options (`lods`, `detect`).
- `ObjUp`: target up-axis for export/import: `'y'` (upright, default), `'z'` (Blender/Unreal), `'raw'` (as stored, -Y-up).
- `MeshToObjOptions` / `MeshesToObjOptions` / `MeshesToObjItem`: OBJ export options (name, `mtllib`, per-face `material` resolver, `up`) and the named-mesh item for multi-mesh export.
- `ObjToMeshOptions`: OBJ import options (`up`, `material` name-to-texId mapper, companion `mtl` text).
- `MtlMaterial`: one `buildMtl` material (`name`, `map`, `mask`, `color`, `alpha`).
- `GltfMeshInput` / `GltfMaterialInput` / `GltfOptions` / `GltfFiles`: glTF export inputs (named mesh + `materialFor` resolver; material with PNG `texture`, `baseColor`, `alphaMode`), options (`up`, `materials`, `bufferName`), and the text-form output files (`json`, `bin`, `images`).
- `ResolvedTexture` / `TextureSkin`: a `createTextureResolver` result (`material`, `entry`, source `textures` archive) and an alt-skin base-name swap map.

### Levels and placements

- `Placement`: a placed object instance: `name`, `position`, and the 9-value `rotation` matrix.
- `WorldEntry` / `WorldPlacement`: a `World.dat` placement (a `Placement` plus its `kind`: `'Name'` or `'Dele'`); `WorldPlacement` is the loosely-tagged form `formatWorld` accepts.
- `SerializePlacementsOptions`: `serializePlacements` options (`marker`).
- `AssembleLevelOptions` / `LevelScene` / `LevelSceneItem`: `assembleLevel`'s options, its `{items, missing}` result, and one named world-placed mesh (with its `source` archive index).
- `ControllableGeometryMap`: maps a controllable's logical name to its part list (a part is a project-name string or `{project, at, yaw?}` with body-local offsets).
- `LevelInfo` / `LevelCall`: a level's resolved ambient configuration (landscape, water, light, backColor, planet, weather, groundSounds, plus all raw `calls`) and one recovered `REF*` call with literal args.

### Scripts

- `ParsedScript`: a parsed `.scr`: `paramBytes` (total variable storage) and `handlers`.
- `ScriptHandler`: one event handler: `name`, `paramCount` (`-1` when unrecoverable), and decoded `code`.
- `ScriptInstruction`: one decoded bytecode instruction: `offset`, `index`, `opcode`, `mnemonic`, and decoded `arg`.
- `Program`: the compiler's parsed AST: global names and handler functions.
- `CompiledHandler` / `CompiledInstruction`: a compiled handler (name, params, slot assignments, `varBytes`, code) and one emitted instruction.

### Animation

- `ParsedAnm`: a decoded `.anm`: `frameCount`, `vertexCount`, per-frame vertex `frames`, and per-frame trailer `transforms`.
- `AnmTransform`: a frame's rigid transform for an attached sub-part (`position`, row-major 3x3 `rotation`, `translation`).

### Configs and localization

- `ConfigEntry`: a single `Key:Value` pair.
- `ParseConfigOptions`: `parseConfig` options (`scan`).
- `LevelIndexEntry`: one `LEVELS.NFO` line: a level's display `name` and its `number`.
- `StatField`: a stat-table field: a `ConfigEntry` plus its `chunk` index for writing back.
- `DialogueFile` / `DialogueEntry` / `Translation`: a parsed `DIALOGUE.DAT`, one dialogue line with its translations, and one localized string.
- `BriefingSection`: one language's block of a briefing file.

### Misc binary

- `MapMatrix`: the `MAPMTX.DAT` 3x3 affine (9 row-major `values`).
- `LightSource`: one `LIGHTS.DAT` record: `id`, `range`, `color`, `position`.
- `ServerInfo`: the `servinfo.dat` host match settings: `fragLimit`, `scoreLimit`, `timeLimit` (minutes), `nextMap`.

### Server discovery

- `GameServerStatus`: a server's status from a `\status\` query (or beacon fallback): `ip`, `queryPort`, `gamePort`, `name`, `version`, `map`, `gameType`, `numPlayers`, `maxPlayers`, `timeLimit`, `fragLimit`, `scoreLimit`, `teamplay`, optional `ping`, and `source` (`'internet'` | `'lan'`).
- `GameServer`: a `GameServerStatus` plus the connected-player `players` roster.
- `GamePlayer`: one player row: `nickname`, `frags`, `deaths`, `skill`, `ping`, `team`.
- `LanBeacon`: a parsed `'D'` LAN beacon: `name`, `numPlayers`, `maxPlayers`.
- `LanServer`: a discovered LAN host: `ip` plus its `beacon`.

### Tab maps

- `TabMapWindow`: a square world-space region framed by the tab map (`centerX`, `centerZ`, `size`).
- `RenderTabMapOptions`: `renderTabMap` options (`resolution`, `background`, `faceColor`, `texture`).
- `FrameTabMapOptions` / `TabMapMargin`: `frameTabMap` options and its per-side pixel margin form.
- `GrayscaleTabMapOptions`: `grayscaleTabMap` options (`light`, `shadow`).
