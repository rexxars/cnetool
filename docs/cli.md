# CLI reference

The `cnetool` command line interface is a thin shell around the [API](./api.md): each subcommand reads files with `node:fs`, calls the matching API function, and writes the result back out.

```bash
npm install --save cnetool

# Or, without installing it as a dependency:
npx cnetool extract textures.dat
```

## Contents

- [`cnetool init`](#cnetool-init-game-dir-project-dir)
- [`cnetool build`](#cnetool-build-project-dir)
- [`cnetool extract`](#cnetool-extract-archive)
- [`cnetool mesh`](#cnetool-mesh-objectsdat-name)
- [`cnetool object`](#cnetool-object-objectsdat-name)
- [`cnetool level`](#cnetool-level-leveldir-objectsdat)
- [`cnetool tabmap`](#cnetool-tabmap-leveldir-objectsdat)
- [`cnetool world`](#cnetool-world-data1bin--worlddat-output)
- [`cnetool convert`](#cnetool-convert-file-output)
- [`cnetool servinfo`](#cnetool-servinfo-servinfodat-options)
- [`cnetool menuinfo`](#cnetool-menuinfo-menuinfodat-options)
- [`cnetool stattable`](#cnetool-stattable-file-options)
- [`cnetool server`](#cnetool-server-listquery)

### `cnetool init <game-dir> [project-dir]`

Extract a whole Codename Eagle install into an editable **project source tree**: texture archives become PNGs, stat tables and settings blobs become JSON, object archives explode into per-model OBJ directories, and everything else is copied through - all under `<project-dir>/source/`. A `cnetool.json` manifest records the game path so `cnetool build` can re-encode a loadable install.

```bash
cnetool init /path/to/game            # into the current directory
cnetool init /path/to/game my-mod     # into a new project directory
```

`project-dir` defaults to the current directory and must be empty or a fresh path.

The project source tree - layout, the `cnetool.json` manifest, and what round-trips faithfully - is documented in [`docs/project.md`](./project.md).

### `cnetool build [project-dir]`

Re-encode a project's `source/` tree into a complete, loadable game install under `output/` - the inverse of `init`. Texture directories repack into archives, stat/settings JSON re-serialize to binary, config texts re-encode, object directories repack, and sounds/animations/raw files are copied through. Formats without an encoder are carried as verbatim passthrough, so the rebuilt install is always complete.

```bash
cnetool build                     # build the project containing the current dir
cnetool build my-mod --no-cache   # build a specific project, ignoring the cache
```

`project-dir` defaults to the nearest ancestor directory containing a `cnetool.json`. Pass `--no-cache` to re-copy every passthrough file (the build cache otherwise skips unchanged ones).

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

Extraction is a faithful raw unpack: the game makes a 24-bit texture's black see-through at draw time (a per-draw color key, not part of the texture), so extracted images keep their black pixels. The model export commands below apply the key per face, matching the engine.

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

### `cnetool menuinfo <menuinfo.dat> [options]`

Read or edit the persisted menu profile/options in `menuinfo.dat` (the encrypted, zlib-compressed profile file: player/host name, team, game mode, network, resolution, renderer, language, audio, ...). With no write options, the current settings are printed. Passing any write option edits the file in place (unspecified fields are preserved); use `-o` to write elsewhere. The file must already exist. Enum options accept a name or a raw number.

```bash
cnetool menuinfo menuinfo.dat                                   # show current settings
cnetool menuinfo menuinfo.dat --name Ace --team red             # edit in place
cnetool menuinfo menuinfo.dat --renderer direct3d --width 1024 --height 768
```

| Option                                                   | Description                                                 |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| `--name <s>`                                             | Player name (<= 19 chars; the host truncates to 10 online). |
| `--host <s>`                                             | Host/server name (<= 39 chars).                             |
| `--server-ip <a.b.c.d>`                                  | Last-connected server IP (what "4711 4" reconnects to).     |
| `--netproto <tcp\|ipx>`                                  | Network protocol.                                           |
| `--team <red\|blue\|auto>`                               | Team (auto is normalised to a concrete team on host).       |
| `--mode <deathmatch\|ctf\|teamplay>`                     | Game mode.                                                  |
| `--maxplayers <n>`                                       | Max players for a hosted game.                              |
| `--renderer <3dfx\|direct3d\|software>`                  | Renderer.                                                   |
| `--width <n>` / `--height <n>` / `--depth <n>`           | Display mode.                                               |
| `--detail <low\|medium\|max>`                            | Geometry/detail level.                                      |
| `--gfx <none\|medium\|max>`                              | Graphic FX level.                                           |
| `--sound <0-255>` / `--music <0-255>`                    | Volumes.                                                    |
| `--channels <4\|8\|16>`                                  | Sound channels.                                             |
| `--language <english\|spanish\|italian\|french\|german>` | Menu/subtitle language.                                     |
| `--subtitles <on\|off>`                                  | In-game subtitles.                                          |
| `-o, --output <file>`                                    | Write here instead of editing the input in place.           |
| `-h, --help`                                             | Show help.                                                  |

### `cnetool stattable <file> [options]`

Dump an obfuscated stat table - `data3.bin` / `data4.bin` and their `mdata*` multiplayer variants - as a readable table or JSON. Fields are grouped into records by their `Name` field; any header chunks before the first `Name` are dropped.

```bash
cnetool stattable data4.bin              # aligned text table
cnetool stattable data4.bin --json       # array of record objects
```

| Option       | Description                                                |
| ------------ | ---------------------------------------------------------- |
| `--json`     | Emit JSON (an array of record objects) instead of a table. |
| `-h, --help` | Show help.                                                 |

### `cnetool server <list|query>`

Discover and query live Codename Eagle multiplayer servers over the network. `server list` fetches the community master list (`https://ceservers.net/iplist.txt`) and, by default, also scans the LAN for beaconing hosts, then queries each for its live status; `server query <ip[:port]>` reports one server's status and player roster. The list is community-run and best-effort — only servers patched to announce to ceservers.net (or running 1.50+) appear in it.

```bash
cnetool server list                        # master list + LAN, live status table
cnetool server list --no-lan               # internet servers only
cnetool server list --raw                  # just the addresses, no querying
cnetool server query 89.38.98.12           # one server, with players
cnetool server query 89.38.98.12:4711 --json
```

| Option (`list`)      | Description                                            |
| -------------------- | ------------------------------------------------------ |
| `--no-lan`           | Skip the LAN beacon scan (internet servers only).      |
| `--url <url>`        | Master list URL to fetch (default the community list). |
| `--lan-timeout <ms>` | LAN beacon listen window (default 1500).               |
| `--timeout <ms>`     | Per-server query timeout (default 5000).               |
| `--raw`              | Print the raw address list only (no querying, fast).   |
| `--json`             | Emit the parsed servers as JSON.                       |

Scanning the LAN binds the privileged UDP port 210, so `server list` may need elevated privileges (or `--no-lan`) on Unix. `server query` takes `--no-players`, `--timeout <ms>`, and `--json`.
