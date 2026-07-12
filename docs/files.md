# File inventory

What the files in a Codename Eagle install are, grouped by kind. Obvious files (icons, readmes, installer, the executable's runtime DLLs) are omitted. "cetool" marks formats this library can read.

Counts are from one full install (~2,300 files). The **cetool** column marks library support: ✅ = cetool has an API/CLI for it, ⚠️ = partially handled, ❌ = no library support yet. A ❌ format may still be fully documented - the "(decoded)" notes mean the byte format is understood - see [`formats.md`](./formats.md) for the specs.

## Top-level layout

```
<root>          global archives, config, the executable
  24bits/       texture archive
  MENU/         menu graphics archive
  GLOBAL/       shared scripts + models used by every level
  ANM/          animation files
  SOUNDS/       all in-game audio (FX, dialogue, character voices, briefings)
  LEVEL<n>/     one folder per level (campaign 1-12, bonus 128-132)
  CUTSCN/       Smacker cutscene videos (shipped on the disc)
```

## Packed archives

| File                  | Format                    | Purpose                                                                | cetool |
| --------------------- | ------------------------- | ---------------------------------------------------------------------- | ------ |
| `24bits/textures.dat` | TOC + truncated-TGA blobs | All world/UI textures (1557)                                           | ✅     |
| `MENU/menupics.dat`   | same container            | Menu graphics (308)                                                    | ✅     |
| `objects.dat`         | same container            | The "project" model library (473) - mesh format decoded (read + write) | ✅     |

All three share one container: a `uint32` count, fixed 17-byte name+offset records, then the data blobs.

## Audio (`.wav`, `.wac`)

All **in-game** audio is **16 kHz, mono, 16-bit PCM** WAV, under `SOUNDS/`:

| Dir                                               | Count | Purpose                                          |
| ------------------------------------------------- | ----- | ------------------------------------------------ |
| `SOUNDS/FX`                                       | 427   | Sound effects                                    |
| `SOUNDS/DIALOGUE`                                 | 251   | Spoken dialogue (filenames = `DIALOGUE.DAT` ids) |
| `SOUNDS/CHARFX/{RED,GUARD,GOGGLES,OFFICER,CIVIL}` | ~63   | Character voices                                 |
| `SOUNDS/brf`                                      | 26    | Briefing audio (ids → per-level dialogue)        |

`.wac` files are ordinary RIFF/WAVE audio with a non-standard extension. The **music soundtrack** is _not_ files - it's CD-audio (disc tracks 2-14, 44.1 kHz stereo); see [`formats.md`](./formats.md#soundtrack---redbook-cd-audio).

## Video (`.smk`)

`CUTSCN/*.SMK` - RAD **Smacker** video (intro, credits, per-mission cutscenes). Standard format; playable in VLC, extractable with `ffmpeg`/RAD tools.

## Scripts (`.scr`, `.csr`)

Compiled bytecode for the engine's "REF" script VM (see [`formats.md`](./formats.md#scripts-scr)). 419 `.scr` in the install examined (138 shared in `GLOBAL/`, rest per-level; a fully patched install has 869) + a couple of `.csr` (same format; multiplayer flag scripts). `mainscr.scr` is a level's master script; `RED.SCR` is the player script.

## Models & animation

| File             | Format        | Purpose                                                                  | cetool |
| ---------------- | ------------- | ------------------------------------------------------------------------ | ------ |
| `objects.dat`    | "projects"    | 3D models + terrain (vertices/faces/materials/UVs, 3 LODs + detect hull) | ✅     |
| `ANM/*.anm` (96) | vertex frames | Per-vertex keyframe animation (format + runtime decoded)                 | ✅     |

## Per-level files (`LEVEL<n>/`)

Each level folder bundles:

| File(s)                                  | Kind   | Purpose                                              | cetool |
| ---------------------------------------- | ------ | ---------------------------------------------------- | ------ |
| `MOBJS.DAT`                              | text   | Object instance manifest (`Name:`/`Type:`)           | ✅     |
| `MISSION.DAT`, `BRIEF.DAT`, `ENDBRF.DAT` | text   | Briefing/mission text (localized)                    | ✅     |
| `DIALOGUE.DAT`                           | text   | Level dialogue (localized)                           | ✅     |
| `MAPMTX.DAT`                             | binary | World→minimap matrix                                 | ✅     |
| `LIGHTS.DAT`                             | binary | Light sources (often empty)                          | ✅     |
| `LOADING.DAT`                            | binary | Loading-screen image id (`uint32`)                   | ✅     |
| `HiScores.dat`                           | text   | Per-level high scores (bare values, not `Key:Value`) | ❌     |
| `MATS.DAT`                               | text   | Camera/node transforms (some levels)                 | ✅     |
| `data1.bin`                              | binary | Object placements (name + position + 3×3 rotation)   | ✅     |
| `data2.bin`                              | binary | AI entities + patrol routes (decoded)                | ❌     |
| `<name>.<n>` (eg `plane2.1`)             | script | Per-instance `.scr` scripts                          | ✅     |
| `AIMap`, `AIMap.raw`, `AIMap_8bit.raw`   | raw    | AI navigation grid (2048×2048 walkable mask)         | ❌     |
| `*.scr`                                  | script | Per-level object & master scripts                    | ✅     |
| `*cache.bin`                             | binary | Generated preload/index caches (not authored)        | -      |
| `GAME*.SAV`                              | binary | Dev-leftover level-state checkpoints (decoded)       | ❌     |

The 3D **terrain/world geometry** for a level lives in `objects.dat` as a "project" named `land<n>` / `level<n>` (see [`formats.md`](./formats.md)); its mesh format (vertices/faces/materials/UVs) is now fully decoded. The `AIMap*` rasters here are AI navigation only (2048×2048 walkable/blocked mask + nav data).

## Global config & data (root)

| File           | Kind            | Purpose                                           | cetool               |
| -------------- | --------------- | ------------------------------------------------- | -------------------- |
| `LEVELS.NFO`   | text            | Level name ↔ id index                             | ✅ `parseConfig`     |
| `DIALOGUE.DAT` | text            | Master dialogue table                             | ✅                   |
| `KEYCONF.DAT`  | text            | Input bindings                                    | ✅                   |
| `KEYDEFS.DAT`  | text            | Key name → scancode table                         | ⚠️ (columns)         |
| `data3.bin`    | obfuscated text | Unit/enemy stat table (56)                        | ✅ `stattable` (r/w) |
| `data4.bin`    | obfuscated text | Weapon stat table (14)                            | ✅ `stattable` (r/w) |
| `diacache.dat` | binary          | Dialogue WAV-length cache (generated)             | ❌                   |
| `menuinfo.dat` | binary          | Profile/options/progress (zlib + cipher, decoded) | ❌                   |

## Executable / runtime (not assets)

`Game.exe` (no-CD: decrypted standalone; retail: SafeDisc loader) + `GAME.ICD` (encrypted real exe on retail), plus `*.DLL` (`MENUDLL`, `SMACKW32`, DirectX helpers) and `LOBBY.EXE`/`IPLIST.EXE` (multiplayer). Documented for context only.
