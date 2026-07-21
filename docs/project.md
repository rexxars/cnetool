# Project source tree

`cnetool init` and `cnetool build` turn a Codename Eagle install into an editable **project** and back. `init` extracts a game directory into a human-editable `source/` tree; you edit it (in a text editor, an image editor, Blender, …); `build` re-encodes it into a complete, loadable install under `output/`. A future `deploy` step will copy the changed output files into a game directory.

The guarantee: **build always produces a complete, loadable install.** Every file in the install is accounted for. Formats cnetool can decode become editable assets (PNGs, JSON, OBJ, text); formats it can't yet encode are carried verbatim as passthrough, so nothing is dropped and the rebuilt install still boots.

## Commands

### `cnetool init <game-dir> [project-dir]`

Extract a Codename Eagle install into a new project source tree.

```bash
# Initialize a project in the current directory from a game install
cnetool init /path/to/game

# Initialize into a new directory
cnetool init /path/to/game my-mod
```

`project-dir` defaults to the current directory. It must be empty or a fresh path - `init` refuses to scatter a source tree into an unrelated non-empty directory, and rejects an already-initialized project (it does not overwrite). The `game` path is recorded in the project manifest (`cnetool.json`) so `build` knows where the source install came from.

| Argument      | Description                                                     |
| ------------- | --------------------------------------------------------------- |
| `game-dir`    | The Codename Eagle install to import (required).                |
| `project-dir` | Where to create the project. Defaults to the current directory. |

### `cnetool build [project-dir] [--no-cache]`

Re-encode a project's `source/` tree into a loadable install under `output/`.

```bash
# Build the project containing the current directory
cnetool build

# Build a specific project, ignoring the copy-through cache
cnetool build my-mod --no-cache
```

`project-dir` defaults to the **nearest ancestor of the current directory that contains a `cnetool.json`** (walking up to the filesystem root), so `build` works from anywhere inside the tree. Copy-through files (sounds, animations, raw) are skipped when unchanged via a build cache keyed on source mtime + size; `--no-cache` re-copies everything.

| Option       | Description                                             |
| ------------ | ------------------------------------------------------- |
| `--no-cache` | Ignore the build cache; re-copy every passthrough file. |
| `--watch`    | Reserved - rebuild on change. Not yet implemented.      |
| `-h, --help` | Show help.                                              |

## Project layout

```
<project-dir>/
  cnetool.json              manifest: game path (+ optional deploy target)
  .gitignore                ignores output/ and .cnetool/cache.json
  .cnetool/
    schemas/                JSON schemas the $schema fields point at (committed)
    base/                   pristine originals for patch-style rebuilds (committed)
    cache.json              build copy-through cache (gitignored)
  source/                   the editable tree - this is what you commit and edit
    textures/
      textures.dat/         one directory per texture archive
        <name>.png            each texture entry as an upright PNG
        <name>.bin            non-texture entries, raw
        entries.json          original entry names + order (faithful repack)
      texsec.dat/
      menupics.dat/
    objects/
      objects.dat/
        <project>/            one directory per mesh (see formats.md)
        raw/<slug>.bin        empty/non-mesh entries, verbatim
        textures.json         the texId -> filename table
        entries.json          original entry names, order and kind
      objects2.dat/
    stats/
      units.json            data3.bin      (unit/enemy stats)
      weapons.json          data4.bin      (weapon stats)
      units-mp.json         mdata3.bin     (multiplayer unit stats)
      weapons-mp.json       mdata4.bin     (multiplayer weapon stats)
    settings/
      menuinfo.json         menuinfo.dat   (profile / options / progress)
      servinfo.json         servinfo.dat   (host match settings)
    config/
      keyconf.txt           keyconf.dat    (input bindings, latin1 text)
    sounds/                 -> sounds/     (verbatim)
    animations/             -> anm/        (*.anm, verbatim)
    levels/                 reserved (level files currently land in raw/)
    raw/                    everything else, verbatim at its install-relative path
  output/                   the generated loadable install (gitignored)
```

### What each area maps to on build

| Source area              | Build output                                                    | How it's stored                                                                            |
| ------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `textures/<archive>/`    | `24bits/textures.dat`, `24bits/texsec.dat`, `menu/menupics.dat` | PNGs (+ raw `.bin`) repacked into the archive; `entries.json` restores names + order.      |
| `objects/<archive>/`     | `objects.dat`, `objects2.dat`                                   | One mesh directory per project + `raw/` blobs, repacked; `textures.json` + `entries.json`. |
| `stats/*.json`           | `data3.bin`, `data4.bin`, `mdata3.bin`, `mdata4.bin`            | Re-serialized to the obfuscated stat-table binary.                                         |
| `settings/menuinfo.json` | `menuinfo.dat`                                                  | Patched over the pristine `.cnetool/base/menuinfo.dat` and re-deflated.                    |
| `settings/servinfo.json` | `servinfo.dat`                                                  | Re-serialized to the four-uint32 binary.                                                   |
| `config/keyconf.txt`     | `keyconf.dat`                                                   | Copied back as latin1 text, byte-exact.                                                    |
| `sounds/`                | `sounds/`                                                       | Passthrough (copied unchanged).                                                            |
| `animations/`            | `anm/`                                                          | Passthrough.                                                                               |
| `raw/`                   | its install-relative path                                       | Passthrough.                                                                               |

The **object mesh directories** (`objects/<archive>/<project>/`: `high.obj`, optional `medium.obj`/`low.obj`, `detect.obj`, `model.mtl`, `project.json`) are documented in full in [the objects.dat project directory format](./formats.md#project-directory-format-cnetool-initbuild) - see that section rather than restating it here.

**Levels** (the `level<n>/` directories: `.scr` scripts, `data1.bin` placements, `mobjs.dat`, minimap data, …) are currently carried through `raw/` verbatim. Structured level extraction (editable scripts and text placements) is a planned follow-up; the terrain/world geometry already lives in `objects/` as the `land<n>` / `level<n>` projects.

## The manifest: `cnetool.json`

```json
{
  "$schema": "./.cnetool/schemas/cnetool.schema.json",
  "game": "/path/to/game",
  "deploy": "/path/to/deploy/target"
}
```

- **`game`** (required) - the install `init` imported from.
- **`deploy`** (optional) - a game directory a future `cnetool deploy` will copy changed `output/` files into.

`.gitignore` (written by `init`) excludes `output/` and `.cnetool/cache.json` - both are regenerated by `build`. Everything else is meant to be committed, including `.cnetool/base/` (pristine originals needed to rebuild patch-style formats) and `.cnetool/schemas/`.

## The `$schema` convention

Every source JSON document (`cnetool.json`, the stat tables, the settings files, `project.json`, each `entries.json`, `textures.json`) carries a leading `$schema` field pointing at a schema under `.cnetool/schemas/`. Editors that understand JSON Schema use it for autocomplete and validation while you edit. `init` copies the schemas into `.cnetool/schemas/` so the references resolve locally; that directory is meant to be committed with the project.

## Fidelity

What round-trips faithfully, and what doesn't:

- **Textures, config, stat tables, scripts and placements round-trip faithfully.** Texture archives repack losslessly; `keyconf.txt` and the stat tables re-encode exactly; scripts and object placements (currently passthrough under `raw/`) are byte-identical.
- **`objects.dat` is byte-identical for cetool-authored meshes, and geometrically exact for shipped models.** A clean cetool-authored mesh rebuilds byte-for-byte. A shipped model rebuilds larger (shipped multi-LOD projects share one vertex array; the rebuild gives each layer its own copy) but resolves to identical geometry, materials and collision hull, and loads equivalently. Details in [formats.md](./formats.md#project-directory-format-cnetool-initbuild).
- **`menuinfo.dat` rebuilds to a loadable file that may not be byte-identical.** It is patched over the pristine base and re-deflated, so the compressed bytes can differ while the decoded contents match.
- **No encoder yet (carried as passthrough):** `.anm` animations; the localization DATs (`dialogue.dat`, `mission.dat`, `endbrf.dat`); AI routes (`data2.bin`); and the `aimap*` navigation rasters. These are copied through unchanged, so they load exactly as shipped but aren't editable via cnetool yet.
- **Engine-generated caches are excluded.** `init` skips `*cache.bin`, `diacache.dat`, `hiscores.dat` and `error.log`; `build` sweeps them out of `output/` first. They are never source and never build products - the engine regenerates them on load.
