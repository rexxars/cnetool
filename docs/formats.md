# Codename Eagle file formats

Reverse-engineered notes on the game data files shipped with _Codename Eagle_ (1999). All offsets are byte offsets; all multi-byte integers are **little-endian** unless stated otherwise.

> [!NOTE]
> Items marked confirmed are verified against the engine or by byte-level round-trips; anything marked inferred or guessed may be off.

## Archive format (`.dat`)

A general-purpose packed archive: a header, a table of contents naming each entry and pointing at its data, then the concatenated data blobs. The same container is used for different kinds of payload.

Verified against:

- `textures.dat` - 1557 entries, 151,795,494 bytes. In-game textures.
- `MENU/menupics.dat` - 308 entries, 61,569,751 bytes. Menu graphics (eg the 640×480 `m_main.tga` background).
- `objects.dat` - 473 entries, 8,219,787 bytes. Game objects (`TankPjb`, `AABox`, `cave`, …); payloads are "project" models, decoded - see [`objects.dat` payloads](#objectsdat-payloads---projects-models--terrain).
- `24bits/texsec.dat` - 27 entries. Secondary texture archive (post-release additions; see [Texture archive lookup order](#texture-archive-lookup-order-leveltexbin-texsecdat-texturesdat)).
- `LEVEL248/LEVELTEX.BIN` (36 entries) / `Level133/leveltex.bin` (85 entries) - per-level texture archives (same section).
- `OBJECTS2.DAT` - 22 entries. Secondary object archive (see [`objects.dat` payloads](#objectsdat-payloads---projects-models--terrain)).

`textures.dat`, `menupics.dat`, `texsec.dat`, and `leveltex.bin` store **textures** (see [Texture payloads](#texture-payloads)); the `objects*` files store models. The container parses identically for all - only the payload interpretation differs.

> Note: not every `.dat` file in the game uses this format. Several are plain text (`DIALOGUE.DAT`, `KEYCONF.DAT`, `KEYDEFS.DAT`) or other small binary tables (`diacache.dat`, `menuinfo.dat`).

### Overall layout

```
+-------------------+
| header (4 bytes)  |   uint32  entry count
+-------------------+
| table of contents |   entry-count fixed-size records
+-------------------+
| preamble          |   see "The post-TOC region"
+-------------------+
| data blobs        |   one blob per entry, concatenated in TOC order
+-------------------+
```

### Header

| Offset | Type   | Description |
| ------ | ------ | ----------- |
| 0      | uint32 | Entry count |

### Table of contents

Starts at offset 4 and consists of one fixed **17-byte record** per entry:

```
| name field (13 bytes) | data offset (uint32) |
```

| Field       | Size     | Description                                                      |
| ----------- | -------- | ---------------------------------------------------------------- |
| name field  | 13 bytes | NUL-terminated name (Latin-1), padded to 13 bytes                |
| data offset | uint32   | **Absolute** offset of this entry's data blob within the archive |

The name is read up to the first NUL within the 13-byte field. The remaining padding bytes are **uninitialized and carry no meaning** - they differ from file to file (`textures.dat` leaves bytes such as `6c a1 45 00 84`, `menupics.dat` uses `0xcc`, `objects.dat` uses `0x00`), and never correlate with anything. They should be ignored.

Names are therefore capped at 12 characters plus the terminator; all entries in the verified files fit. Because the records are fixed-size, entry _i_ lives at `4 + i * 17` and there is no need to scan for delimiters.

Blobs are stored contiguously in TOC order, so an entry's blob length is the difference between its offset and the next entry's offset; the final entry runs to the end of the file. (Offsets are monotonically increasing in all verified files.)

### The post-TOC region (between the TOC and the first blob)

There is a region between the end of the TOC and the first entry's data offset. Entry offsets are absolute, so it can be ignored when **extracting** - but it matters when **rebuilding `objects.dat`** (the game reads it at load).

- **`objects.dat` - decoded: it's the texture-name list.** A `u32 count` followed by `count` × **13-byte NUL-padded texture filenames** (eg `LAND16.TGA`, `LSHAPE1L.TGA`). A face's `uint16 texId` indexes this list (see [Texture references](#texture-references-texid)). The loader (`FUN_00480190`) reads it per archive; `parseObjectTextures` reads it in cnetool, and `buildArchive`'s `textures` option writes it. (For `level133`: 17 projects, 80 textures.) The **name→project hash table is _not_ on disk** - the engine rebuilds it at load from the TOC names (`FUN_0047ff00`, a fixed 4711-bucket hash; lookups via `FUN_0047fe70`/`FUN_00480360`), so there is no index/hash table to reproduce.
- **`textures.dat`** - a smaller gap (~8,347 bytes) whose purpose is still unidentified; not needed for extraction, and cnetool's texture repack doesn't reproduce it (re-parses fine).

### Writing archives

`buildArchive` (in cnetool) is the inverse of `parseArchive`: it writes the count, the TOC records, then the blobs contiguously. Combined with `extractEntries` it supports add/replace/ remove of whole entries (eg copying a project between `objects.dat` files, or dropping one). For **`objects.dat`**, pass the `textures` option (the texture-name list, eg from `parseObjectTextures` for a round-trip, or the textures your projects reference in `texId` order) - it's written between the TOC and the blobs and the offsets account for it, so the result is a **loadable** `objects.dat`. Output is byte-identical to the original except the NUL-padding after names (in both the TOC and the texture list) - don't-care, since the engine reads names NUL-terminated. Re-parsing recovers identical names and blobs.

## Texture payloads

In texture archives, each blob is a TGA file **with its constant first 8 header bytes removed**. A standard TGA header is 18 bytes:

| Offset | Field                   | Stored? | Value in these archives          |
| ------ | ----------------------- | ------- | -------------------------------- |
| 0      | ID length               | no      | `0x00`                           |
| 1      | Color map type          | no      | `0x00` (none)                    |
| 2      | Image type              | no      | `0x02` (uncompressed true-color) |
| 3-7    | Color map specification | no      | all `0x00`                       |
| 8-9    | X origin                | yes     | usually `0`                      |
| 10-11  | Y origin                | yes     | usually `0`                      |
| 12-13  | Width                   | yes     | image width                      |
| 14-15  | Height                  | yes     | image height                     |
| 16     | Pixel depth             | yes     | `24` or `32`                     |
| 17     | Image descriptor        | yes     | `0` (24-bit) or `8` (32-bit α)   |

So the stored blob is a **10-byte partial header** (offsets 8-17 of a TGA header) immediately followed by raw, uncompressed pixel data.

**Pixel convention (for engine use).** Pixels are stored in TGA's native order: **BGR** (24-bit) or **BGRA** (32-bit), and - because the descriptor's top-origin bit (0x20) is clear - **bottom-left origin**, i.e. the first row in the file is the _bottom_ of the image. To use the data: swap B↔R per pixel and flip the rows vertically (most modern APIs/PNG expect top-down RGBA). `cnetool`'s `decodeTga` does both and returns top-down RGB(A); `encodeTga` writes this same convention back.

The blob length always satisfies:

```
blobLength === 10 + width * height * (depth / 8)
```

This held for every entry in both texture files, with no exceptions - there are no run-length-encoded or color-mapped images. (`textures.dat` mixes 24- and 32-bit images; `menupics.dat` is entirely 24-bit.) This size equation is also how a texture entry is told apart from an opaque one: an entry is treated as a texture only if its name ends in `.tga` and its blob length matches.

### Reconstructing a standalone TGA

Prepend the eight constant bytes and the blob is a spec-compliant TGA:

```
00 00 02 00 00 00 00 00   (id len, no color map, type 2, empty color map spec)
<the 10-byte partial header + pixel data exactly as stored>
```

### Transparency and format rules (for new/edited textures)

- **How the game does transparency - two mechanisms:**
  - **32-bit = variable per-texel alpha.** A 32-bit texture carries a real alpha channel and CE renders it (confirmed: shipped 32-bit textures use the full alpha range - intermediate values at antialiased edges, in 53/60 sampled).
  - **24-bit = black color-key, enabled per DRAW.** A 24-bit texture has no alpha, so the loader attaches a DirectDraw/D3D **black color-key** to it (everything that quantizes to RGB565 black, i.e. `R<8, G<4, B<8`) - decided purely by **bit depth** (the loader branches on `bpp == 32`, `ce.exe` ~`0x4497f5`; confirmed by the loader's colour-key calls + the debug string `Color key %x`). **But attaching the key is not rendering with it.** The key only takes effect on draws whose primitive sets flag `0x1000` - for a mesh face, that comes from material file flag `0x02` (see the face-flag table), which wraps the draw in `COLORKEYENABLE` (`FUN_0045e670`, the sole toggle at `0x45e899`). The same flag drives the 2D-blit path, and most 2D draws leave it clear. So a 24-bit texture is see-through **only where a draw enables the key** - e.g. `PIPEJB`: keyed on the flame-tank's barrel faces (holes), plain on the track faces (opaque black), _one texture, both in-game_; `MULT8`'s stray near-black terrain dots render black (terrain faces never set `0x02`); level pictures (`PB*`), tab-map tiles (`MAP*`), and briefing/menu art blit opaque. **Transparency is a property of the draw, not the texture** - there is no per-texture "is transparent" bit. Artists also simply avoided the key colour in opaque art (811/1463 solid 24-bit textures have no key-range texels; sprite/decal textures are 96-100 % pure black; the sniper-scope surround is `RGB(6,6,6)`, one 565 step above the key, so only its true holes key out).
- **How cnetool handles it.** `cnetool extract` passes textures through as-is: a 32-bit texture becomes an RGBA PNG (alpha preserved), a 24-bit texture an opaque RGB PNG (its black stays black) - the key is a per-draw engine effect, not part of the image. The model exporters (`mesh`/`object`/`level` with textures, and glTF/GLB) **do** reproduce the key, and per face: a face whose material carries file flag `0x02` gets a `<name>_key` material with the black key range cut to transparency (PNG alpha, plus a grayscale `map_d` mask for OBJ viewers; glTF/GLB uses `alphaMode: MASK` - the most portable, so prefer `.glb` for viewing), while unflagged faces on the same texture use the opaque copy - matching the in-game per-draw split (eg `PIPEJB`: see-through barrel holes, opaque tracks, one texture). 32-bit textures keep their real alpha either way. For OBJ the cut-out requires PNG textures (`-p`); the default raw-TGA output can't carry it.
- **Authoring a transparent texture - use 32-bit alpha.** Make an **RGBA PNG** with the transparent regions at alpha 0 and import it with `pngToTga(rgbaPng)` → a 32-bit TGA the engine renders with real per-texel alpha, on any face, no material flag needed. This is the simplest correct path. An **RGB PNG** imports to an opaque 24-bit TGA. (Matching the stock 24-bit-key style - black texels + a `0x02` face flag - is possible but pointless for new work: 32-bit alpha is strictly more capable and doesn't depend on the mesh.) `pngToTga` **always** validates the result (below).
- **Dimensions must be square and power-of-two** (16, 32, … 1024) and the image **uncompressed 24- or 32-bit** true-color (verified across 1822 shipped textures: 0 exceptions). Non-square / non-power-of-two / compressed textures fail to load or render as holes. `pngToTga` **always** validates this (and rejects a non-compatible image); `validateCeTexture(image)` exposes the same check for callers that want the list of violations.
- Tab-map textures are four tiles `map<lvl>0..3.tga`; `REFUseMapNumber(n)` (a script call) overrides a level's tab-map number.

### Texture archive lookup order (`leveltex.bin`, `texsec.dat`, `textures.dat`)

The engine loads textures from up to **three archives**, registered at init (`FUN_00464260` @ `0x464260`, reader `FUN_00464300`) and searched by the by-name lookup (`FUN_004641b0` @ `0x4641b0`) in priority order, **first name match wins**:

| slot | archive                 | scope     | notes                                         |
| ---- | ----------------------- | --------- | --------------------------------------------- |
| 0    | `level<N>\leveltex.bin` | per-level | optional; only loaded when a level is running |
| 1    | `24bits\texsec.dat`     | global    | secondary archive, always loaded              |
| 2    | `24bits\textures.dat`   | global    | the main 1557-entry pack                      |

All three are texture archives (they use the texture-archive container variant with the fixed 2048-slot TOC, see [`leveltex.bin` / `textures.dat` - texture archives](#leveltexbin--texturesdat---texture-archives)). The two extra archives are **additive patch channels**: new or changed textures ship in a small archive instead of a rebuilt 151 MB `textures.dat`, and a name collision shadows the lower-priority copy.

- `texsec.dat` (27 entries) carries textures added after the main pack was frozen: the 1.41 helicopter (`Helicopt`, `HeliSh`, `HeliShad`), boat parts (`BOATROP`, `bshipipe`, `TBOATLOG`), the HUD icon atlas `INTERFC1`, loading screens `load0`-`load5`, `FLARE0`, `visare`, and the vehicle [alt-skin](#vehicle-alt-skins-car2-plane2-and-the-2-textures) `*2` variants (`Carnew2`, `airbot2`, `wing2`, `MC2`, …).
- `leveltex.bin` ships with the two post-release levels only: `LEVEL248` (Fever Valley, 36 `fevr*` entries) and `Level133` (Fortress, 85 entries), holding those maps' new textures. Any level can carry one, and because the lookup is name-shadowing it also works as a per-level **override** of global textures (useful for e.g. upscaled texture replacements).

### Renderer texture size limits

The two hardware render paths differ, and neither limit is a property of the file format:

- **Glide/3dfx**: hard cap at **256×256**: the TGA→Glide loader (`~0x4643d0`) fatally asserts on anything wider (`"LoadFromTGACacgeTO3FXX() 256"`, string @ `0x4cd934`), matching the Voodoo1/2 hardware maximum. It then builds a 16-bit mip chain down to 8×8.
- **Direct3D**: **no engine-side limit.** The TGA's dimensions go straight into `CreateSurface`, and the mip-cap table (`0x4cd7e8`) anticipates sizes up to 16384. CE never queries the driver's max-texture caps, so the real ceiling is the driver: period hardware may fail the surface creation (logged `createtexture %s error`, texture comes back missing, not fatal), modern drivers/wrappers accept large textures. This is what makes upscaled-texture packs viable on the D3D renderer.
- **Both paths**: when the texture-detail option is low (byte 3 of the options block `0x557630` = 0), anything wider than 128 is box-downsampled (`FUN_00464c80`) to **128×128** before upload. Testing high-res textures requires the high texture-detail setting.

## `objects.dat` payloads - "projects" (models & terrain)

`objects.dat` uses the same container, but each blob is a **"project"** (the engine's term for a 3D model). Crucially, this includes the **level terrain**: projects named `land1`-`land10` and `level9`/`level11`/`level12` are the level landscapes (eg `land1` spans ~30000×30000 world units). So the same format covers both props and the playable world.

Like textures, projects resolve across **three archives in priority order** (loader `FUN_00480190` @ `0x480190`): `level<N>\objects.dat` (per-level, optional; shipped by the two post-release levels `LEVEL248` and `Level133`, which carry their own terrain there), then `OBJECTS2.DAT`, then `objects.dat`. First name match wins, so `OBJECTS2.DAT` (22 entries) is the patch channel for models: it carries the post-release vehicles (`helicopter`/`Heli*`, `zeppe`, `aship`/`bship`, `torpb`, …), **overriding** copies of existing projects (its `rcbody` shadows the `objects.dat` one), and zero-byte name-registration stubs for spawnable vehicle variants (`car`, `car2`, `plane`-`plane4`). Each archive carries its own texture-name table for its blobs' `texId`s.

This format was confirmed by decompiling the loader (1.41 geometry parser `FUN_00480b60`, per-layer reader `FUN_00481360`; the demo `Game.exe` equivalents are `LoadObject` → `FUN_0047b390`, faces in `FUN_0047bb40`) with Ghidra, then validated by re-parsing - and re-serialising - all 473 blobs.

Blob structure - **fixed at exactly four layers**: a leading vertex array shared by three render LOD layers, then a _second_ vertex array for a fourth detect/collision layer.

```
uint32            nv1         render vertex count (shared by the 3 render layers)
nv1 × 3 × float32 vertices    (x, y, z) world coordinates
render layer 0                highest detail (see below)
render layer 1                medium detail / a repeat / empty
render layer 2                low detail / a repeat / empty
uint32            nv2         detect-hull vertex count (0 = no hull)
nv2 × 3 × float32 vertices
detect layer                  collision hull (empty when nv2 = 0)
```

The loader reads all four layers unconditionally; any layer can be **empty** (`nEdges = 0`, `nFaces = 0`, 8 bytes). There is **no** trailing bounding value - the loader computes the object's extent from the vertices at load time. (What can look like 4 trailing "bounding" bytes on small projects is just these empty trailing layers + the `nv2 = 0` word.)

### Mesh layers (LOD + detect)

The three render layers are **levels of detail** of the same model, ordered detail-descending (index 0 highest), each indexing its own slice of the shared vertex array. Shipped data uses three patterns, all the same on-disk shape:

- **Multi-LOD props** store genuine decreasing detail - eg `STBody` 33/24/12 faces, `tree1` 29/21/11, `house` 54/22/13 (404/409 multi-layer projects are detail-descending).
- **Simple props** repeat one mesh across all three render layers (eg `mansh` 1/1/1).
- **Terrain** (`land1`-`land10`, `level9`/`11`/`12`, `dm1`) fills only layer 0 and leaves layers 1 and 2 **empty** - terrain always draws at full detail.

`cnetool`'s `parseMesh` returns the **first (highest-detail)** non-empty layer by default; pass `{lod: 'medium' | 'low' | <index>}` to pick another, or `parseMeshLayers` for all of them (high→low). Drawing them all at once overlays the lower-poly copies _inside_ the high-detail one as boxy artifacts.

The fourth layer is the **`detect`/collision hull** (PACKETOR's `<detect>` input; see the mapmaker toolchain), a simplified hull with its _own_ `nv2` vertex array (eg `moose`'s 49-vert model → an 8-vertex box; `edoor` → 8v/6f). `parseDetectMesh` returns it (or `null` when `nv2 = 0`); 261/473 projects in 1.0's `objects.dat` have one. `cnetool`'s `serializeMesh` writes this exact four-layer shape - a single mesh fills all three render slots (so it never vanishes at LOD distance), with `lods`/`detect` options for genuine layers and the hull.

#### Held weapons: layer 0 is a first-person viewmodel, not the world model

For a **held weapon**, the three LOD layers are not just detail steps: they split by **viewpoint**. Layer 0 is the **first-person viewmodel** the wielder sees: it is modeled only for what's on screen, so it **bakes in the player's hands/arms gripping it**, is built **single-sided** (the far side facing away from the camera is left open/empty), and skips caps and back faces you never see from the shoulder. Layers 1-2 are the **world models** other players see and the distance renderer uses: no hands, just the weapon, closed up. `SnipeGun` is the clearest case (layer 0 has two hands and a hollow back); the `Bazooka` viewmodel is an open, one-sided tube (it renders solid in-game only because the engine culls back faces).

The engine keeps two separate lookups, both resolving weapons by the **same project name** (no distinct `<weapon>_world` project): the first-person viewmodel table (`FUN_00412440`, e.g. `knife`/`rifle1`/`SnipeGun`/`kpist`/`grenade`/`Bazooka`/`flamew`) and the character-attach weapon switch keyed on the weapon class (`FUN_0047ed20`, `case '+'` = class 43 = `Bazooka`). It picks the LOD layer by distance, so the viewpoint split is really "layer 0 up close = your hands; lower layers far away = what others see". (`gRifle`, 47 faces vs `Rifle1`'s 241, is the lone _separate_ low-poly weapon project, the guard/enemy rifle chosen via the AI data; there is no `g`-twin for weapons no NPC carries, eg the bazooka.)

**So, to operate on a weapon model:** take the **highest** layer (`parseMesh` default) only if you want the hands-and-all viewmodel; take **`{lod: 'medium'}` or `{lod: 'low'}`** for the clean, symmetric, hands-free world shape. `parseMeshLayers` returns all three when you need both.

Each layer is:

```
uint32   nEdges                 edge count
nEdges × 5 bytes                precomputed edge table - SKIPPED by the loader
uint32   nFaces                 polygon count
repeat nFaces:
  uint8    nv                   vertices in this face (3 = triangle, 4 = quad, …)
  nv × uint16                   edge indices - SKIPPED by the loader
  nv × uint16                   vertex indices (into the vertex array)
  8 bytes  material             see below
  if texId != 0xffff:
    nv × (float32 u, float32 v) per-vertex UV coordinates
```

The 8-byte material is:

```
byte 0..2   RGB color
byte 3      alpha, stored inverted - opacity = 255 - byte3 (0 -> opaque)
byte 4      render flags (see below)
byte 5      padding (always 0 observed)
byte 6..7   uint16 texId (0xffff = untextured)
```

The render-flags byte is remapped by the per-face material reader (`FUN_00481360`) onto an internal 16-bit face-flag field; the renderer's draw path (`FUN_0045d060` / `FUN_0045e670` for Direct3D, `FUN_00461f70` for the Glide/3Dfx path) then tests those bits. Decoded by reading the draw path:

| file bit             | internal                   | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0x01`               | `0x0001`                   | **invert facing / flip winding** - the cull pass reverses this face's front/back test (see below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `0x02`               | `0x1000`                   | **color-key transparency** - sets `0x1000` on the draw primitive, which makes the draw path (`FUN_0045e670`) enable `COLORKEYENABLE` (render state `0x29`, the sole toggle at `0x45e899`), so the black key attached to every 24-bit texture only _bites_ on primitives with this flag. Verified against in-game behavior: `PIPEJB` mixes 10 keyed + 103 plain faces (flame-tank barrel holes see-through, tracks opaque black); `MULT8`/`M3SP11`/`ZEPPELIN*` have 0 keyed faces (black texels render black); fences/barbed wire are 100% keyed. The same struct+flag drives 2D blits (scope keyed; `PB*`/`MAP*`/menu art not), so it's per-draw, not per-texture. (This is not backface culling - `CULLMODE` is set once to `D3DCULL_NONE` at renderer init, `0x45e0xx`, and never per face.) |
| `0x04`               | `0x0004`                   | **raw vertex colour** (unlit); when clear, colour is modulated by the per-face light byte (internal `0x0200`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `0x08`               | `0x0800`                   | **alpha-blend / transparency** (sets D3D `SRCBLEND`/`DESTBLEND`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `0x10`               | `0x0400`                   | **two-sided** - skip the clip-stage backface/visibility cull (gameplay name inferred)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `0x20`/`0x40`/`0x80` | `0x2000`/`0x4000`/`0x8000` | **3-bit "noice"/specular overlay slot** (0-7) - see below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

The high three bits pack a **slot index** (`flags >> 0xd & 7` at draw time): each slot selects one of 8 environment/specular overlay textures + a per-slot second-UV tiling factor, assigned by the script call `REFSetNoiceTexture(file, slot, uvRepeat, mipLevels)` (`FUN_0045c9c0`; see scripts.md for the confirmed argument semantics: the third argument scales the overlay stage's UVs, it is not a brightness). Each level's `MAINSCR.SCR` fills the slots with its own choice of overlay textures, which is why the same mesh reads slightly differently per level. The slot lookup applies to **every** face, objects included, not just terrain: the draw path binds the slot's texture as a second stage per face (`FUN_00461f70` → `FUN_00461660`). **This is the "`2,0,0`" specular convention**: a material authored `2,0,0` means _noice slot 2_ (file byte `2 << 5 = 0x40`). Terrain faces live in these slots - the landscape loader asserts `flags & 0x1800 == 0` ("`Landscape %s specular error`") and forces water faces to slot 7 at load (see [Water](#water---semi-transparent-terrain-faces-initwater) - on disk, water faces carry slot 0).

**Bit `0x01`** (invert facing) is read by the per-frame screen-space cull pass `FUN_0046a700`: it computes each face's projected winding and, for a face with `0x01` set, takes the _opposite_ front/back decision (toggling an internal per-frame bit the draw path reads to reverse the emitted vertex order). It's an authoring fix for polygons stored inside-out. Runtime face tessellation (the "explode" path) also force-sets it on generated sub-faces.

All eight bits appear in shipped `objects.dat` (132,019 faces): `0x04` 43%, `0x20` 12%, `0x01` 6.9%, `0x40` 3.8%, `0x02` 2.4%, `0x08` 0.8%, `0x10` 0.6%, `0x80` 0.5%. `cnetool`'s `parseMesh` exposes the decoded `color`, `alpha` and raw `flags` per face.

The loader recomputes edges at runtime (`LoadProjectEdgeInfo`), so the two edge sections are skipped on load (byte-level analysis alone cannot separate them from the vertex indices).

### Normals / winding (for engine use)

The engine derives each face's normal from the first three vertices (in stored index order) as `N = (v2 − v1) × (v1 − v0)`. Faces are wound **consistently** - over the terrain projects `N.y` has the same sign on every face (verified across all of `dm1` 8128/8128 and `land1` 3499/3499). Since the game's up is **−Y**, that vector points `+Y`; `cnetool`'s default Y-up export rotates the mesh 180° about X (`x, −y, −z`, winding preserved), so exported faces come out solid/outward in standard (Y-up) viewers. Both re-orientations (`'y'`, `'z'`) are **proper rotations**: a plain Y negation is a reflection and mirrors the world - map layout flipped relative to the in-game tab map, lettering on textures reversed. The world's horizontal orientation is anchored by the tab map: retail `MAPMTX.DAT` matrices map world **+x to map-right and +z to map-up**. Use `up:'raw'` to keep the native orientation and winding. Faces can be polygons (`nv` ≥ 3).

### Water - semi-transparent terrain faces (`InitWater`)

CE has **no global water plane**. Water surfaces are ordinary faces _inside the terrain project_, distinguished purely by their **material alpha**: an opaque face is land, a semi-transparent face is water. Because each water surface is just polygons at whatever Y the modeler placed them, a level can have **any number of water levels** - `dm1` (No Man's Land, 8129 faces) has 6871 opaque land faces and 1258 water faces (authored alpha 243) in two height groups: the **sea**, flat faces at `y ≈ 793.5` spanning the full 30720×30720 extent (plus a few gently sloped shoreline-transition faces at `y ≈ 780-801`), and a **lake**, 578 flat faces at `y ≈ 53.1` confined to a ~6700×6800 region - ~740 units _above_ sea level (−Y is up).

At level load, `InitWater` (the `wcache.bin` producer, `0x46e890` region) does the rest:

- loads `water.tga` into noice slot 7 itself (`0x45c9c0("water.tga", 7, 16.0, 8)`);
- asserts no landscape face carries file specular bits (`flags & 0x1800`, the `Landscape %s specular error` assert);
- for every **non-opaque** face: forces its runtime alpha to a fixed `0x8c` and sets `flags |= 0xe000` (noice slot 7). The authored alpha value therefore only matters as a land/water switch - the engine normalizes the rendered look, and on disk water faces carry noice slot 0 like plain land;
- **pairs each water face with the land face directly beneath it** by X/Z vertex overlap, writing the `{land, water}` pair list plus land/water face lists into `wcache.bin`.

The overlap test (used both for pairing and for the validation below) is per-vertex coincidence, Y ignored: face **A matches face B when _every_ vertex of A has some vertex of B within 1.0 world units in both X and Z** (`|Δx| < 1.0 && |Δz| < 1.0`; the tolerance is the double at `0x4a1380`, compared as float). A water face is paired with every land face it matches.

The pairing is the "**replacement height face**" mechanism: the terrain height query (`0x470540` / `0x470700`) returns the water surface for paired faces (how boats float and the `InWater` script callback fires), while `REFAlignToLand` skips water-replaced faces so placed objects snap to the lakebed, not the surface.

**Validation** - before pairing, `InitWater` runs the same match test between faces of the _same_ class (land-land and water-water). Every matching pair is logged (`error: %d,%d two land/water faces alpha…` plus face A's vertices) and **any** error is fatal: `two land faces or two sea faces, nErrors=%d`. Because vertices coincide in X/Z regardless of Y, this catches not just genuinely stacked terrain but also **exactly/near-vertical walls** (top vertex within 1.0 X/Z of a bottom vertex - the two triangles of a vertical quad flag each other) and **sub-unit sliver triangles** (two vertices < 1.0 apart make adjacent faces coincide vertex-for-vertex). Any number of water levels at _different_ X/Z regions is fine, but never two water surfaces above the same spot.

**The validation only runs when `wcache.bin` is absent or stale** - a valid cache is loaded verbatim and the mesh is never re-checked. Retail Fortress (LEVEL133) depends on this: its terrain (`oldbf`, 8425 faces) has 7 vertex pairs sitting 0.67-0.99 apart in X/Z (near-vertical shoreline-wall triangles and ~1-unit-wide slivers, in both the lakebed and its mirroring water surface), producing 19 fatal errors if its `wcache.bin` is deleted. The shipped cache's pair list matches a version of the mesh where those vertices were ≥ 1.0 apart, so the slivers were introduced by a later mesh edit and shipped unvalidated. Spreading each pair to > 1.0 along one axis (moving mirrored water/lakebed vertices together, ~0.05-0.13 units per vertex, 14 vertices) removes all 19 errors and regenerates a pair list identical to the retail cache.

Waves come from `REFSetWater(amplitude)`: its single stored float (`0x4ce648`) feeds a 256-entry sine table built by the landscape loader (`0x46f160`), and both the renderer and the height query add `table[(phase + frame) & 0xff]` to water-face vertex Y - the water bobs ±|amplitude| units around its mesh height, uniformly for every water surface. It does **not** set a water level (see `scripts.md`).

**Authoring:** a lake at any altitude is just another patch of semi-transparent faces in the terrain project placed above land faces - no script support needed. Constraints: keep water faces non-opaque and land faces opaque, never stack two water (or two land) surfaces vertically, and keep any two vertices of a same-class face pair ≥ 1.0 world units apart in X or Z unless they are the same point - no perfectly vertical walls, no sub-unit slivers.

### Texture references (`texId`)

A face's `uint16 texId` is an index into a **texture-name table** that follows the project TOC in `objects.dat`: a `uint32 count`, then that many 13-byte NUL-terminated filename records (eg `MULT15.TGA`, `APW.TGA`). The name is then resolved against `textures.dat` by filename. Some names use a source extension (`.TIF` / `.BMP`); the packed copy is `.TGA`, so normalize the extension on lookup. Example: `dm1` (level 128 terrain) face texId 1098 → `MULT15.TGA` → the `textures.dat` entry of the same name (an aerial ground/water texture). The `cnetool mesh --textures` flag uses this to emit `.mtl` materials and extract the referenced textures.

Validated by self-consistency (Euler's formula): `land1` has nv=1768, nEdges=5266, nFaces=3499 → 1768 − 5266 + 3499 = 1 (a triangulated terrain mesh with a boundary), and the parser consumes the blob to its end. `codenot1` is a single textured quad (`nv`=4, one face with vertex indices `[0,1,2,3]`, texId 0x04d7, UVs `(1,0) (1,-1) (0,-1) (0,0)`).

**Minor remaining unknowns:** the material's byte 5 padding. (The flag bits, the `texId` table, and the `nanimvers` animated-vertex-set layout + its runtime are decoded - see above and _Vertex animations_.) A project is fully readable as a textured mesh - `cnetool`'s `parseMesh` + `meshToObj` export it (with materials via the `texId` table), and `cnetool mesh --textures` writes a ready-to-open `.obj` + `.mtl` + the `.tga` images.

## Other `.dat` files (not archives)

Most `.dat` files in the game are **not** archives - they are individual data or config files. Across the game there are 126 `.dat` files of 18 distinct names; only three (`textures.dat`, `menupics.dat`, `objects.dat`) use the archive container above. The rest fall into two families.

There is a clear **global vs per-level** split. Global files live in the game root; each `LEVEL*/` folder carries its own copy of the per-level files.

| File           | Scope     | Family | Purpose                                                                      |
| -------------- | --------- | ------ | ---------------------------------------------------------------------------- |
| `MISSION.DAT`  | per-level | text   | Mission text / objectives (localized, `//` comments)                         |
| `BRIEF.DAT`    | per-level | text   | Pre-mission briefing (`Text:`/`Name:`/`Dist:`/`Yaw:`/`Pit:`)                 |
| `ENDBRF.DAT`   | per-level | text   | End-of-mission briefing (localized)                                          |
| `DIALOGUE.DAT` | both      | text   | Localized dialogue (`Languages:N`, `Filename:`, `Eng:"…"`)                   |
| `MOBJS.DAT`    | per-level | text   | Map-object instance list (`Name:`/`Type:` records)                           |
| `MATS.DAT`     | per-level | text   | Camera/node transforms (`Name:`/`Translation:`/`Dof:`/`Up:`)                 |
| `KEYCONF.DAT`  | global    | text   | Input bindings (`Fire:DIK_SPACE MOUSE_LBUTTON`)                              |
| `KEYDEFS.DAT`  | global    | text\* | Key-name → scancode table (whitespace columns, not `Key:Val`)                |
| `HISCORES.DAT` | per-level | text\* | High scores (bare values, `-1`/`-1`/`-1`/`0`)                                |
| `MAPMTX.DAT`   | per-level | binary | 9 float32 = 3×3 world→minimap affine matrix                                  |
| `LIGHTS.DAT`   | per-level | binary | Array of 23-byte light records (often empty)                                 |
| `LOADING.DAT`  | per-level | binary | Single uint32 - loading-screen image id                                      |
| `diacache.dat` | global    | binary | uint32 table - dialogue WAV-length cache (generated)                         |
| `menuinfo.dat` | global    | binary | Saved profile/options/progress (zlib + keyed-add cipher)                     |
| `servinfo.dat` | global    | binary | Host MP match settings - 4 × uint32 (fraglimit/scorelimit/timelimit/nextmap) |

### Text-config family (`Key:Value`)

The dominant format: lines of `Key:Value`, CRLF-terminated, Latin-1. `//` lines are comments. Values may hold multiple space- or comma-separated tokens (`Translation: 59.09,-1421.66,-2200.79`). Keys repeat to form records - eg `MOBJS.DAT` is a flat list of `Name:`/`Type:` pairs, one pair per object.

`cnetool`'s `parseConfig` / `groupRecords` (see the README) read this family.

`KEYDEFS.DAT` and `HISCORES.DAT` are text but not `Key:Value`: `KEYDEFS.DAT` uses whitespace-aligned columns and `HISCORES.DAT` is bare values, one per line.

**Input bindings** (`KEYCONF.DAT` + `KEYDEFS.DAT`, both global, byte-identical across all shipped versions). `KEYDEFS.DAT` is the static name → scancode dictionary: 125 lines, each a symbolic name space-padded to column 20, a hex value, and an optional `/* … */` comment. 120 `DIK_*` names use real DirectInput scancodes (`DIK_ESCAPE 0x01`, `DIK_1 0x02`, … matching `dinput.h`); 5 `MOUSE_*` names use a synthetic `0xF01`-`0xF05` range for axes/ buttons that have no scancode. `KEYCONF.DAT` is the live `Action:primary [secondary]` binding list (`Fire:DIK_SPACE MOUSE_LBUTTON`, `Pitch+:DIK_UP MOUSE_Y`, …, 13 actions), referencing `KEYDEFS.DAT` **by name** - the engine resolves each token to a scancode at load. The control-setup loader (`0x441490`) reads `KEYCONF.DAT` line by line and also honours an optional `InvertMouseY` directive (not present in shipped copies).

### Localization files

Three files hold localized text in **two related sub-formats**. Both are Latin-1, CRLF, with one block per language; the language tags are whatever the file uses and vary between files (eg `Fre` vs `Fra`, `Spa` vs `Esp`).

**Dialogue** (`DIALOGUE.DAT`, global and per-level). A `Languages:N` header, then one record per spoken line:

```
Languages:5
Filename:       SPYOUWIL
Eng: "You will begin the mission on foot..."
Fre: "Vous commencerez la mission à pied..."
Ita: "..."
Spa: "..."
Ger: "..."
```

Each record is a `Filename:` (the dialogue id) followed by one `<Language>: "text"` line per language; untranslated entries are present but empty. A few cutscene lines have **multi-line** values (embedded quotes and colons), so a value runs until the next `Key:` line rather than to end-of-line. The shipped data has a couple of defects (an occasional missing closing quote; one record, `SRIBETTE`, has a `Spa` line missing its colon) - these affect only those individual values.

The `Filename:` is the **id of a voice clip**: `DIALOGUE.DAT` is effectively the subtitle/translation index for the `SOUNDS/` audio. The id maps directly to a `.WAV` on disc, eg `Filename:SPYOUWIL` → `SOUNDS/DIALOGUE/SPYOUWIL.WAV`, and the `SR…`-style ids used by the per-level dialogue files map into `SOUNDS/brf/`. (Note: the `SOUNDS/` tree ships on the CD but is absent from some installed/ ripped copies of the game.)

**Briefing** (`MISSION.DAT`, `ENDBRF.DAT`, per-level). Free-form text split into language sections by `//<language>:----` delimiter lines (the `//` here is a section marker, **not** a comment):

```
//Eng:----------------------------
"April 21nd 1927"

"We have managed to locate Popov's Zeppelin..."
...
//Fre:----------------------------
"21 avril 1927"
...
```

Each section's body is free-form (quoted paragraphs, `Mission Objectives:`, numbered items, `@` separators, score placeholders like `*###…`) and is not further structured.

`cnetool`'s `parseDialogue` and `parseBriefing` (see the README) read these. `parseDialogue` is line-oriented and does not interpret inline timing tags such as `<1.0>` inside cutscene text.

### Binary files

Small, little-endian. `MAPMTX.DAT` is the clearest: nine `float32` forming a 3×3 homogeneous matrix that maps world coordinates to minimap pixels, eg

```
[ 0.0113   0       198 ]
[ 0       -0.0113  255 ]   (note the Y-axis flip)
[ 0        0         1 ]
```

The convention is **confirmed** (validated against the shipped levels by projecting a level's `flagbase` placements onto its tiles): it maps world **`(x, z)`** - the horizontal plane; Y is the vertical axis - to a pixel in the **512×512 full-map space** (top-left origin), `px = s·x + tx`, `py = −s·z + ty`. The scale is uniform with **Z flipped** so world +Z (north) points up. It's a pure scale + translate (no rotation), framing a chosen square world window - `s = 512/size`, `tx = 256 − s·cx`, `ty = 256 + s·cz` for window center `(cx, cz)`. The shipped matrices frame the **gameplay area** (roughly the placement bbox), not the full terrain mesh, which often has a vast ocean skirt.

The matrix pairs with the **tab map**: the full-screen map shown in-game is **four texture tiles** named `MAP<number><tile>.tga` (tile `0`-`3`), each **256×256 24-bit**. `MAP1280`-`MAP1283` is the set for map number 128. The engine (`FUN_00446c70`) reassembles them in a **2×2 grid** - confirmed **in-engine** to be **row-major: `0`=top-left, `1`=top-right, `2`=bottom-left, `3`=bottom-right**, and each tile is drawn **top-origin** (the stored pixel row 0 is the screen top). A handful of `…A` variants (`MAP11A`, `MAP101A`) are alternate maps.

**Map number** - which `MAP<n><0..3>` set loads (`FUN_00446c70`, `sprintf("map%d%d.tga", n, tile)`):

- if a script called `REFUseMapNumber(n)` (`DAT_004d3c98`, default `-1`), `n` is used;
- otherwise it defaults to the **level number**, **except levels `133`-`247` hardcode `333`** (`if (133 ≤ level ≤ 247) n = 0x14d`). That's why Fortress (133) and any clone in that range use `map333*` with no script call, while No Man's Land (128) uses `map128*`.

So to ship a custom tab map for a level in `[133,247]`, name the tiles `map333*` (or call `REFUseMapNumber`); for other levels, name them `map<level>*`. `REFUseMapNumber` lives in the level's **startup script** - eg Fever valley calls `REFUseMapNumber(111)` in its `mainscr.scr` (tiles `map111*`); Fortress relies on the `133→333` default (its `mainscr2.scr`'s `REFUseMapNumber(128)` is an unused variant). The hardcoded `333` range is what a community RE doc couldn't explain ("maybe ce.exe doesn't use the first digit") - it's the `[133,247]` rule above. The `MAPMTX` itself is editable in `ce.exe`'s built-in editor (`~`+arrows to move, End/PgDn to scale); the shipped level-1 matrix (`0.021/256`, `−0.021/278`) matches this convention exactly.

`cnetool tabmap <levelDir>` generates the whole thing: renders the terrain project top-down (orthographic, per-pixel texture sampling) and writes a `leveltex.bin` with the four tiles plus a matching `MAPMTX.DAT`, so the in-game marker lands correctly. **Validated in-engine** on a No Man's Land clone. API: `renderTabMap` / `sliceTabMapTiles` / `tabMapMatrix` / `tabMapWindowForMesh` (+ `buildTextureArchive`). Two non-obvious points the implementation encodes: `sliceTabMapTiles` flips each tile vertically (engine draws top-origin), and `renderTabMap` flips the texture **V** axis when sampling (CE textures are bottom-origin, `decodeTga` returns top-down, mesh UVs are bottom-origin - without the flip, baked multi-tile terrain like `MULT*` samples upside-down and bands).

By default the render is **grayscaled with a diagonal light gradient** (`grayscaleTabMap`: luminance × a factor that fades from `2.0` at the top-left to `0.7` at the bottom-right), which reproduces the shipped maps' lit, contrasty look - a flat desaturation is too even. `--color` keeps the full-color render.

Three framing knobs, two coordinate spaces (the shipped maps use all three): **water-padding** is _world_ - how much surrounding terrain (the level's own water) is framed around the gameplay area; **margin** is _image_ - a black margin in **pixels**, per side, default **bottom-only 32px** (the strip the engine crops at the **bottom**), keeping content/marker out of the cropped region; **border** is _image_ - the decorative white frame (default **16px**, on) just inside the margin; **grid** is _image_ - a thin alpha-blended graph-paper overlay (default **46px**, on) drawn over the content **inside** the border. `frameTabMap` paints all of these over the full-size render's edges (the playable area stays central via water-padding), so the `MAPMTX` needs no offset - matching the shipped No Man's Land map (32px bottom margin, 16px frame, ~46px grid, plus the grayscale + diagonal light above).

To **extract** a level's _existing_ shipped tab map instead, `cnetool tabmap <levelDir> --extract` writes its `map<n>*` tiles, reassembled as the engine shows them, to a PNG (API: `extractTabMap` finds the four tiles in the given archives and assembles them; `assembleTabMap` does just the flip-and-place from four decoded tiles - the inverse of `sliceTabMapTiles`).

#### `leveltex.bin` / `textures.dat` - texture archives

Texture archives use a **different container** from `objects.dat`/plain archives:

- a **fixed 2048-slot TOC** (`u32 count` + `2048 × 17-byte` records, unused slots `0xCC`-padded), so blobs **always start at byte 34820** (`4 + 2048×17`), regardless of `count`;
- each blob is the engine's **internal texture format**: a standard 24/32-bit TGA with its constant **first 8 header bytes stripped** (leaving a 10-byte header `[u16 x, u16 y, u16 w, u16 h, u8 depth, u8 descriptor]` + pixels). `extractTexture` re-adds the 8 bytes on the way out (which is why extracted files are normal TGAs); `buildTextureArchive` strips them on the way in.
- **orientation:** blob pixel rows are stored **top-down**, but the descriptor byte claims a bottom-left origin (always `0x00`, or `0x08` for 32-bit - never the `0x20` top-origin bit; the engine reads rows verbatim and never consults it). This is the "vertically flipped CE format" of community lore: a descriptor-honoring viewer shows the rebuilt TGA upside-down. Verified on text-bearing entries in `textures.dat` (`PB8M0`) and `menupics.dat` (`c_main`) - **all** texture archives behave the same. `cnetool extract -p` corrects for it via `tgaToPng`'s `{topOrigin}` option, so PNG output reads correctly; the `.tga` output stays a byte-faithful raw unpack. (Loose on-disk `.tga` files - `Cutfont.tga`, the `SG_SG*` thumbnails - have truthful descriptors; `cnetool convert` handles them as-is.)

`parseArchive`/`extractEntries` read these fine (they follow the TOC offsets), but **`buildArchive` does NOT produce a loadable texture archive** - its tight TOC + raw blobs are the object/plain-archive layout. Use **`buildTextureArchive`** for `textures.dat`/`leveltex.bin`; it round-trips a shipped archive byte-for-byte (modulo `0xCC` don't-care padding).

The engine searches the three texture-archive slots by name; a name found in an earlier slot wins, so a level's `leveltex.bin` overrides the global pack (details + what each archive is for: [Texture archive lookup order](#texture-archive-lookup-order-leveltexbin-texsecdat-texturesdat)). Map tiles, the **terrain detail/"noise" overlays** (`REFSetNoiceTexture("...")`), and model textures are all loaded by name through this. (Note these are **not** indexed by a mesh face's `texId`, which indexes `objects.dat`'s own texture-name table - see [Texture references](#texture-references-texid).)

`cnetool extract <level>/leveltex.bin` recovers a level's tab-map tiles and detail textures.

**HUD atlases.** The in-game interface draws from two 8×8 sprite atlases in `24bits/textures.dat`, loaded by name by the HUD sprite drawer (`0x43f8f0`, the engine's `"ShowWeapons()"`): `INTERFC1` (256×256, 32×32 cells) and `INTERFC2` (compass ring, blips and HUD digits). Cells are addressed `col = n&7`, `row = n>>3`, top-down from the top-left: `INTERFC1` rows 0-1 are the **inventory item icons** (cell 0 = parachute, 1 = fuel tank, 6 = toolbox, 11 = key, …, assigned per project by `REFSetItemTextureNr` - see `scripts.md`), rows 2-4 the weapon/vehicle icons, and the tail from `n ≈ 36` the health/armor torso states (the drawer special-cases `n >= 36`). The 1.41 patch **hijacked cell 2** (the wrench) for the new helicopter's icon - not by editing `textures.dat` (byte-identical 1.36→1.43) but via the `texsec.dat` `INTERFC1` override, which wins the archive-precedence search and differs from the base in exactly that one cell. The only slot-2 consumer is `GLOBAL/repairk.scr` (the small repair kit, never reassigned) - but no shipped level in any version places or spawns a `repairk`, so nothing in the stock game shows the helicopter-for-wrench swap. A custom map that places one will.

**Community corroboration & cautions.** Community RE confirms CE textures are a non-standard, "vertically flipped" format and that tools (`MAPMAKER`/`mapmaker151`) convert between "raw CE" and "proper TGA" - which is exactly the internal format + V-flip above. Two things a circulating community doc gets loosely; byte-level verification shows instead: the per-entry 4-byte field is an absolute **offset**, not a "length"; and tab-map tiles load fine as **uncompressed** 24-bit TGAs (it claims RLE-only). It also omits the fixed 2048-slot TOC. (`texsec.dat` is absent from the 1.43 MP demo but present in fuller installs - ~27 textures: load screens, the helicopter texture, interface icons.)

`LIGHTS.DAT` is a header-less array of 23-byte light records, empty in most levels. Each record is:

| Offset | Field    | Type            |
| ------ | -------- | --------------- |
| 0      | range    | float32         |
| 4      | id       | uint32          |
| 8      | color    | 3 × uint8 (RGB) |
| 11     | position | 3 × float32 xyz |

The RGB triplet is packed without padding, which is why the record is 23 (not 24) bytes and the trailing floats are unaligned.

`LOADING.DAT` is a lone `uint32`.

`diacache.dat` is a generated cache of **dialogue voice-clip lengths** (writer `0x42e500`, reader `0x42e8a0`): a flat array of `uint32`. Slot `[0]` is a 16-bit **checksum** of all loaded dialogue text (`sum(char) & 0xFFFF`); slots `[1..]` give the `.WAV` playback length of each `DIALOGUE.DAT` record's clip (one per `Filename:` record - 311 in the global file, hence 312 slots), computed by a `CheckWAVLength` helper (`0x483c30`). A `0` means that record's `.WAV` was absent when the cache was built. On load the engine re-checksums the dialogue text and regenerates the cache on mismatch - so it's a derived file, not authored data. (The values are audio durations, not offsets or indices into `DIALOGUE.DAT`.)

`menuinfo.dat` is the **saved player profile / options / progress** (reader `0x46d990`, writer `0x46db70`), stored zlib-compressed under two layers of a keyed byte-add cipher:

```
u32  uncompressedSize
u32  compressedSize          (file size = 8 + compressedSize)
u8[compressedSize] body      body[i] -= KEY1[i % len(KEY1)], then zlib-inflate,
                             then out[i] -= KEY2[i % len(KEY2)]
```

`KEY1` and `KEY2` are two fixed ASCII passphrases baked verbatim into `ce.exe` (at file offset `0xc8f18` / `0xc8f9c` in the 1.36 build) - and they're a developer joke: the keys themselves are taunts aimed at anyone cracking the file.

```
KEY1 (126 chars, applied to the compressed body):
  "You really shouldn't be messing about with this file, you should be playing the
   game. You will find nothing in here you know ;-)"
KEY2 (69 chars, applied to the inflated payload):
  "Didn't you read the first message? I promise there is nothing in here."
```

These are confirmed as the real keys, not a paraphrase: they appear byte-for-byte in the binary, and the decode is self-verifying - subtracting these exact sequences is what yields a valid zlib stream and then readable text, so a single wrong byte would make inflation fail. (Note this is a different scheme from the per-byte `+0x78` cipher of `data3.bin`/`data4.bin`.)

The decoded payload is three fixed **272-byte blocks**, each a `char name[16]` tag followed by a 256-byte struct (MSVC `0xCC` fill marks fields never written):

| Block         | Holds                                                                                                                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PlayInfo`    | Multiplayer identity + match setup + last-session state: net protocol, last-connected server IP, host + player names, team, game mode, max players, last level, and the last savegame slot. Full field map below. |
| `LevelsDone`  | Campaign progress - a per-level completion array (all-zero in a fresh profile).                                                                                                                                   |
| `OptionsMenu` | Audio/video settings: soundfx + music volumes, sound channels, detail, graphicFX, renderer, resolution + colour depth, language, subtitles. Full field map below.                                                 |

So it's the menu's persisted **profile + progress + options** - the only genuinely authored-by-play file in this group. The block framing (`name[16]` + 256-byte blob) is byte-confirmed across versions. Offsets below are **block-relative** (the 16-byte tag is `0x00-0x0f`; the 256-byte struct body starts at `0x10`).

**`PlayInfo` fields:**

| Offset | Field              | Type       | Notes                                                                            |
| ------ | ------------------ | ---------- | -------------------------------------------------------------------------------- |
| `0x10` | last level         | `u8`       | last-played SP campaign number, or MP map (`≥128`)                               |
| `0x11` | multiplayer flag   | `u8`       | `1` = last level was multiplayer, `0` = single-player                            |
| `0x13` | max players        | `u8`       |                                                                                  |
| `0x15` | network protocol   | `u8`       | `1` = TCP/IP, `0` = IPX                                                          |
| `0x16` | last server IP     | `4 × u8`   | dotted-quad octets of the last-joined server (the port is **not** stored here)   |
| `0x1a` | host / server name | `char[40]` | NUL-terminated, default `"Unnamed"`                                              |
| `0x42` | player name        | `char[20]` | NUL-terminated, default `"RED"`; the host truncates it to 10 chars over the wire |
| `0x57` | game mode          | `u8`       | `0` = deathmatch, `1` = ctf, `2` = teamplay                                      |
| `0x58` | savegame slot      | `u16`      | `0xffff` = none, `0xfffe` = `temp.dat`, `N` = `sg<N>.dat`                        |
| `0x5a` | team               | `u16`      | `0` = red, `1` = blue, `2` = auto (see note)                                     |

`0x12` and `0x14` are `0` in every captured file (undetermined - likely reserved). **Team `2` ("auto") is a directive, not a stored state:** hosting with auto assigns a concrete team and persists _that_, so a saved file only ever holds `0`/`1`.

**`OptionsMenu` fields:**

| Offset | Field          | Type  | Notes                                                                          |
| ------ | -------------- | ----- | ------------------------------------------------------------------------------ |
| `0x10` | soundfx volume | `u8`  | `0-255`                                                                        |
| `0x11` | music volume   | `u8`  | `0-255`                                                                        |
| `0x12` | sound channels | `u8`  | literal count: `4` / `8` / `16`                                                |
| `0x13` | detail         | `u8`  | `0` = low, `128` = medium, `255` = max                                         |
| `0x14` | graphicFX      | `u8`  | `0` = none, `128` = medium, `255` = max                                        |
| `0x15` | renderer       | `u8`  | `0` = 3dfx/Glide, `1` = Direct3D, `2` = software                               |
| `0x16` | screen width   | `u16` | changing the renderer rewrites the whole resolution triple                     |
| `0x18` | screen height  | `u16` |                                                                                |
| `0x1a` | colour depth   | `u8`  | bits per pixel (`16` / `32`)                                                   |
| `0x1d` | language       | `u8`  | EFIGS: `1` = English, `2` = Spanish, `3` = Italian, `4` = French, `5` = German |
| `0x21` | subtitles      | `u8`  | `1` = on, `0` = off                                                            |

The bytes at `0x1c`/`0x1e`/`0x1f`/`0x20` feed the engine's mode-change detector (they trigger a renderer reinit when they differ from the live mode) and are `~0` in captures.

Most of these are confirmed two ways: the `+hostname`/`+name`/`+map`/`+game`/`+team`/`+connect` command-line flags (`FUN_004426a0`) write straight into the `PlayInfo` struct (the block loads to `0x557500`), the default-init (`FUN_0043fef0`) seeds `"Unnamed"`/`"RED"`, and the values were cross-checked by editing each in-game and diffing the re-encoded file. The language enum comes from the localized-cutscene switch (`m1c4sp/it/fr/ty.smk`; `ty` = _Tyska_, Swedish for German). `cnetool`'s `parseMenuInfo`/`formatMenuInfo` (and the `menuinfo` CLI command) read and rewrite these fields; `parseMatrix`/`parseLights` decode the two structured blocks (see the README).

`servinfo.dat` is the **host's multiplayer match settings**: a header-less run of **4 × `uint32`** (little-endian), exactly 16 bytes. It is read and written only by the game **host** - both the loader (`FUN_004735c0` @ `0x4735c0`, `fopen(…,"rb")`) and the saver (`FUN_00473650` @ `0x473650`, `fopen(…,"wb")`) are gated on `FUN_00441560() != 0` (is-host) **and** the game-mode flag `DAT_004de78c & 1` (set in the deathmatch/team MP modes). On load the host reads the four values back into its match-state globals and calls `FUN_00473a60` to broadcast the limits to connected clients; on save it writes them straight back out.

| Offset | Type   | Field      | Meaning                                                                           |
| ------ | ------ | ---------- | --------------------------------------------------------------------------------- |
| 0      | uint32 | fraglimit  | Kill limit (server message "Server set fraglimit to %d")                          |
| 4      | uint32 | scorelimit | Score limit ("Server set scorelimit to %d")                                       |
| 8      | uint32 | timelimit  | Time limit in **minutes** ("Server set timelimit to %d minutes")                  |
| 12     | uint32 | nextmap    | Map-rotation target: the **level number** to load when the round ends (see below) |

The field meanings are decoded from the server-command handler `FUN_00473950` (cases 0/1/2 = frag/score/time), the limit broadcaster `FUN_00473a60`, and the `nextmap` command handler `FUN_00476c50`. The fourth field is the server's **map rotation** ("nextmap") setting, a level number for the `LEVELS.NFO` index (resolved via `FUN_00442560`):

- `0` = **rotation off** ("Nextmap mode off") - the host stays on the current map.
- non-zero = the next level to switch to (`FUN_00476c50` sets it to `currentLevel + 1`, printing `Nextmap is "%s"`). When the round's time limit expires the host loads that level and then **advances** the value to the following level; if the next number isn't found in `LEVELS.NFO` it **wraps to `0x80` (128)** - No Man's Land / `dm1`, the base multiplayer map (`FUN_0047a880` @ `0x47a880`).

**Every shipped copy is 16 zero bytes** - identical byte-for-byte across all versions on hand (1.41, 1.43, 1.50 and the MP demos), because the host only writes non-zero values after limits/rotation are configured for a hosted session; all-zero means "no limits, rotation off". It is not an archive and shares no structure with the `Key:Value` text family - just a fixed 16-byte settings blob.

**Persistence (it survives restarts).** The file is a save/restore store, not a per-session scratchpad. The host **loads** it during multiplayer session init (`FUN_0047ae60` @ `0x47ae60`, the routine that also zeroes the player table) - which re-applies and re-broadcasts the four fields - and **saves** it during session teardown (`FUN_0047aef0` @ `0x47aef0`). So settings configured once persist to the next host start; they are not reset each time. A dedicated server can therefore be pre-seeded by writing the 16 bytes directly (eg `1E 00 00 00` timelimit = 30 min, `81 00 00 00` nextmap = 129) - the loader applies them on every host start without any console input. (A clean exit rewrites the file with the current runtime values, including the advanced `nextmap`; a crash simply leaves the pre-seeded file intact.)

**Configured via host console commands** (all host-only, parsed in `FUN_00496800`-based dispatch): `fraglimit %d`, `scorelimit %d`, `timelimit %d`, `map <name>` (switch now), and `nextmap on` / `nextmap off` (enable/disable rotation; `on` sets the pointer to `currentLevel + 1`).

**Map changes travel by name, not number.** When the host switches map (rotation or `map <name>`) it resolves the level number to a **name** via its own `LEVELS.NFO`, then broadcasts that name string to clients as network message type `0x3b` (`FUN_00473bc0`). Each client resolves the name back to a number against **its own** `LEVELS.NFO` (`FUN_00442480`, case-insensitive), so mismatched numbering between machines is fine as long as the display names match - but nothing checks that the map _content_ behind a shared name is identical, and CE multiplayer is host-authoritative, so a name collision with different content silently desyncs geometry. See [`LEVELS.NFO`](#levelsnfo---level-index).

**Tooling.** `cnetool`'s `parseServerInfo` / `formatServerInfo` read and write the 16-byte blob, and the `cnetool servinfo` command reads or edits it (resolving a `--nextmap` name through `LEVELS.NFO` via `parseLevelIndex`). See the README.

## Other data files (`.bin`, `.nfo`)

Besides the `.dat` files there are several `.bin` / `.nfo` data files.

### `LEVELS.NFO` - level index

Plain `Key:Value` text mapping campaign/level display names to their numeric ids, which are the `LEVEL<n>/` folder numbers:

```
Name:The village fool Val:1
…
Name:Eagle's Flight Val:12
Name:No mans land Val:128      (128-132 are the bonus/multiplayer maps)
```

Each line carries **two** keys (`Name:` and `Val:`), so the generic `parseConfig` (which splits on the first `:`) doesn't apply - read it with `cnetool`'s dedicated `parseLevelIndex` (→ `{name, number}[]`) / `formatLevelIndex`. The numbering has gaps and is not strictly ordered (Fever valley is `248`, Fortress `133`), which matters for rotation: the host's auto-advance is `currentLevel + 1` and wraps to `128` at the first missing number, so on the shipped index it cycles `128→129→130→131→132→133→128` and never reaches `248`. See [`servinfo.dat`](#other-dat-files-not-archives) for the rotation and the name-based map-change protocol.

### `data3.bin`, `data4.bin` - obfuscated stat tables

The game's balance tables, stored as `Key:Value` text **obfuscated by adding `0x78` to every byte** (decode by subtracting it; see `deobfuscate`).

Read/write them with the dedicated `stattable` helpers, which understand the 127-byte-slot layout below: `parseStatTable(bytes)` returns one located field per slot (`{key, value, chunk}`); `groupRecords(fields, 'Name')` splits those into records (a weapon's class index = its record position); `setStatValue(bytes, chunk, value)` / `setStatField(bytes, chunk, key, value)` rewrite one field's value in place (chunk-sized, other slots preserved byte-for-byte - the engine `sscanf`s the text so any length that fits works); `formatStatTable(fields)` rebuilds a whole table. (For a quick read-only pass you can still use `parseConfig`'s `scan` mode, which just matches `Key:Value` pairs and skips the non-text bytes, but it carries no slot positions and can't write.)

**Layout - fixed 127-byte field slots.** After deobfuscation the file is a packed array of **127-byte slots**, one per field. A slot holds its `Key:Value\n` text at the front, then a **constant filler template** to pad it to 127 bytes (the same byte pattern in every slot, including a recurring `Vk.` sentinel at slot offset 68). The filler is _not_ per-record data: across all records, a slot's bytes past the text are byte-for-byte identical - the only bytes that vary between records are the `Key:Value` text itself. So the stats are entirely the text values; there are no hidden binary numeric fields. A record is a fixed run of slots (`data3`/`mdata3` = 4 slots = 508 bytes; `data4` = 102 slots, `mdata4` = 116, each an exact multiple of 127).

- `data3.bin` - **56 unit/entity records**: `Name`, `Armor`, `Health`, `Firedelay` (eg `airplane` → Light / 75 / 2). Names: `airplane`, `tank`, `vakt1`… (`vakt` = Swedish "guard"), `gasguard`, `sailor`, etc.
- `data4.bin` - weapon records: `Name`, `Damage`, `AmmoSpeed`, `FireDelay`, `AmmoType`, `WeaponLength`, `Sound`, plus damage-vs-armor tables (`gas`/`bullet`/`shell`). The `Sound:` values reference the `SOUNDS/` tree (eg `Sounds\FX\WFiFire.WAV`).
- `mdata3.bin` / `mdata4.bin` (**multiplayer patches**, 1.33+) - the MP counterparts. `mdata3` holds the 16 player-controllable `my_*` units (`my_tank`, `my_plane`, and 1.41's new `my_car2`, `my_plane3`, `my_plane4`); `mdata4` the MP weapon set.

The `data4`/`mdata4` **weapon classes** in record order - the class index is what scripts set via `REFSetProjectVars(MYSELF, WEAPON_TYPE, n)`, and `FireDelay` (seconds) is loaded into the holder's `+0x6c` as ticks (see `game-flow.md` § The fire pipeline). 1.43 values, SP (`data4`) / MP (`mdata4`):

| Class | Name                         | FireDelay SP/MP | AmmoSpeed SP/MP |
| ----- | ---------------------------- | --------------- | --------------- |
| 0     | GUN (MP: DUMMY)              | 1 / 1           | 75 / 100        |
| 1     | RIFLE                        | 1 / 1           | 100 / 125       |
| 2     | SNIPERRIFLE                  | 2 / 2           | 500 / 500       |
| 3     | MACHINEGUN                   | 0.125 / 0.125   | 45 / 100        |
| 4     | GRENADE                      | 1.5 / 2         | 4.5 / 6         |
| 5     | ROCKETLAUNCHER               | 2 / 2           | 20 / 30         |
| 6     | FLAMETHROWER                 | 0 / 0           | 10 / 10         |
| 7     | GASWEAPON                    | 2 / 2           | 5 / 5           |
| 8     | BOMB                         | 4 / 4           | 5 / 5           |
| 9     | MOUNTED_MACHINEGUN           | 0.125 / 0.125   | 200 / 150       |
| 10    | MOUNTED_LIGHT_CANNON         | 2 / 2           | 30 / 30         |
| 11    | MOUNTED_HEAVY_CANNON         | 2 / 5           | 30 / 30         |
| 12    | GUN (pistol)                 | 0.35 / 0.35     | 60 / 100        |
| 13    | EXPPACK                      | 4 / 3           | 1.5 / 1.5       |
| 14    | - / ROCKETLAUNCHER (heli)    | - / 0.75        | - / 30          |
| 15    | - / MOUNTED_LIGHT_MACHINEGUN | - / 0.125       | - / 150         |

Classes 14/15 exist only in `mdata4` (stock SP `data4` has 14 records - the source of the undefined-class-15 SP turret). Note the slot-7 pairing: the explosive stick is class 13, while its detonator (the `Detonat` project) is class **4**, the grenade class.

The cipher, the text schema, and the 127-byte-slot layout are confirmed; there is no remaining undecoded binary payload.

### Per-level `data1.bin` - object placements

`data1.bin` is the level's object-placement list: a packed array of fixed **80-byte records**, each placing one object instance on the map.

```
byte 0..27   name field        NUL-terminated instance name (eg "aagun3_03")
byte 28..31  class pointer      a constant baked vtable pointer (record marker)
byte 32..43  position           3 × float32 (world x, y, z)
byte 44..79  rotation           3 × 3 float32, row-major - rows are [Dof, Up, Right]
```

The instance name's `objects.dat` project is its base name with the trailing `_NN` removed (`aagun3_03` → `aagun3`, `Tree1_48` → `Tree1`); some names are camera/markers (`Redstart`) with no mesh. Positions land within the level terrain's bounding box and the rotation matrices are orthonormal (mostly yaw), confirming the layout. `data1.bin` is the binary twin of the text [`World.dat`](#per-level-worlddat---text-object-placements) - for the same level both hold the same placements in the same coordinate space (spot-checked on `LEVEL128`: shared objects match to <0.1 unit; the few that drift are editor-vs-shipped snapshot differences, not a transform). `cnetool`'s `parsePlacements` reads this, `serializePlacements` writes it (round-trips exactly through `parsePlacements`), and `cnetool level` assembles terrain + placed objects into one OBJ. The record `marker` is a **stale pointer the engine never reads** - it varies between levels (`0` in some, e.g. `Level6`) and even **within** a file: the unofficial 1.42 patch appended its `sebguard` records to `LEVEL130`/`LEVEL131`'s `data1.bin` with a marker that differs from the rest of the file. `parsePlacements` therefore ignores it (records are validated by their name field instead) and writes `0` by default.

**The three matrix rows are the object's orientation basis vectors** - row 0 = `Dof` (direction of forward / facing), row 1 = `Up`, row 2 = `Right` - as spelled out by `World.dat` (which writes them under exactly those labels). So the matrix isn't opaque: it's `[forward; up; right]`.

**Applying the transform (important for engine use).** The 3×3 matrix follows the engine's DirectX **row-vector** convention: a model vertex is transformed as `world = vertex · M` (i.e. multiply by the matrix's _columns_), then translated by `position`. Applying it the other way (`M · vertex`, by rows) leaves symmetric rotations - identity, 180° - looking correct but flips the direction of 90°/270° (and other asymmetric) rotations. The model vertices in `objects.dat` are in the same coordinate space as positions: X/Z is the ground plane and **−Y is up** (the vertical axis points down; confirmed because models import upside-down into Y-up viewers and a Y-flip rights them), in world units (a level spans tens of thousands of units). Wavefront OBJ shares this row/column expectation, so `transformMesh` applies `v · M` directly. `cnetool`'s OBJ serializers flip to an upright **Y-up** by default (`up: 'z'` for Z-up, `'raw'` to keep the native −Y-up); see `orientMesh`.

### Per-level `World.dat` - text object placements

`World.dat` is the engine's **human-readable level-placement format** - the text twin of `data1.bin`. The shipped engine loads it (`ce.exe` opens `LEVEL%d\World.DAT`). It ships for the multiplayer levels (`LEVEL128`+); single-player levels carry only `data1.bin`. Each object is a block:

```
Name:tank_01
Translation: -3162.09,-9.48,3790.53     ← world position (x, y, z)
Dof:   0.0 0.0 -1.0                       ← direction of forward (facing)
Up:    0.0 1.0  0.0
Right: 1.0 0.0  0.0
```

The block keyword is `Name` for a live object or **`Dele` for a deleted one**; both carry the same `Translation`/`Dof`/`Up`/`Right` body. `Translation` is the position; `Dof`/`Up`/ `Right` are the orientation - the same three rows as `data1.bin`'s rotation matrix (verified identical per-instance), so they map onto the same 9-value `rotation`. Shipped 1.41 multiplayer levels mix both (eg `LEVEL129` 688 `Name` + 9 `Dele`, `Level133` 743 + 208).

**`Dele:` semantics - confirmed.** The engine's loader (`FUN_004514b0`, `0x4514b0`) reads _every_ block (so the stream stays in sync), then `memcmp`s the 4-char tag against `"Dele"` (`FUN_00496800` returns 0 on match): a block is spawned **and** written to `data1.bin` only when the tag is **not** `"Dele"`. A `Dele:` block is therefore **skipped** - its object is neither instantiated nor written. It is a **tombstone**: the in-game editor keeps a removed object's block in the text file (so it can list/restore it), and the engine ignores those at load. There is no separate "base placement" list that `Dele` overrides - `World.dat` is the authoritative source.

This also explains the `World.dat`↔`data1.bin` relationship: when `World.dat` is present the loader opens it as text (`"rt"`), and **regenerates `data1.bin`** (`"wb"`) from the non-`Dele` entries as it goes; `data1.bin` (binary, `"rb"`) is only read as a **fallback** when `World.dat` is absent. So `data1.bin` is just `World.dat`'s binary cache minus the tombstones - which is exactly why it has no delete concept, and why `cnetool world` correctly drops `Dele` when writing it. (`cnetool level` reads `data1.bin` first and falls back to `World.dat`; the engine does the reverse, but the two are equivalent apart from the `Dele` tombstones.)

`cnetool`'s `parseWorld` returns these as `WorldEntry[]` (a `Placement` plus its `kind`), usable directly with `transformMesh`/`assembleLevel`; `formatWorld` writes them back. The game's own built-in level editor reads and writes this file, and the engine loads it - so editing it (by hand or via `formatWorld`) is the path to authoring/modifying levels. `cnetool level --world` sources placements from it (and falls back to it automatically when `data1.bin` is absent).

**`cnetool world <input> [output]`** converts between the two formats (direction auto-detected): `data1.bin → World.dat` (binary → editable text, to stdout by default) and `World.dat → data1.bin` (text → binary). Since `data1.bin` has no delete directive, `Dele` entries are dropped (with a count) when converting to it; the round trip `World.dat → data1.bin → World.dat` is value-identical.

#### Per-level `data2.bin` - AI entities + patrol routes

`data2.bin` is the level's **AI entity + route table** (decoded; loader `FUN_0042a820`, logged `AddAIFromFile: %s`). It's not the vehicle list and has no global header - the `g_plane…` text at the start of the file is just the first record's name. It's a packed array of variable-length records read until EOF, each an AI entity plus its waypoint list:

```
record:
  char[20]  name          NUL-terminated, "<mode>_<entity>_<radius>_<index>"
  i32       routeCount
  waypoint[routeCount]    40 bytes each
waypoint (40 bytes = 10 × f32):
  [0]      param          per-waypoint scalar (speed/wait; usually 0)
  [1..3]   x, y, z         world position (Y = vertical), same space as data1.bin
  [4..9]   extra           orientation/target params (often 0)
```

The `name`'s first token is the **mode** (`g_` stationary guard - usually 2 waypoints = position+facing; `p_` patrol; `s_` scripted/sentry - matched against four engine strings → mode 2/4/8/0x10); the third-from-last token is an engagement **radius** (round values 100/500/1000…). Entity names cross-reference `data1.bin` placements (`g_aagun3_*` ↔ `aagun3_*`). The layout consumes every byte across all sampled levels (0 trailing); not every level has one (`LEVEL128` has none). Exact meaning of waypoint fields `[0]` and `[4..9]` is inferred from value patterns (the loader only logs the XYZ).

The `*cache.bin` files per level (`acache`, `texcache`, `ocache`, `scrcache`, `scache`, `wcache`, `faccache`) are engine-generated dependency/preload indices - animations, textures, objects, scripts, sounds, and precomputed land/water adjacency - bulk-loaded at level start and regenerated at runtime, not authored data. All are decoded; see [the cache-file family](#cache-files-cachebin) for per-file layouts.

#### Save games (`GAME*.SAV`)

A level-state checkpoint sitting in the level dir (eg `LEVEL12/GAME1.SAV`), an uncompressed little-endian dump of the live world in the format of the engine's save system (writer `SaveGame` `0x47c030`, reader `LoadGame` `0x47c270`). These files are **development leftovers shipped on the CD**, not part of the retail save flow: no engine binary (1.33-1.43, plus the 1.0 stub) contains a `.SAV` filename string, no data file in the install references the names, and every one has `frame = 1` (saved right at level start). The retail engine's own saves are `sg<n>.dat` (menu slots) and `temp.dat` (level-start restart save), built from the `"sg%d.dat"` format string at `0x4c2890` and passed to the same `SaveGame`/`LoadGame` pair - which is why `GAME*.SAV` byte-matches that format. Header:

```
i32  level_id     // engine level number; LoadGame aborts if it != the running level's id
i32  frame        // sim tick at save time (1 in a level-start/pristine save)
```

After the header comes a front section of subsystem state (geometry, lighting, sound, camera, object↔object bindings - `SaveAllBindings`), then the project/object stream (`SaveProjects` `0x47b730`): a sequence of tagged records - `u8 tag` where `0` = empty slot (`i32 dataIndex, u16 projIndex`), `1` = live object (full record via `0x47b0b0`: `i32 dataIndex, u16 projIndex, char name[32], i32 type`, six 40-byte transform blocks with world position at byte `+0xd0`, then flag/state scalars and parent/child links, the per-object script-timer block, and the main-mesh blob), `2` = end-of-list. The `name[32]` fields are the level's live entities and read out cleanly (`vakt1`, `aagun3`, `plane.4`, `batlship.1`, …), which is what confirms the record stride.

The header and overall sectioning are confirmed (engine code + byte-matched across the clean saves); the exact semantics of the transform/scalar bytes inside a record are inferred from the decompile, not labelled per byte. Caveat: a few saves in the 1.0 tree (`Level4`, `LEVEL9`) have a non-matching first dword and a `frame` that reads as float `1.0` - a different/older save variant, out of scope. `REPLAY.SAV` / `CAMERA.SAV` (level1/level2 only) are separate formats, equally unreferenced by the retail binaries - presumably from the same in-house tooling - and not covered here.

### Enterable vehicles & turrets (why they're "missing" from a level export)

The enterable/dynamic objects - AA turrets, planes, tanks, cars, trucks - **are** placed by `data1.bin` like everything else (`tank_NN`, `plane_NN`, `car_NN`, `truck_NN`, `aagun3_NN`, …). They look missing from an assembled-level OBJ because their _logical_ project in `objects.dat` is an **empty stub** (`nv = 0`, no faces): `tank`, `tank2`, `plane`, `plane2`, `car`, `truck`, `aagun3`, `aibird` all parse to zero-geometry meshes, so `cnetool level` places them with the correct position and rotation but emits nothing visible. (`snipegun` is the exception - it carries its own mesh and does render.)

The visible geometry exists under **separate, often multi-part project names**, and the engine's vehicle subsystem assembles it at runtime. The correct assemblies (not the obvious name matches - see the warning below):

- **Tank** (the steampunk "steam tank") - `STBody` + `STTower` + `STBandL` + `STBandR` (+ `STShadow`, `STPipe`). `LARVBAND` (Swedish "caterpillar track") is the tread texture. `TankPjb`/`Tankjb` are _not_ the tank - they're the flamethrower pipe (textured `PIPEJB.TGA`).
- **Second tank** - `tBody` + `tTurret` + `tCan` + `tLeft` + `tRight`
- **Plane** - `AirPlan` (+ `AirRhB`). The `plane*`/`Plane2` projects are empty stubs; `PlaneSH`/`Plane2sh` are only shadows.
- **Car** - `rcbody` (the `CARNEW` armored car; `car2` placements swap the skin to `Carnew2`, see [Vehicle alt-skins](#vehicle-alt-skins-car2-plane2-and-the-2-textures))
  - `Car2Tur` turret + `Car2Hol` mantlet + `Car2Can` twin barrels + `Car2Whe` ×4 (NOT `RCWheel` - those are invisible entry/steer markers). `Merc` is the single-player Mercedes.
- **Motorcycle** (with sidecar) - `motobody` + `mcwhlrg` + `mcwhsml` (+ `mcsh` shadow)
- **Truck** - `BdyTruck` + `TWBack` + `TWFront`
- **AA turret** - `AABox` + `AALegs` + `AASheld` + `AACanon`
- **Helicopter / zeppelin / battleships** (MP patches, in `OBJECTS2.DAT`) - `HeliBody` + `HeliRBla` + `HeliTBla`; `zeppe`; `aship` / `bship`

(A `sh`/`SH`/`Shadow` suffix is the shadow mesh; `jb`/`Pjb`/`Hjb`/`Ljb` are body/LOD variants of the flamethrower attachment, not the tank.)

**The logical → model mapping lives in `ce.exe`.** The exe has an **entity-type-name registry** (a contiguous `char* typeNames[]` array in `.data`: `plane`, `car`, `tank`, `heli`, … `TANK2`, `MOTORCYCLE`, `BATTLESHIPA`) and, at **~`0x43c050`**, a `strcmp` chain that resolves a type name to its **body project**, writing one name into a buffer:

```
if   (strcmp(type,"tank")==0)  model = "StBody";   // steam tank
else if (strcmp(type,"car")==0)   model = "rcbody";
else if (strcmp(type,"truck")==0) model = "BdyTruck";
else if (strcmp(type,"tank2")==0) model = "tBody";
…  motocycle→motobody, torpboat→torpb, zeppelin→zeppe,
   aagun3/gggun→AALegs, battleshipa→aship, battleshipg→bship
```

This is authoritative for the body. The chain is stale for aircraft - it maps `plane→kropp` (the pilot body) and `Helicopter→AirPlan` - so for those the actual meshes (`AirPlan`, `HeliBody`) are used instead. None of this is in `data1.bin` (only the empty logical name is placed), `data2.bin`, or the scripts (a vehicle's `.scr`, eg `aagun3.scr`, only carries AI).

#### How a vehicle is assembled at runtime

Each vehicle is a **class byte**. A single constructor dispatcher, `FUN_0044d480` (`0x44d480`), switches on that byte to a **per-class setup function** which builds the whole vehicle from mesh projects with the same three calls per part. (`FUN_0044d370` is _not_ the dispatcher - it's the `TARGET`/siren setup for class `0x1a`, one of the leaves `FUN_0044d480` calls.) Each setup uses the same three calls per part:

- `FUN_0047ed20("Project", 1)`: instantiate a mesh project by name (returns an object index)
- `FUN_0046bf90(obj, x, y, z)`: set its **body-local position** (relative to the vehicle root the dispatcher was handed)
- `FUN_0047fab0(root, obj)`: **attach** it as a child of the vehicle root (`FUN_0047f750` then links render/sibling order)

That triplet is the entire assembly, and it is what `cnetool`'s `controllableGeometry` (in `src/api/controllable.ts`) transcribes: the offsets were read straight off the `FUN_0046bf90` calls. Setup functions of note: helicopter = class `0x3c` / `FUN_0040a120` (`HeliBody` + `HeliTBla`×3 + `HeliRBla` + `AirWfl`×3); plane = class `0x3a`/`0x28` / `FUN_0040f090` (`AirPlan` + `AirProp`×2 + `AirRhB` + `AirRfL`/`AirRfR` + `AirRbak` + `AirWfl`×3).

**Class ↔ name.** The authoritative map from a type char to its spawn/placement name is the pointer array at **`0x4cda60`, indexed by the class byte** (`0x24 = CIVIL`, `0x28 = PLANE2`, `0x39 = PLANE3`, `0x3a = PLANE4`, `0x3b = PLANETUR`, `0x3c = HELICOPTER`, …). Read it (a `char*[]`) to identify which class a placement name maps to, and thus which setup function builds it. This is how the four `plane*` were pinned to two airframes: the class dispatcher routes `0x28`/`0x3a` to `FUN_0040f090` (the `AirPlan` monoplane, base `plane2` / alt `plane4`) and `0`/`0x39` to `FUN_0040dbb0` (the `kropp` SE5 biplane, base `plane` / alt `plane3`). So the placement name alone doesn't tell you the model; the class does. (A separate strcmp chain at `~0x43c050` maps type _name_ → body _project_, but it's stale for aircraft; the class → setup-function route above is authoritative.)

#### The extra gunner turret is a separate, multiplayer-only object

Some vehicles (the plane/helicopter belly gun, the zeppelin gondola gun) show a second manned position **another player** controls. That gun is **not part of the vehicle's mesh assembly** and **not in the level placements or the vehicle's script**. It is its own controllable class, built by its own setup function:

- The belly gun is class `0x3b` / `FUN_0040fd80` = `BPTur`×2 + `Car2Hol`.
- The zeppelin gun is the standalone `ZeppeGun` (cnetool models it as the `zeppegun` controllable).

It is spawned **by the engine, per player, only in multiplayer**. On map load, `FUN_00441c30` spawns it only when `DAT_005519f0 != 0` (multiplayer), the map is `>= 128` (an MP map), **and `DAT_00554f00 > 1` (more than one player)**: `FUN_00473bc0` then loops the player slots and, for each, `FUN_00472410` sends a DirectPlay "create class `0x3b` named `<name>`" message. **This is why a single-player plane/helicopter has no belly seat** (one player, the loop never runs), while the motorcycle's sidecar always renders (its wheels/body are real parts in the class `ctor`, not a separate spawned controllable).

Placement note: the spawn is **not coordinate-parameterized**. The DirectPlay message carries only `(slot, class, name)`, no position; the turret's world position is assigned at construction relative to its vehicle. And unlike the other vehicles, the belly gun's visible layout is **not** recoverable from its `FUN_0046bf90` offsets. Those are only _init_ values: the two `Car2Can` barrels and the first `BPTur` each carry a per-frame update/aim handler (`LAB_0040fb00`/`LAB_0040fb40`/ `LAB_0040faf0`) that repositions them, the whole turret is rotated 180 deg, and in-game the first `BPTur` and the `Car2Hol` mantlet are hidden (the `Car2Hol` is reused only for the armored car's turret/aim logic). So it is a genuine "hack" turret: reproducing it faithfully needs the handler math or in-game measurement, not a transcription of the constructor offsets. `controllableGeometry` therefore omits it (the barrels' rendered spread reaches the `BPTur` ring edge at ~±4.4 X, nothing like the ~±1 init).

#### Vehicle alt-skins (`car2`, `plane2`+, and the `*2` textures)

Some vehicles exist as **two spawnable variants that differ only in texture**: `car`/`car2` (armored car) and the plane family. The variant is picked by the **placement name** in `data1.bin`: the meshes are identical, and no script is involved. The MP maps mix them (Breakpoint places 5× `car` + 5× `car2`, one variant per side; The Palace 4+4, The Airbase 2+2; No mans land places only `car`), which is why the armored car looks different between maps and within a map.

Mechanism (recovered from the armored-car setup `FUN_00404550` @ `0x404550`): the setup receives the vehicle **type char** and, for the alt variant (`car2` = `0x1f`), calls a texture-rewrite helper `FUN_0044d0e0` @ `0x44d0e0` with a hardcoded name-pair table. The helper loads both textures of each pair and rewrites every face of the assembled model whose texture pointer matches the first name to point at the second: a face-level swap of the loaded surfaces, same idea as the script builtin `REFReplaceTextures` but baked into the engine:

- **car** @ `0x4a40e0`: `Carnew.tga → Carnew2.tga`. Swap flag `= (type == 0x1f)`, so only `car2` gets it; `car` is base.
- **plane (AirPlan airframe)** @ `0x4ae960` (7 pairs): `aireng`, `airbot`, `airpbjbe→airpbjb2`, `airpbot`, `feng`, `wing`, `wingljb` (each `X.tga → X2.tga`), in `FUN_0040f090`. Swap flag `= (type == 0x3a)`.

The vehicle **class → placement name** table (`0x4cda60`, indexed by type char) pins the variants. The four `plane*` are **two airframes**, interleaved:

- `plane` (class 0) and `plane3` (`0x39 = PLANE3`) are the **SE5 biplane** (`kropp` body + `Se5*` parts, built by `FUN_0040dbb0`); `plane3` is the alt (2-pair swap `Siml → Siml2`, table `0x4ae8ec`). `kropp` is the biplane fuselage+wings, not "the pilot body" as the type resolver's stale label implied.
- `plane2` (`0x28 = PLANE2`) and `plane4` (`0x3a = PLANE4`) are the **AirPlan monoplane** (`FUN_0040f090`); `plane4` is the alt (7-pair swap). `car2` is `0x1f`.

`controllableGeometry` maps them accordingly (`plane`/`plane3` → `SE5_PARTS`, `plane2`/`plane4` → `PLANE_PARTS`), so all four export as visibly distinct models/skins.

The `*2` textures are not referenced by any mesh's `texId` table - they only exist as targets of these swap tables, and they ship in `texsec.dat` (see [Texture archive lookup order](#texture-archive-lookup-order-leveltexbin-texsecdat-texturesdat)). The base skin is olive green with an eagle emblem; the `2` skin is grey steel with camo patches and no emblem. A level's generated `texcache.bin` lists the `*2` names on exactly the maps that place the alt variants.

`cnetool` reproduces the swap: `controllableSkins` (in `src/api/controllable.ts`) maps a variant key to the name pairs, and `createTextureResolver`'s `skin` argument applies them, so `cnetool object car2` / `plane4` show the alt skin. `car`/`plane2` stay base; `plane`/`plane3` are also left base (the `Siml` swap is not yet applied).

#### How part placement works (and how to recover it)

A vehicle's sub-parts (turret, tracks, wheels, barrels, rotors) are positioned by a **per-vehicle setup function** in `ce.exe` - one per vehicle (steam tank ~`0x41a1dd`, armored car ~`0x404569`, motorcycle ~`0x40c070`, helicopter ~`0x40a14d`). For each part it creates the sub-object and calls **`SetPosition` (`0x46bf90`)** with a position.

**Placement is two-tier.** Getting a part right means knowing which tier it's in:

1. **Static, body-local offset.** `SetPosition` is `__thiscall` - `this` (the object) in `ecx`, three floats `(x, y, z)` on the stack - and it writes the part's world position to `[obj+0xd0/d4/d8]`. The body itself is placed _at_ its own position with **no offset**, so the value passed for every part is `body_position + delta`, and **`delta` is the body-local offset** to recover. `−Y` is up, `+Z` is forward. This is exact and authoritative for **fixed** parts: body, turret, gun mantlet, tracks, the car's wheels, landing gear.
2. **Runtime articulation, layered on top.** Some parts move every frame: wheels (suspension), rotors (spin), gun barrels (aim/elevation). These carry a **per-frame update-function pointer** written to **`[obj+0x310]`** during setup (e.g. the car's `Car2Can` gets `[obj+0x310] = 0x4040a0`). For an articulated part the static `SetPosition` offset is just an **init value, not the visual rest position** - so a static export must seat it at its rest pose from _geometry_, not the setup constant: the rotor **hub on the mast tip** (HeliBody's topmost vertex), the **barrel emerging from the mantlet**, the wheel **at the hub**. (Trusting the literal setup offset puts the car cannon out by the front wheels and the rotor off to one side.)

**Recovering an offset from `ce.exe`:**

0. **Enumerate the _whole_ setup function first - every part, every instance.** This is the step that's easy to skip, and skipping it is why placements come out wrong. For each vehicle, list every `mov ecx, str.<part>` and count the `SetPosition` (`0x46bf90`) calls in the setup function (entry → first `ret`). Account for **every instance** before decoding anything: the coaxial heli has `HeliTBla` ×3, the plane has `AirRbak`/`AirRfL`/`AirRfR` control surfaces. Decoding one `SetPosition` and generalizing will miss those.

   **But a `SetPosition` is NOT the same as a visible part.** The count is an _upper bound_. Some placed objects are never rendered - invisible markers (the warship/ torpboat's `RCWheel` entry/steer points), special/hidden duplicates (the heli's `HeliTBla` ×3 is really **2 visible coaxial rotors + 1 hidden**; each plane's `AirWfl`/`Se5Whee` ×3 is **2 visible main wheels + 1 hidden dead-centre**), shadows (`…SH`/`…Sh`/`Shadow`) and headlights (`Vlight`). The tell is **field `[obj+0x2a8]`** (object state flags): a non-rendered part gets an extra **`and [obj+0x2a8], 0xfffffffd` (clear bit `0x2`)** right after its `SetPosition` that the visible parts beside it don't. That bit `0x2` is the confirmed "don't draw" flag (heli dummy rotor, hidden 3rd plane wheel; distinct from the `0x20`/`0xffffffdf` clear the visible wheels also do). So after enumerating, **filter to the parts that are actually drawn** (check for the `0xfffffffd` clear, and confirm against the render / in-game) before treating a missing instance as a real gap.

1. Find the part-name string and its code xrefs (`mov ecx, <str>` / `push <str>`); they cluster in the vehicle's setup function. Each `call 0x46bf90` is one `SetPosition`.
2. Establish the **axis order** from the _body's own_ `SetPosition`: the three values it pushes are `(x, y, z)` in stack order (`arg0=x, arg1=y, arg2=z`). The body reads them from a base vec3 on the stack (the body anchor) at consecutive offsets, e.g. `[esp+0xcc]=x, [esp+0xd0]=y, [esp+0xd4]=z`.
3. Decode each part block: the delta is either clean `mov [esp+N], <imm>` immediates, or `fld [base±] ; fadd/fsub <const> ; fstp [arg]` (FPU). Read the constants from `.rdata` (file offset `= VA − 0x400000`); `fadd qword` = `double`, `fadd dword` = `float`. **Width is per-vehicle, not global:** some setups store their offset constants as `double` (8-byte): the SE5 biplane (`FUN_0040dbb0`, the `plane`/`plane3` variant) does, shown in the decompile as `(float)_DAT_…` casts. Reading those as `float32` yields garbage (`2.7e23`, `-1.07e8`); read them as `double` and they come out clean (`20.9`, `13.25`, …). If a decoded offset looks absurd, try the other width before assuming the constant is computed. The lateral `±` (mirrored `fadd`/`fsub` of the same const) marks the **x** axis; the sign of the front/back const marks **z**. This decode can be automated by esp-tracking each block and reading off the `(x,y,z)` deltas per part. One class of case doesn't resolve mechanically: a part's _first_ instance decodes cleanly, but mirror/twin instances reuse a setup temp (the const is computed once) - those are the x-mirror of the first for symmetric pairs (tracks, wheels, props, twin barrels).
4. **Watch `esp`.** `sub esp,8` and intervening `push`es shift the base-slot offsets, and `SetPosition` is `__stdcall` (it `ret 12`s - cleans its own 3 args), so the frame after one call is 8 bytes higher than a naive read suggests. Track every `sub/add esp` and `push/pop` between the body anchor and the part's `fld`, or you'll map a constant to the wrong axis/base (this is the single most common mistake - it's what made the car cannon look 10 units too far forward).
5. **Verify visually.** Export with `cnetool object …` and render each part in a distinct colour. The static offset is only "done" when the render matches in-game; if a part is articulated, expect the literal offset to be wrong and seat it at its rest pose instead.

`cnetool`'s `controllableGeometry` encodes the bodies (engine-confirmed) plus parts as either rigid (drawn at the placement) or `{project, at}` copies at the body-local offsets recovered this way; each entry's comment records whether it's an exact static offset or a rest-pose seat for an articulated part. `assembleLevel`'s `controllable` option (CLI `level --controllable`, or `cnetool object <key>`) substitutes them for the empty stubs; un-recovered parts are omitted (rather than misplaced). Override any entry via the option, eg `{...controllableGeometry, tank: ['…']}`. The map is **off by default**: for a real game you want the stubs left as-is so the engine attaches the controllable objects itself.

#### Non-controllable assemblies (scenery vehicles/props)

Not every empty stub is a controllable. The same class dispatcher (`FUN_0044d480`) also builds **multi-part objects the player can't enter** - scenery vehicles and props - via the identical `create + SetPosition + attach` triplet. They're stubs for the same reason (the logical placement name has no geometry; the engine assembles the real meshes at runtime), and they were recovered the same way (decode each setup's `FUN_0046bf90` deltas). The confirmed ones (`src/api/controllable.ts` `assemblyGeometry`):

- **Mercedes** (staff car, class `0x0d`, `FUN_0040afb0`) - `Merc` body + `Mwheel` ×4 (front ±9 / 28 fwd, rear ±9 / 12 back, 3 up), each on a suspension joint (`FUN_0047f900`, not the rigid `FUN_0047fab0`). The setup also makes a `MercSH` ground shadow (a flat decal, dropped like other vehicles' shadows) and a hidden `motobody` driver proxy at the origin (clears render bit `0x2`); both are omitted.
- **Flak bunkers** (`BUNKERS` `0x30` / `BUNKERL` `0x31`, `FUN_00403b80`) - the `bunker1` / `bunkerd` emplacement + a single `Car2Can` barrel (off-centre x −4 / 9 up / 29 fwd). The setup also makes an `AASheld` shield and `AABox` mount at the same anchor, but **both clear render bit `0x2`** - they're the hidden aim mount, only the barrel is drawn. The engine builds this gun for **both** variants identically; the only per-variant difference is the body mesh.
- **Passenger airship** (`ZEPPELINP`, class `0x35`, `FUN_00423820`) - the `zeppov` envelope + `zhatch` boarding hatch (38 down / 147 back). The setup also makes a `subrudd` tail fin but clears its render bit `0x2` (hidden), so it's omitted. (The drivable `zeppelin` `0x19` uses the `zeppe` envelope and hides both.)

The **train** (`TRAIN` `0x12` / `STRAIN` `0x1d`, `FUN_0041e9d0`) looks like an assembly - its setup adds `Car2Whe` ×6 - but five clear render bit `0x2` (hidden bogie/physics proxies) and the one drawn wheel is a stray; the only visible geometry is the `train` body mesh, already under `objects/`, so it is **not** an assembly. This is the same "a `SetPosition` is not a visible part" filter as the controllables: enumerate every part, then keep only the ones that don't clear bit `0x2`.

Battleship/submarine/woodboat class setups also assemble multiple parts, but those are already covered as controllables (`battleshipa`/`battleshipg`, `submarin`, `woodboat`). The remaining stubs are single-mesh renames (`AIBIRD` → one bird mesh) or invisible collision/marker proxies (`rect`, `minecoll`, `firecoll`, `thook`, `dummybox`, …) with no geometry to export. `assemble()` (in `src/cli/object.ts`) takes the geometry map as an argument so the same code drives both maps; the map is consulted **before** the direct-mesh fallback, so an assembly key wins over a same-named raw mesh.

### Vertex animations (`ANM/*.anm`)

Some projects are **vertex-animated** - the engine morphs the mesh through stored poses rather than rotating sub-parts. The motorcycle is the clearest case: the engine draws `motobody` twice and animates the second instance with `ANM\mc.anm`, which steers the front fork/handlebars. `parseAnm` decodes the format.

**File format.** A 12-byte header - three `u32`: `frameCount`, a kind field (`1`), `vertexCount` - then `frameCount` frames. Each frame is:

- `vertexCount × vec3` (`f32`) **morphed vertex positions**, in the project's vertex order (so **frame 0 equals the base mesh** stored in `objects.dat`), followed by
- a **trailer transform** for an attached sub-part: `position` (vec3) + a row-major **3×3 rotation** + `translation` (vec3) = 15 floats / 60 bytes.

The frame stride is `(fileLength − 12) / frameCount` (so the trailer size needn't be known up front; `mc.anm` = 9 frames × (148 verts + 60-byte trailer) = 1836/frame).

**What an animation drives.** Two things at once: the morphing mesh _and_ the trailer transform of an attached part. For `mc.anm` the trailer is the **front wheel's pose**, and it sweeps a clean arc across the 9 frames - yaw `120° → 90° → 60°` and position `(−4.83,1.95,9.47) → (−2.50,1.95,10.11) → (−0.17,1.95,9.49)` - i.e. full-left → straight → full-right steering. So the wheel follows the fork because its transform is keyframed alongside the fork morph.

**Binding & the project side.** `AddAnimation` (`ce.exe` `0x47f470`) attaches an `.anm` to a project, rejecting it unless `anm.vertexCount == project.nv` (debug: `Animation does not fit project di=%d nv=%d nanimvers=%d`). A project holds a **list** of animations - count `nanimvers` at `[proj+0x2f2]`, array at `[proj+0x2f4]` - populated from a startup _Preload Animations List_.

**Playback runtime.** The player is `FUN_00469510(proj, animIndex, phase, weight)` - it resolves the anm via `[proj+0x2f2]`/`[proj+0x2f4]` and **linearly interpolates** between the two frames straddling `phase` (∈ 0..1): `base = floor(phase·N) % frameCount`, fraction `f`, and each vertex (and the trailer transform) is `(1−f)·frame[base] + f·frame[base+1]`. A second blend against the previous pose by `weight` (forced to `0.9` when `< 1.0`) low-passes the motion so it eases rather than snaps. So animations are **continuously interpolated**, not frame-stepped.

**What drives `phase` is per-caller.** Doors/levers use a timer (`phase` from `(now − start)/duration`); the motorcycle uses **steering input**: its per-frame handler (`0x40b7e0`) computes `phase = 1.0 − (steer + 1.0)·0.5` from the steering axis (`obj+0x58` → `motobody+0x25c`), so `steer ∈ [−1,+1]` maps to `phase ∈ [1,0]` and **centred steering → phase 0.5**. The bike seats its wheel at rest with `FUN_00469510(motobody, 0, 0.5, 1.0)` at construction.

**The rest frame** is therefore the **neutral-input frame**, not universally frame 0: a symmetric bidirectional sweep (steering) rests in the middle (`mc.anm` frame 4 of 0-8 - trailer yaw `90°`, wheel on the centerline `x=−2.5`); a one-way animation (open/close, recoil) rests at an end. `cnetool` records this per project in `restPoses` (`motobody → mc.anm` frame 4); `object`/`level` render those projects at their rest frame so a static export matches the parked game model.

**Scriptable.** `REFAddAnimation(name, param)` (`0x48d110` → `0x46a1c0`) lets a script attach/trigger an animation by name with a float parameter (speed/time); the binding is deferred to the preload pass. (`REFAnimateTexture` is the separate scrolling-UV texture animation, unrelated to vertex morphs.)

#### `OBJECTS2.DAT` and `texsec.dat` (multiplayer patches)

The multiplayer patches ship a **second object archive, `OBJECTS2.DAT`** (same archive + project + texture-table format as `objects.dat`) holding the new multiplayer models - `zeppe` (zeppelin), `aship`/`bship` (battleships), `torpb`, `rcbody`, `rdrtwr2` and others. This was introduced in the **1.33** patch (17 projects); the **1.41** patch grew it to 22 by adding a **helicopter** (`HeliBody` + `HeliTBla` main rotor (Top Blade, on the mast) + `HeliRBla` tail rotor (Rear Blade, on the boom) + `HeliSh` shadow). Neither archive exists on the base 1.0 CD. (The patches are InstallShield (1.33) / InnoSetup (1.41) installers; 1.41 is a complete superset, so it can be applied to the base game without 1.33.) As in the base game the logical names (`helicopter`, `zeppelin`, `battleshipa`, …) are empty stubs; these are their bodies. `assembleLevel`'s `extraObjects` option searches additional archives (in order, after `objects.dat`) for geometry, and each resulting scene item records its `source` archive. The CLI auto-loads `OBJECTS2.DAT` when it sits next to `objects.dat`, so `level --controllable` renders the MP helicopters/zeppelins/battleships of `LEVEL128`-`LEVEL248`. The built-in `controllableGeometry` covers these (`helicopter → [HeliBody, HeliRBla, HeliTBla]`, `zeppelin → [zeppe]`, `battleshipa → [aship]`, `battleshipg → [bship]`).

Textures for these models are split between `24bits/textures.dat` (base) and a patch archive **`24bits/texsec.dat`** (eg `HELICOPT.TGA`, `HELISH.TGA`, `BSHIPIPE.TGA`). `createTextureResolver` accepts several texture archives and searches them in order - a face's `texId` indexes _its own_ object archive's texture-name table, and the resolved `ResolvedTexture` carries which texture archive its entry came from. With both archives loaded, all of `OBJECTS2.DAT`'s texture references resolve.

#### `leveltex.bin` - per-level textures

A level may carry its own textures in a `leveltex.bin` in its folder - the **same container format** as `textures.dat` (so `parseArchive`/`extractEntries` read it directly). It holds level-specific art and the level's tab-map tiles (`map<lvl>0..3.tga`); most levels keep their tab maps in the global `24bits/textures.dat` instead, so `leveltex.bin` ships only with the levels that need extra art (eg `LEVEL133`, `LEVEL248`).

#### A note on `.TIF`/`.BMP` texture names

A texture-name table records each material's **original source-art filename**, so the extensions are a mix - in base `objects.dat`, 762 of 1358 are `.TIF` and 20 are `.BMP` (the rest `.TGA`). No `.tif`/`.bmp` files actually ship; the build rasterized every one to a `.TGA` of the same base name. Resolution therefore normalizes any extension to `.TGA` (strip extension, append `.tga`). Effectively everything referenced resolves - the only used-but-unshipped case found is `GRENADE6.TIF` (the `rockets` mesh), where only the base `GRENADE.TGA` shipped.

## Scripts (`.scr`)

`.scr` files are **compiled bytecode** for the engine's scripting VM - the game-logic layer. There are 419 of them in the install examined - 138 shared in `GLOBAL/` plus per-level ones (a fully patched install has 869; see [scripts.md](./scripts.md)). A script is attached to an object/"project" (or, as `mainscr.scr`, to the whole level) and defines handlers for engine events.

**`.scr` is the compiled output of a C-like source language.** The sources are `<name>.scr.c` files (eg `mainscr.scr.c`) compiled by **`CPARSE.EXE`**, the compiler shipped with the map-maker tools (`mapmaker/temp/modules/CPARSE.EXE`). Its embedded yacc grammar confirms the language is a C subset: `if`/`else`, `while`, `do`/`while`, `goto`, `return`, `enum`, `#define`, `#include`, with types `float`/`void`/`const`. So local variables, `float`/`void` types and ordinary control flow are real language features, not VM idioms. The `REF*` functions are the runtime "standard library" - external builtins the VM resolves **by name** at the call site (hence the `0x10 call` opcode carries the function name as a string, below). So a faithful `.scr` decompiler is a well-defined bytecode→C target, and the `REF*` catalog is its API surface. The `REF` prefix is most likely short for **Refraction Games**, the (Swedish) developer - see the naming note below.

### File structure

Recovered byte-exact (cnetool's `compileScript` reproduces CPARSE output exactly for any number of handlers, params, and globals):

```
u32   varBytes             total variable storage, (globals + Σ params) × 4 (0 if none)
u32   handlerCount
descriptors, in REVERSE declaration order - one per handler:
  char[8]  name            fixed 8-byte buffer: name + NUL, pre-filled with the
                           constant 0x004376f0 in its high 4 bytes (don't-care
                           padding). Name-length limits differ per tool: the engine
                           accepts names up to 31 chars (see scripts.md), CPARSE
                           corrupts names longer than 7 (it overflows this buffer -
                           a bug), and cnetool's compileScript accepts up to 27 (its
                           descriptor prefix limit).
  descriptor:
    u32  4                 constant (purpose unclear)
    u32  0
    u32  ptr1 = 0x439868   baked pointer - relocated at load (BindScript)
    u32  varBytes          the shared slot-space size (same value in every descriptor)
    u32  ptr2, u32 ptr3    baked pointers (the compiler's build addresses) - relocated
    u16  startIndex        instruction index where this handler's code begins in the
                           combined bytecode stream (0 for the first-declared handler)
    u16  nParams
    u32  4                 constant
    u16[nParams]           this handler's parameter slot indices
    u32  instructionCount  TOTAL instructions across all handlers - present ONLY on the
                           last descriptor (the first-declared handler), just before code
bytecode                   every handler's instruction stream, concatenated in
                           DECLARATION order (jump targets are ABSOLUTE indices into
                           this combined stream, not handler-local)
```

The three `ptr*` slots (and the `0x004376f0` in the name buffer) are not meaningful data - they're **uninitialised memory** CPARSE dumps to disk. The descriptor is CPARSE's in-memory handler node (a 76-byte allocation: storage-buffer pointer, `varBytes`, the 8-byte name, and a `next` pointer for the handler linked list) written out via `fwrite`; its pointer-typed fields just hold whatever was there. Confirmed by disassembling CPARSE (image base `0x400000`): `ptr1` = `0x439868`, the address of CPARSE's handler list-head global; `ptr3` = `0x4048a1`, _proven_ to be the return address immediately after the `fwrite` that writes `varBytes`; `ptr2` = `0x22f9e8`, a stack address; `0x004376f0` → a `.data` global address (never explicitly written). The two literal `4`s and the `0` are fixed struct constants. The engine relocates/overwrites the pointer slots at load (`BindScript`), so they're don't-care - cnetool reproduces them only to stay byte-identical to CPARSE. Descriptors are laid out in reverse, but `startIndex` lets a reader recover declaration order and split the combined bytecode exactly (`parseScript` does this, falling back to a heuristic scan for files that don't match the layout).

#### Variables

There are no function-body locals - CPARSE silently compiles a body containing a `float x;` declaration to an _empty_ handler, so the only real variables are:

- **Globals** - `float g;` at module scope. Each takes one persistent 4-byte slot, numbered in declaration order (`g`→0, `h`→1, …), shared across every handler, and zero-initialised (a `float g = 3;` initializer is parsed but discarded). A global is allocated even if never referenced.
- **Parameters** - occupy the slots _after_ the globals, across **all** handlers: globals take slots `0 … nGlobals−1`, then each handler's params take the next slots in declaration order (handler 1's params, then handler 2's, …). Each descriptor's param-slot table lists exactly its own params' indices, which is how the loader knows which slots receive that handler's call arguments.

`pushvar` (`0x06`) operands index this one flat slot space. `varBytes` therefore counts the globals plus every handler's params. `compileScript` emits all of this; `parseScript` reads it.

#### Compiler variants

Two compilers in the wild emit slightly different descriptors. The standalone map-tool `CPARSE.EXE` uses the layout above: an 8-byte name field, the `[4][0]` constants, three baked pointers, and a repeated `varBytes`. The **shipped game's** scripts (eg the demo's `GLOBAL/*.scr`, `level2/*.scr`) were built by a different compiler whose descriptor is:

```
name      NUL-terminated in a fixed 28-byte region (a 16-byte buffer plus the three
          dwords below; names > 15 chars overflow into them - they're don't-care)
u32  0  ┐ three constant/garbage dwords (always 0, 4, 0)
u32  4  │
u32  0  ┘
u32  ptr_a   baked, relocated (eg 0x0042bc44)
u16  startIndex
u16  nParams
u32  ptr_b   baked, relocated (eg 0x0066f978)
u16[nParams] slots
```

The two variants are reconciled by a happy coincidence: in **both**, `startIndex` is at descriptor offset `+32`, `nParams` at `+34`, the slot table at `+40`, and a descriptor spans `40 + 2·nParams` bytes (the final one then carries `u32 totalInstructionCount`). So `parseScript` reads those fixed offsets directly - skipping the build-specific pointer/constant fields and the variable-width name - and validates structurally (the decoded instruction count must equal the stored total and the `startIndex` values must form a 0-based partition). This parses every script in the demo exactly (153/153, recovering real handler names, per-handler param counts, and the global/param split); anything that doesn't fit falls back to the heuristic `ret`-boundary (`0x0b`) scan.

#### Confirmed by the engine loader

Disassembling the demo's (unpacked) `Game.exe` confirms these fields from the consumer side. `LoadScript` (`0x47c9e0`) `fopen`s `GLOBAL\<name>` (`"rb"`) and then:

- `fread`s `varBytes` and `handlerCount` (4 bytes each);
- `malloc`s `handlerCount × 40` and `fread`s each descriptor's **40-byte** fixed block directly, then `fread`s `nParams` slot `u16`s - so an on-disk descriptor is `40 + 2·nParams` bytes;
- `fread`s the **total instruction count**, `malloc`s `total × 8`, and reads each instruction as `[u8 opcode][u16 len][len operand bytes]` into an 8-byte slot.

The in-memory handler entry mirrors the disk block: `startIndex` at `+0x20` (32), `nParams` at `+0x22` (34), and the freshly-allocated slot-array pointer at `+0x24` (36) - which **overwrites** whatever the file had there (`ptr_b` / a constant), proving the descriptor's pointer slots are load-time don't-care. At call time `CallScriptOne/Two/Three` validate `handler->nParams` against the argument count, then write each argument into the script's variable array at `slots[i]`. The interpreter (`0x47ac10`) sets its program counter to `handler->startIndex` and loops: `opcode = instructions[pc]` (byte 0 of the 8-byte slot), dispatch. The script object is 24 bytes: name, `varBytes`, `handlerCount`, handler array, instruction count, instruction array. So `startIndex`/`nParams`/slots are real and used; the name is a NUL-terminated string; everything else in the descriptor is don't-care padding the engine ignores or overwrites.

#### REF and handler name resolution

Two kinds of names are resolved by name, both at load:

- **`REF*` builtin calls** (opcode `0x10`) carry the function name as their operand. As `LoadScript` reads each instruction, if the opcode is `0x10` it passes the name to the resolver (`0x47afe0`), which linear-scans the engine's **REF dispatch table** at `0x4c6848` - an array of `{void* func; char* name}` pairs (128 entries) - `strcmp`ing the name and returning the function pointer. That pointer is baked into the instruction's second dword; the interpreter then invokes it directly (`call [instr+4]`). A miss prints `"REFFunction %s not found!"`. (For non-call opcodes the operand bytes are instead `malloc`'d and copied, so `instr+4` is the operand pointer.) The 128 names and their arities - each = how many values the function pops (`0x47ab10` per float arg, `0x47abf0` per string arg) - are catalogued in `script.ts`'s `REF_ARITY`.
- **Handler names** (eg the target of `REFCallScript("…", "SetSound", …)`, or an event firing) are resolved per script by a separate scan (`0x47b030`) over that script's handler array (`script+8`, count at `script+6`), `strcmp`ing each descriptor's name field. `CallScriptOne/Two/Three` then validate the found handler's `nParams`.

#### Script file resolution (per-level vs `GLOBAL/`)

Scripts live in two places: a level's own directory and the shared `GLOBAL/`. The engine keeps a "current level directory" string (global `0x547040`); on level load it reads the current level number (`0x5499f0`), formats `LEVEL%d`, and stores that as the level dir (eg `LEVEL2`, matching the on-disk `level2/` - Windows paths are case-insensitive). Resolution prefers the level dir:

- `LoadScript(name)` `fopen`s `<levelDir>\<name>` first and only falls back to `GLOBAL\<name>` if that fails - so a per-level script **overrides** a global one of the same name (how a level customises eg its own `mainscr.scr`).
- The bulk file indexer (`ReadFileBuckets`) likewise scans both `<levelDir>\*.*` and `GLOBAL\*.*` into its filename lookup, the level dir taking precedence.

When no level is active the level-dir string is empty, so `LoadScript` looks the name up directly and then under `GLOBAL\`.

#### Cache files (`*cache.bin`)

Each level dir holds precomputed cache files, read at level start by `LoadAllCacheFiles` (`0x4434e0`, which logs `"LoadAllCacheFiles() took %f seconds"`) and rewritten by an aggregate **writer** (`0x443430`) that the engine calls on **level teardown** (`0x441a10`). All are **engine-generated** - derived from the authored data, never edited by hand. They split into two kinds: **preload manifests** (lists of assets to load up front) and **precomputed indices** (data the engine would otherwise recompute each load). Each has its own loader/writer pair (image base `0x400000`):

| File           | Caches                | Header                                           | Record                                                                      | Loader            |
| -------------- | --------------------- | ------------------------------------------------ | --------------------------------------------------------------------------- | ----------------- |
| `scrcache.bin` | script names          | `u32 count`                                      | `u8 len` + `char[len]` (NUL-term)                                           | `0x47c5f0`        |
| `texcache.bin` | texture names         | none (to EOF)                                    | `char[13]` NUL-term base name                                               | `0x460d30`        |
| `acache.bin`   | animation preloads    | `u32 count`                                      | `char[20]` + `i32 start, end, index` + `f32 speed` + `i32 flag` (40 B)      | `0x481b10`        |
| `scache.bin`   | sound preloads        | none (to EOF)                                    | `char[]` WAV path NUL-term + `u32 flags`                                    | `0x483b50`        |
| `ocache.bin`   | project/spawn list    | `u32 version(=11), count`                        | `u8 len` + `char[len]` + `u32 instCount` (+ `u32 flag` if `instCount != 0`) | `0x4807d0`        |
| `wcache.bin`   | land/water adjacency  | `u32 version(=3), nFaces, nPairs, nLand, nWater` | `nPairs×{i32 land, i32 water}`, then `nLand×u32`, then `nWater×u32`         | `0x46e890`-region |
| `faccache.bin` | object→landscape face | `u32 count`                                      | `i32 objIdx, i32 faceIdx, i32 meshId` (12 B)                                | `0x482560`        |

`ocache`/`wcache` carry a version word and reject a stale cache (`"Wrong Projectlist cache version"` / `"Wrong wcache.bin version"`); `faccache` stores a per-record `meshId` and discards entries whose mesh changed. `wcache` is the heaviest - it precomputes the land/water face pairing `InitWater` needs (each water face matched to the land face beneath it; see [Water](#water---semi-transparent-terrain-faces-initwater)), so each header field's count exactly fills the file (eg `20 + 3706·8 + 11118·4 + 458·4 = 75972`). The remaining notes below cover the two script-toolchain caches in more detail; the rest follow the table.

**None of these are required.** Every reader silently no-ops if the file is missing (eg the texcache loader is just `if (fopen(...) != NULL) { … }` with no error path), and the version/ `meshId` checks discard a stale one the same way. Delete them and the level still loads - the preload manifests fall back to loading assets on demand, the precomputed indices get recomputed the slow way - and the engine rewrites them on the next level exit (so they only cost a slightly slower first load). They are pure runtime optimisation, safe to delete and **not** part of an authored level's file set.

`scrcache.bin` (scripts) is just a manifest of the script names the level uses:

```
u32   count
repeat count times:
  u8          nameLen      (includes the trailing NUL)
  u8[nameLen] name         (NUL-terminated, eg "bomb.scr")
```

The reader (`LoadScriptList`, `0x47c5f0`) loops the list and, for each name not already loaded, calls `LoadScript` - so the names resolve level-dir-first then `GLOBAL\` like any other script; a missing one logs `"LoadScriptList() Script not found"`. The matching writer (`0x47c540`, opens `"wb"`) regenerates the file from the loaded set. So the cache is purely a load-time optimisation - a precomputed dependency list with **no bytecode**; the `.scr` files themselves remain the source of truth.

#### `texcache.bin` (per-level texture manifest)

The texture sibling is decoded too, and uses a **simpler scheme than `scrcache.bin`** - no count header, no length prefix, just a flat array of fixed **13-byte** records read until EOF (file size is always a multiple of 13):

```
repeat until EOF:
  char[13]  name   NUL-terminated texture base name, no extension (eg "MULT15", "FBOMB")
```

The bytes after the NUL in each slot are uninitialised leftovers (the same name carries different trailing bytes in different levels) - the loader (`FUN_00460d30`, `fread(buf, 13, 1)` until EOF) reads only up to the NUL. For each name the registrar (`FUN_00460960`) assigns a sequential `texId`, builds `"<name>.tga"` (or `"8bits\<name>"`), and preloads the bitmap. The writer is `FUN_00460ce0` (`"wb"`). Like `scrcache`, it's a regenerated load-time preload list, not authored data; the `.tga` files are the source of truth.

### Bytecode

A stack machine. The compiler (`CPARSE.EXE`) builds the program as a linked list of IR nodes via one routine, `emit_node(opcode, operandLen, operandData)` (at `0x4035d0`): it stores the **opcode byte**, a **`u16` operand length**, then copies `operandLen` operand bytes. That is exactly the on-disk encoding - every instruction is:

```
u8    opcode
u16   operand length   (0 for operand-less ops)
bytes operand          (operand length bytes)
```

The **opcode space is `0x00`-`0x10`**. Semantics below are read directly from the engine's bytecode interpreter `FUN_00486d30` (`0x486d30`; a jump table at `0x486ffc` dispatched on the raw opcode byte), and cross-checked against `CPARSE.EXE`'s emitter and the opcode frequencies across all 2,764 shipped `.scr` (column "in data"):

| Op   | Meaning                                                        | Operand                  | in data |
| ---- | -------------------------------------------------------------- | ------------------------ | ------- |
| `00` | **integer bitwise XOR** (pops 2, truncates both to int, `^`)   | none                     | 0       |
| `01` | `*` multiply                                                   | none                     | 475     |
| `02` | `/` divide                                                     | none                     | 505     |
| `03` | `+` add                                                        | none                     | 689     |
| `04` | `-` subtract                                                   | none                     | 5,968   |
| `05` | `=` store / assign (pops value into the variable ref below it) | none                     | 6,761   |
| `06` | push **variable** (by index)                                   | `len 2` + `u16` index    | 27,928  |
| `07` | push float literal (all numeric literals are floats)           | `len 4` + `float32`      | 76,295  |
| `08` | push string literal                                            | `len` + bytes (incl NUL) | 18,522  |
| `09` | test `== 0` → 1/0                                              | none                     | 4,078   |
| `0a` | test `< 0` → 1/0                                               | none                     | 1,428   |
| `0b` | **return / end of handler** (interpreter halts here)           | none                     | 11,472  |
| `0c` | unconditional jump                                             | jump target              | 1,061   |
| `0d` | conditional jump (jump **if zero/false**)                      | jump target              | 6,317   |
| `0e` | conditional jump (jump **if `> 0`**)                           | jump target              | 0       |
| `0f` | `%` modulo - but the **interpreter no-ops it** (see below)     | none                     | 1       |
| `10` | call builtin (`REF*`)                                          | `len` + name (incl NUL)  | 31,508  |

Three opcodes can only be pinned down from the interpreter - CPARSE output alone is misleading: `00` is **integer XOR**, not a label/no-op marker - it's simply never used by any shipped script. `0b` is **return/halt** (the handler terminator), not a stack "pop" - it discards nothing; the interpreter `return`s on it. `0e` is a second conditional jump (**if `> 0`**), also unused in shipped data. And `0f` (`%`): CPARSE emits it for the modulo operator, but the interpreter has **no case for `0f`** - it falls through to the default (a no-op), so modulo silently does nothing in the engine. It appears exactly once in all shipped scripts.

Notes from the verification:

- **`06` is push-_variable_, not push-int**: its `u16` operand is a variable/parameter **index**. Numeric literals - even `0` - compile to `07` floats. An assignment `x = …` emits `06`(index of x) for the l-value, the RHS expression, then `05` (store).
- **Comparisons are synthesized**, not distinct opcodes: `a < b` → `a b - (04)` then `0a`; `a > b` → operands swapped then the same `04`+`0a`; `a == b` → `04` then `09`; `a != b` → `04` and the (non-zero = true) result used directly; `!a` → `09`; unary `-a` → `a * -1.0` (`01`). The language has **no `<=`, `>=`, `&&`, `||`** (they're syntax errors in CPARSE).
- `0c`/`0d` implement `if`/`while`/`do`/`goto`: codegen emits jumps to generated `@@@LABEL%d` names, resolved to targets in a fixup pass (`Label not found!` if dangling). A `while (c) body` is `c 0d(exit) body 0c(top)`. (`0e`, jump-if-`>0`, is a third jump the interpreter supports but CPARSE never emits.) The jump operand is a `u32` **target instruction index** - **absolute** within the file's combined instruction stream (offset by the handler's `startIndex`), not handler-local and not a byte offset. The interpreter loads PC = `startIndex` and a jump sets PC = target directly, so `compileScript` shifts each handler's local targets by its start offset when serializing, and `parseScript` rebases them back to per-handler indices.

`parseScript` / `disassembleScript` / `decompileScript` (in cnetool) decode this: header → handlers → instruction list (with resolved jump targets and `REF*` names), and `decompileScript` further stack-reconstructs it to C-like pseudo-source - expressions, `REF` calls grouped by arity, assignments, folded comparisons, and `if`/`while` (goto/labels for irreducible flow). The on-disk layout is `u32 varBytes` ((globals + Σ params) × 4), `u32 handlerCount`, per-handler descriptors (reverse declaration order; see the file-structure section), then the handlers' bytecode. `parseScript` parses the descriptors exactly - using each handler's `startIndex` to split the combined stream and recover declaration order - and falls back to a heuristic `ret`-boundary (`0x0b`) scan only for files that don't match the layout.

Example - `GLOBAL/aacanon.scr`, handler `startup`: push `-1.0`, `17.0`, `9.0`, then `call REFSetProjectVars`. `GLOBAL/bazooka.scr` reads as the bazooka pickup: `REFPlayerHasItem("bazooka")`, `REFAddItem`, `REFChangePlayer`, `REFPlayFX("WBACHO")`.

A level's `LEVEL<n>/mainscr.scr` `startup` handler configures the level via a run of `REF*` calls; `getLevelInfo` (in cnetool) evaluates those constant arguments into a typed `LevelInfo` - terrain `REFSetLandscape(name, sky, _, fogDistance)` (eg level 128 → `dm1`), `REFSetWater` wave amplitude, lighting (`REFLightColor`/`Min`/`Direction`), `REFBackColor`, `REFSetPlanet`, `REFSetWeatherType`, `REFSetGroundSounds` - plus the full call list.

#### Worked example - spawn-time self-destruct

No Man's Land (`LEVEL128`) ships **per-level** `CACTUS1`/`CACTUSS`/`PALM`/`SWITCH1` scripts (which override the `GLOBAL/` versions) whose `startup` ends with `REFSetTTL(MYSELF, 0)` - `MYSELF` is the self handle (`-1.0`) and `REFSetTTL`'s second arg is a lifetime in seconds where **`0` = destroy immediately**. So these objects delete themselves the instant they spawn: the level lists 52 `cactuss` + 10 `cactus1` + 22 `palm` (+ `switch1` triggers) in `data1.bin`/`World.dat` yet shows none in-game. (The `GLOBAL/` cactus scripts don't self-destruct - only the desert level's overrides do.) The same call with a positive lifetime is how a thrown bomb works: `bomb.scr` ends with `REFSetTTL(MYSELF, 10)` - live 10 s, then explode.

This is a property of the _script_, not the placement. `cnetool level` accounts for it: by default it resolves each placed project's script (level dir then `GLOBAL/`) and **skips objects whose `startup` self-destructs** (`REFSetTTL(MYSELF, 0)` or `REFDestroy(MYSELF)`, via `selfDestructsAtSpawn`), plus `World.dat` `Dele` entries - so the export matches the game. `--keep-removed` renders everything. (The lower-level `assembleLevel` API draws every placement it's given; the CLI does the script-based culling.)

### Builtin API (128 REF functions)

The full scripting surface - see **[`scripts.md`](./scripts.md)** for the complete guide (execution model, variables, engine callbacks, and the per-function `REF` reference with call-site-derived signatures and examples). Summarised here by role (call counts across all scripts in parentheses for the common ones):

- **Objects / "projects":** `REFSetProjectVars` (1486), `REFGetProject`, `REFAlignProject`, `REFYawProject` / `REFPitchProject` / `REFRollProject` / `REFMoveProject`, `REFSetPosition` / `REFGetPosition`, `REFSpawnAI`, `REFAttack`, `REFExplode`, `REFDamageProject`, `REFDestroy`
- **Flow:** `REFCallScript` (761), `REFCallScript_inst`, `REFRandom`, `REFGetTime`, `REFGetDataIndex`
- **Player / items:** `REFAddItem`, `REFRemoveItem`, `REFPlayerHasItem`, `REFChangePlayer`, `REFChangeVehicle`, `REFGetArmor`
- **Audio / UI:** `REFPlayFX` (297), `REFPlayDlg`, `REFShowMessage`, `REFShowInfo`, `REFShowCutscene`
- **AI:** `REFSetAIVars`, `REFSpawnAI`, `REFPatrolMode`, `REFDeleteAI`, `REFAIToVehicle`
- **World / render:** `REFSetLight`, `REFLightColor` / `REFLightDirection`, `REFSetWater`, `REFSetWeatherType`, `REFSetLandscape`, `REFReplaceTextures`, `REFGouraudOn`
- **Mission:** `REFDoneObjective`, `REFEndGame`, `REFSetScore`

(A handful of names appear in case variants like `REFCAllScript`/`REFCallSCript` - inconsistent casing in the source, not distinct functions.)

Calling conventions, confirmed against decoded bytecode:

- `MYSELF` = `-1.0` - the running script's own object; the usual first argument to project calls (matches the leading `-1.0` push seen everywhere).
- `TRUE`/`FALSE` are `1.0`/`0.0`; symbolic args (`MOVE`, `ON`, `PLAYER_FUEL`, `DOF`/`UP`/`RIGHT`, `VIEW_BEHINDCHASE`, `WEATHER_OFF`, …) are `#define`d ints pushed as floats.
- Signatures, eg `REFSetProjectVars(obj, varId, value)`, `REFSetTTL(obj, seconds)` (`0` = kill), `REFAlignToLand(z)`, `REFNewVehicle(out, type, x,y,z, dof…)`, `REFCallScript(inst, "proj", n, "Handler", argc)`.
- A few builtins are unused / non-working (`REFPrintValue`, `REFGasMask`, `REFShowInfo`, …).

### Event handlers

Handler names are the engine events a script hooks. Common ones: `startup` (362), `mainscr`, `align`, `killed`, `HitItem`, `Destroyed`, `seeplayer`, `EnterVehicle`, `Touched`, `DropBomb`, `activate`, `PlayerCreated`, `Explode`, `Alarm`, `Open`, `StopDoor`. These match the property names in the per-object instance files (`UseActive`, `DropBomb`, `seeplayer`), tying the data model together:

> `MOBJS.DAT` `Type:` → a `.scr` with these handlers → `REF*` builtins. `mainscr.scr` is the level's master script; `RED.SCR` is the **player** script (the player character is named **Red**) - its handlers (`startup`, `PlayerCreated`, `killed`, and weapon handlers like `gun`/`rifle1`/`flamew`) set up the player's loadout via `REFAddItem` / `REFChangePlayer`.

Scripts cross-reference the rest of the data: `REFPlayDlg` takes `DIALOGUE.DAT` ids, `REFPlayFX` takes `SOUNDS/` clips, `REFAddItem` the `data4.bin` weapons, `REFSpawnAI` the `data3.bin` / `objects.dat` units.

### Naming note (Swedish developer)

Refraction Games was Swedish, and Swedish names appear throughout the scripts and object names - eg `kropp` ("body"), `vakt1`-`vakt4` ("guard"). Worth keeping in mind when a name looks meaningless in English. The player character is **Red** (`RED.SCR`, and `Red` as an object/handler name).

## How a level is composed

A level is described by its `LEVEL*/` folder. `MOBJS.DAT` lists object instances by `Name:`/`Type:`, where `Type:` (eg `enemyplane`, `bombthis`) is the gameplay category, not a model reference.

**Some** of those `Name:` values also have a **sibling file in the same folder** named `<name>.<instance>` (eg `LEVEL12/plane2.1`, `Level4/vakt1.2`). These are **per-instance compiled `.scr` scripts** - the exact same bytecode format as `GLOBAL/*.scr` (the shipped descriptor variant), so `parseScript`/`decompileScript` read them fully. They're a customized copy of the object's base behavior for one placed instance: e.g. `vakt1.2` swaps the base script's `REFPatrolMode` for `REFSetAIVars`, and `vakt1.3` adds a handler with an embedded line `"There, in the boat! Shoot him!"`. The "named properties" seen (`UseActive`, `DropBomb`, `seeplayer`) are the script's **handler names**; the recurring Win32-address values (`0x0042bc44`, `0x0066f978`) are the same **baked, don't-care descriptor pointers** every `.scr` carries (relocated at load) - not evidence of a partial decode. The `<instance>` is the instance number used by `REFSpawnAI("name.inst")` / `REFGetInstanceNr`, resolved against an in-memory table built at level load.

The correspondence is **sparse and selective** - most objects have only a `MOBJS` line and no sibling file (the file exists only for instances given a scripted override):

| Level     | `MOBJS` entries | with a sibling file |
| --------- | --------------- | ------------------- |
| `LEVEL12` | 9               | 8                   |
| `level1`  | 13              | 1 (`truck.1`)       |
| `LEVEL3`  | 8               | 1 (`priest.1`)      |

It does not follow from `Type:` either - eg in `LEVEL3`, `priest.1` (`bombthis`) has a file but other objects of the same type do not.

Geometry and art come from the global archives, lighting from `LIGHTS.DAT`, the minimap projection from `MAPMTX.DAT`, and briefing/dialogue text from the text files. Some of these are byte-complete specs (`LIGHTS.DAT`, `MAPMTX.DAT`); others - the `MOBJS.DAT`/`MATS.DAT` semantics in particular - are best-current-understanding maps rather than byte-complete specs.

## Build pipeline (mapmaker tools)

The shipped data above is produced by a handful of command-line tools in the map-maker package (`mapmaker/temp/modules/`). They're not part of the game and their intermediate formats don't ship, but knowing them explains how the runtime files are shaped (and they're unpacked 32-bit PEs, so easy to disassemble - unlike the packed retail `game.exe`). The producer side of the formats in this doc:

| Tool           | Input → output             | Notes                                                                                |
| -------------- | -------------------------- | ------------------------------------------------------------------------------------ |
| `CPARSE.EXE`   | `.scr.c` → `.scr`          | The script compiler (see the Scripts section).                                       |
| `3DSTO3DE.EXE` | `.3ds` → `.3de`            | Autodesk 3DS → the build-time mesh format below (a "Polytrans 3DS converter" v0.70). |
| `PACKETOR.EXE` | `.3de` × 4 → `objects.dat` | Packs one object's meshes into the project database.                                 |
| `CEADDTGA.EXE` | `.tga` → texture cache     | Adds a texture to the cache (`AddTGAToCache`).                                       |

### `PACKETOR` - building a project

```
packetor <large> <medium> <small> <detect> <Project Name> [scale] [NoMerge]
```

It takes a 3D object's three render LODs (`large`/`medium`/`small` - the high→low layers `parseMesh` reads) plus a `detect` collision hull (the second mesh group `parseDetectMesh` reads), each as a `.3de` (or `.3ds`, which it auto-converts by spawning `3DSTO3DE.EXE`). It optimises each mesh - merging coplanar/convex faces (unless `NoMerge`) and stripping vertices not referenced by any face - then appends the named project to `objects.dat` (reads `objects.dat`, writes `objects.new`). So every `objects.dat` project = up to 3 LODs (shared vertex array) + an optional detect hull.

### `.3de` - the build-time mesh format

A **plain-text** mesh format, the hand-off between `3DSTO3DE` and `PACKETOR`. None ship (the runtime form is the binary `objects.dat` project). Per object:

```
<nVertices>                              ; "%d"
<nFaces>                                 ; "%d"
x y z  n0 n1 n2  u0 u1 u2   × nVertices  ; "%f"×9 - 9 floats/vertex
i0 i1 i2  m                 × nFaces     ; "%d"×4 - 3 vertex indices + a flag/material
```

Recovered from `PACKETOR`'s reader (`fopen(…, "rt")` then `fscanf`). Each vertex line is **9 floats**: the first three are the position `PACKETOR` keeps (the 12-byte `objects.dat` vertex); the other six are normal/UV data carried from the `.3ds` (exact split inferred, not byte-confirmed). Each face line is **4 ints**: three vertex indices and a fourth value `PACKETOR` turns into a face flag bit. The converter's third argument (`same precision`, surfaced as `VER_DISTANCE`) is the vertex-weld tolerance.

### Native import (cnetool, no PACKETOR)

cnetool can build `objects.dat` projects directly, bypassing the tool chain above: `serializeMesh(mesh, {detect})` writes a project blob (the inverse of `parseMesh` - it regenerates the edge table from face topology, with the 5th byte as a face-share count), and `objToMesh` imports Wavefront OBJ (the inverse of `meshToObj`), reading face colour and opacity from a companion `.mtl`'s `Kd`/`d` (`objToMesh(text, {mtl})`) and texture ids from `usemtl tex<n>` names. So the modern workflow is **model in any tool → `.obj` + `.mtl` → `objToMesh` → `serializeMesh` → `buildArchive` → `objects.dat`**. Geometry, UVs, texIds, and per-face colour/opacity round-trip through `parseMesh`/`parseDetectMesh`; the only non-exact field versus PACKETOR is the edge 5th byte (PACKETOR also accumulates it across its diagonal/merge passes), which the engine appears not to need since it recomputes normals at load (not yet verified with an in-game load test).

## Media assets

These are standard third-party formats - documented here for reference; cnetool doesn't re-implement codecs for them (use the off-the-shelf tools noted below).

### Sound effects & speech - `SOUNDS/*.wav`

Plain uncompressed **PCM WAV** (`wFormatTag = 1`), **16-bit**, almost all **mono**. Sample rates seen across the 1.0 set (773 files): **16 kHz** for the bulk (675 - most FX and dialogue), **22.05 kHz** (70), **44.1 kHz** (27, the higher-fidelity lines), one at 11.025 kHz, and 4 stereo files (a couple of FX and briefing music stings). No ADPCM or MP3-in-WAV in the sampled set, so any PCM-WAV reader plays them directly.

Directory roles under `SOUNDS/`:

| Dir         | Count (1.0) | Role                                                  |
| ----------- | ----------- | ----------------------------------------------------- |
| `FX/`       | 427         | World/weapon sound effects                            |
| `DIALOGUE/` | 251         | In-game spoken dialogue (`REFSpeakSound` etc.)        |
| `CHARFX/`   | 68          | Character vocal effects (grunts, hits)                |
| `brf/`      | 26          | Mission-**br**ie**f**ing voice-over (the `SR…` lines) |

### Cutscenes - `CUTSCN/*.SMK`

**Smacker** video (RAD Game Tools), `SMK2` variant. The demo's `LOGGA.SMK` is 640×480, 115 frames, with the header frame-rate field `-4000` → `100000 / 4000` = **25 fps** (Smacker encodes a negative field as a 1/100000 s interval). Decode/extract with **ffmpeg** (`ffmpeg -i in.smk out.mp4`); historically the engine used RAD's `smackw32.dll`. (The demo ships only the logo video; the full game's cutscenes ship on the disc.)

**Subtitles - `24bits/Cutfont.tga`.** Cutscene subtitles are rendered at runtime, not burned into the video: the Smacker player's init (the `"INIT PART"` logger; load at `0x4481a0`) loads `cutfont.tga` - a 256×256 glyph atlas, white glyphs on black - into a DirectDraw surface (global `DAT_004de9e0`, released with the other cutscene surfaces), and playback blits the text glyph-by-glyph onto the video surface with `DDBLT_WAIT | DDBLT_KEYSRC` (black = transparent; failure log `"Blitting a char=%c"`). The subtitle text is the cutscene entries in `DIALOGUE.DAT` (the multi-line values - see § Localization), whose inline `<1.0>`-style tags are display timings for this renderer. The `m1c4fr/it/sp/ty.smk` variants exist because that one cutscene has text burned into the video instead.

### Soundtrack - Redbook CD audio

The music is **Redbook CD audio** on the game disc, played through Windows **MCI** (`game.exe` calls `mciSendCommandA` against the `cdaudio` device). It's not a file in the install tree, so the track listing depends on a rip of the disc's audio tracks. The Fraunhofer MP3 ACM codec (`L3CODECP.ACM`) ships alongside so the OS can decode MP3-in-WAV, but the sampled `SOUNDS/*.wav` are all plain PCM. The singleplayer demo has no disc and instead bundles `TRACK2.WAV` (16 kHz mono PCM, ~4:19) as a stand-in loop.
