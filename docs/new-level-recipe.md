# New-level recipe

**Goal:** author a **self-contained `LEVEL<n>/` folder** the real engine loads - world/terrain model, scripts, and textures all inside the folder, with **no edits to the global `objects.dat`/`textures.dat`**.

**This is confirmed feasible.** Fortress (`level133`) is built exactly this way: its terrain (`oldbf`, 8425 faces) lives in `level133/objects.dat`, its art in `level133/leveltex.bin`, and its setup in `level133/mainscr.scr`. The engine merges `level<n>\objects.dat`, `objects2.dat`, and the global `objects.dat` at load (`FUN_00480190`), so a per-level archive just adds or overrides projects. This doc covers replicating that.

## How a level designates its world

`mainscr.scr`'s `Startup` is the level's **master setup**. Terrain, sky, water, lighting, and the detail textures are all set there - the terrain is just a **project named by `REFSetLandscape`** (any name; _not_ a `land<n>` convention). From `level133/mainscr.scr`:

```c
Startup() {
  REFLightMin(0.3, 0.3, 0.3);  REFLightDirection(...);  REFLightColor(1, 1, 193/255);  // REFLightMin args truncate to int: 0.3 acts as 0 (use whole numbers)
  REFSetPlanet("skysun", 1);                    // sky billboard
  REFSetWater(-10, 10);                         // wave amplitude (±10 units; NOT a water level)
  REFSetLandscape("oldbf", "m6moln", 0, 5000);  // terrain project + sky + sky-dome Y offset + land view/draw range
  REFSetNoiceTexture("noice2c.tga", 0, 32, 8);  // 8 detail/specular overlay slots (0..7)
  ... (slots 1..7) ...
  REFSetRespawnMode(1);                          // MP respawn
}
```

`REFSetLandscape(land:str, sky:str, skyYOfs:num, range:num)` - `land` is the terrain project (in the per-level `objects.dat`), `sky` the sky mesh (empty = no sky), `skyYOfs` the sky-dome Y offset, and `range` the land view/draw range (all four confirmed - see [scripts.md](./scripts.md)'s `REFSetLandscape` entry). So **swapping the terrain = a new project + one string in `mainscr.scr`.**

## Minimum file set (the `LEVEL<n>/` folder)

| File             | Role                                               | Source            | cetool tooling                                      |
| ---------------- | -------------------------------------------------- | ----------------- | --------------------------------------------------- |
| `World.dat`      | placements + spawns (Teamapos/Teambpos, flagbase)  | authored          | `formatWorld` ✅ (engine builds data1.bin)          |
| `mainscr.scr`    | master setup (landscape/light/water/sky/respawn)   | authored          | `compileScript` ✅                                  |
| `red.scr`        | player script                                      | authored          | reuse shipped (copy) ✅                             |
| `MOBJS.DAT`      | object manifest `Name:`/`Type:` (name → behaviour) | authored          | `parseConfig`/`formatConfig` ✅                     |
| `MAPMTX.DAT`     | world→minimap affine                               | authored          | `parseMatrix`/`formatMatrix` ✅ (+ `cetool tabmap`) |
| `LOADING.DAT`    | loading-screen image id (`u32`)                    | authored          | trivial                                             |
| `LIGHTS.DAT`     | light sources (often empty)                        | authored          | `parseLights`/`formatLights` ✅                     |
| `objects.dat`    | terrain project + custom models                    | authored          | `serializeMesh` ✅ + `buildArchive({textures})` ✅  |
| `leveltex.bin`   | ground/detail/tab-map textures                     | authored          | `buildTextureArchive` ✅ (+ `cetool tabmap`)        |
| `<obj>.scr`      | behaviour for any custom objects used              | authored          | `compileScript` ✅                                  |
| **`LEVELS.NFO`** | **global** registry entry `Name:… Val:<n>`         | authored (global) | `parseConfig` read; trivial append                  |

**Engine-generated (do not ship)** - created on load/exit: `acache` `faccache` `ocache` `scache` `scrcache` `texcache` `wcache.bin`.

**Editor source (not needed to load)** - `Global.h`, `WOR.DAT`, `World.mat`, `TEST.DAT` (the in-game editor's working files).

## Building `objects.dat` from scratch

The post-TOC region is the **texture-name list** (a `u32 count` + 13-byte NUL-padded texture filenames; a face's `texId` indexes it) - not a hash table. The name→project hash is rebuilt at load from the TOC names (a fixed 4711-bucket hash, `FUN_0047ff00`), never stored on disk. So a loadable `objects.dat` just needs **TOC + texture list + blobs**, and `buildArchive(entries, {textures})` writes exactly that - verified: it rebuilds shipped `objects.dat` (per-level and global) **engine-equivalent**, differing only in don't-care NUL-padding after names. **Custom-named, from-scratch `objects.dat` works.** (A surgical swap on a cloned `objects.dat` - append the new blob, repoint one TOC offset - also works for quick single-project edits without a full rebuild.)

## Tiers (increasing self-containment)

- **Tier 0 - works now.** New level reusing a **shipped terrain** (`REFSetLandscape("land1"…)` from the global `objects.dat`) + cetool-authored `World.dat`/`mainscr.scr`/`leveltex.bin`. No `objects.dat` build. Fastest path to "a new level loads".
- **Tier 1 - self-contained via swap.** Clone Fortress's folder; surgically swap `oldbf`→your terrain and its props (reusing names). Custom geometry, reused names. Needs no new tooling.
- **Tier 2 - fully custom.** Fresh per-level `objects.dat` with custom-named projects - **now possible**: `buildArchive({textures})` writes a loadable archive.

## Verified: clone Fortress → load as a new level

Copying `level133/` → `LEVEL200/`, registering `Name:Test Fortress Val:200` in `LEVELS.NFO`, and launching with `ce.exe +host +game deathmatch +map "Test Fortress"` **loads cleanly** in the real engine (the `oldbf` terrain renders, `Landscape nFaces=8129`, clean `error.log`), with `level133` untouched - so `LEVEL200` is its own self-contained level. This settles the biggest unknowns:

- **The engine accepts a brand-new level number** (`200`) - and `+map "<name>"` resolves it via `LEVELS.NFO` (`Name → Val`). The menu host map-list reads `LEVELS.NFO` too.
- **A self-contained `LEVEL<n>/` loads** - its own `objects.dat` (terrain `oldbf`) + `leveltex.bin` are used; no global-archive edits needed.
- So **"clone an existing self-contained level and modify it" is the working authoring path today** (Tier 1): the structure is proven; only the _contents_ need swapping.

## Not yet documented (for a fully from-scratch level)

- **Spawn conventions** - `Teamapos`/`Teambpos` are the MP team spawn markers (per the community mapmaker FAQ); they must be **defined**, and the **default entries the editor seeds into a fresh `World.dat` (anything present that you did not place yourself) must be deleted** - otherwise you "fall from the sky" at spawn. The SP player (`RED`) spawns at **world origin `(0,0,0)`** (the 3D home-grid intersection), so terrain must sit _below_ the origin or you start stuck in the ground. (`flagbase`/`redstart` roles are not yet confirmed.)

**Tab-map generation is solved and in-engine-validated**: `cetool tabmap <levelDir>` renders the terrain top-down and writes a `leveltex.bin` (the four `MAP<n>0..3` tiles in the texture-archive format) plus the matching `MAPMTX.DAT`. The map number defaults correctly (levels 133-247 → `333`, else the level number); for other numbers wire `REFUseMapNumber(<n>)`. **Delete the level's `*cache.bin` after installing** so the engine rebuilds against the new files. See [`formats.md`](./formats.md) for the texture-archive format, tile layout, and map-number rule.

## Alternative: the in-engine editor (community-documented)

`ce.exe` has a **built-in object-placement + tab-map editor** (entered via a hosted `level250/` level on **v1.36**, via `+edit` on 1.41+). It's an alternative to authoring files by hand, and independently corroborates several findings in this doc:

- **Launch (1.36 only):** put the level in a `level250/` dir (MP number must be > `128`), add it to `LEVELS.NFO`, and **host** a game on it - you spawn into the editor. **The folder trick is broken on 1.41+** (the engine rewrites any `level250\` path to the `+edit` directory and the load dies - see [game-flow.md](./game-flow.md#level-250---the-built-in-editor-and-why-the-136-folder-trick-broke-in-141)); there, launch with `ce.exe +edit "<leveldir>"` instead (which also skips the `level250` restriction). A dir copied in as `Level_*` is auto-numbered into `LEVELS.NFO`.
- **Placing:** `F12` console → `place <object>` (eg `place house`, `place flagbase`); numpad 8/2/4/6 move, `0` reset, `5` drop; **shoot a placed object to delete it**. Exit (Esc/F10) to save - this writes the level's text `World.dat` (the editable twin of `data1.bin` - `formatWorld`/`parseWorld`).
- **Tab map:** hold **`~` + arrow keys** to move the map vs the world, **End/PageDown** to scale, **`~` + numpad 5** to save - i.e. the editor authors `MAPMTX.DAT` interactively (matching cetool's `tabMapMatrix`). A custom tab map still goes in `leveltex.bin` as `map<n>0..3.tga`, and a blank tab map is fixed by `REFUseMapNumber(<n>)` in the level's startup script.
- **`LEVELS.NFO` gotcha:** end the file with a trailing newline after the last entry, or the level loads to a **black screen** (independently reproduced); level names must be ≤ 12 chars.
- **Placement quirks:** vehicles fall to the terrain when first entered (place them over water on a building to keep them on top); a helicopter shows as a bomber plane in the editor but loads correctly in 1.4x (no per-level `.scr` needed).

## Engine/authoring constraints (corroborated by the community mapmaker FAQ)

External authoring facts from the `codename2.topcities.com` mapmaker FAQ (the 3ds-max + mapmaker toolchain), kept here as engine-behaviour reference - much is tool-workflow (flip normals, UVW modifiers) and not cetool's concern, but these touch the byte/engine level:

- **World scale** - No Man's Land is **30720 × 30720** units, a **18 × 18** terrain grid → each landscape polygon ≈ **1706** units. Maps can be any size; the playable plane is typically cut into 3×3 squares textured with ≤512×512 (256×256 best). Useful for sizing custom terrain and for sanity-checking `tabMapWindowForMesh` framing.
- **Polygon budgets** - keep a **landscape < 8000** faces and an **object's high-LOD < 800** faces; exceeding them lags/crashes the renderer. (Fortress's `oldbf` is ~8129 faces - right at the line.)
- **Landscape material specular** - set landscape specular to **`2,0,0`** or **`0,0,0`** (other values cause lag/crashes); ties to the `Landscape %s specular error` assert noted under terrain.
- **Water** - water surfaces are **semi-transparent faces in the terrain project** (opaque = land, non-opaque = water; there is no water plane), so lakes at any altitude are just face patches at the right height. Two rules: place each water face **above a land face** (the engine pairs them by X/Z overlap at load), and **never stack two water (or two land) faces vertically** - that's a fatal `two land faces or two sea faces` assert. `REFSetWater(a)` only sets the wave-bob amplitude. See `formats.md` § Water.
- **Cache hygiene** - a level's `*cache.bin`/`wcache.bin` hold stale data after you edit its files; the engine may then load old info or crash (`exception ... in main thread`). **Delete the level's cache files after any edit** so they regenerate. (Confirmed in-engine.)
- **Textures** - square, power-of-two (16…1024), **uncompressed 24/32-bit Targa**; **black is the transparency key** (mostly transparent in-game). Already enforced by `validateCeTexture` and the color-key path - the FAQ corroborates both.
- **Level registration** - the mapmaker installer names a level `Level_<name>` and auto-appends it to the levels list (the equivalent of the `LEVELS.NFO` `Name:… Val:<n>` entry described above).

## Known limitations

- **Custom content in a clone is not yet verified**: swapping the cloned level's terrain blob (surgical patch) and adding cetool-authored placements/scripts - i.e. custom _content_ in a self-contained level - has not been load-tested in-engine.
- **A fully from-scratch level is not yet demonstrated**: `buildArchive({textures})`, the small write paths (`MOBJS.DAT`/`MAPMTX.DAT`/`LIGHTS.DAT`), and the tab-map (`cetool tabmap`) are all done; the spawn conventions above are the missing piece before a `LEVEL<n>/` can be assembled with no donor level.
