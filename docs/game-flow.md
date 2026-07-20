# Game flow & data model

How Codename Eagle ties its data formats together - from boot to gameplay. The data-model overview is inferred from file structure; the engine flow below is traced from the Ghidra decompile of `ce.exe` 1.41 (image base `0x400000`), so the `FUN_<addr>` references are real call sites.

## The data model, top down

```
LEVELS.NFO ──┐  (level name ↔ id)
             v
LEVEL<n>/ ───────────────────────────────────────────────┐
  MOBJS.DAT      object instances: Name + Type            │
     │  Type ──> a .scr script (GLOBAL/ or per-level)     │
     │  Name ──> sometimes a per-instance .scr (<name>.<n>)│
  mainscr.scr    the level's master script                │
  World.DAT/data1.bin   object placements (text/binary)   │
  data2.bin      AI entities + patrol routes              │
  MAPMTX/LIGHTS  minimap projection, lighting             │
  DIALOGUE/MISSION/BRIEF/ENDBRF   localized text          │
  terrain = objects.dat project land<n>/level<n>          │
                                                          v
shared assets ── objects.dat (models/"projects")  textures.dat (textures)
                 ANM/*.anm (animations)           SOUNDS/*.wav (audio)
                 data3.bin (unit stats)           data4.bin (weapon stats)
```

The unifying concept is the **"project"** (the engine's word for an object/model, from developer **Refraction Games** - the same `REF` that prefixes the script API). `objects.dat` is the project library; instances of projects are placed into levels, given behavior by `.scr` scripts, and driven at runtime by the `REF*` script API.

## Engine lifecycle, at a glance

`WinMain` (`FUN_00485ae0`) does Win32/DirectX init, then hands off to one giant lifecycle function, **`FUN_004438c0`**, which is the whole post-boot game: it runs the menu, loads the selected level, runs the per-frame loop, tears the level down, and loops back. The phases below are sections of that one function.

## Boot

`WinMain` (`FUN_00485ae0`) runs the global, level-independent init:

1. Opens an error log (`c:\error.log` etc.), registers the window class and creates the **"Codename: Eagle"** window (`FUN_00486120`).
2. High-resolution timer (`QueryPerformanceCounter`, `FUN_00486280` - the `FUN_004862d0` timestamp used to log every load step).
3. **DirectInput** (`FUN_00483560`): keyboard (logs `"DirectInput - keyboard created device"`), mouse, joystick. **DirectDraw/Direct3D** are set up per the video options (`FUN_00442060` → `InitD3D` `FUN_0045c530`, reading `"SetOptions: ScreenResX %d…"`).
4. Global input config: `KEYCONF.DAT` / `KEYDEFS.DAT` (`FUN_00441490`, honoring an optional `InvertMouseY`); menu/profile state from `menuinfo.dat`.

> Note: textures (`texcache`/`textures.dat`), the object/project table (`objects.dat`, `FUN_00480190`), and the stat tables (`data3.bin`/`data4.bin`) are **not** loaded at boot - they load **per level** (see below), as part of the cache/world load rather than as a global init step. `lang.dat`/`os.dat`, sometimes assumed to exist, are not present in any shipped copy.

## Command-line arguments

Two distinct cmdline consumers run from the lifecycle function (`FUN_004438c0`).

### `+flags` - the launch interface (`FUN_004426a0`)

Space-separated, each token **`+`-prefixed** (parsing stops at the first non-`+`). The binary's own usage dump (`+h`) documents most of them; the parser adds two it doesn't advertise:

| Flag                              | Effect                                                                                                                                                                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `+host [port]`                    | host a game; optional trailing `%d` overrides the UDP game port (default `24711`). Writes the shared port variable `DAT_004c26d0` - see `network.md` § Configuring the ports.                                                                         |
| `+connect <ip>:<port>`            | join a server (`sscanf "%d %d %d %d %d"` = 4 octets + port); the `:port` writes the **same** `DAT_004c26d0` as `+host`, so it defaults to `24711` too                                                                                                 |
| `+maxplayers <2-30>`              | clamped to ≤ 30                                                                                                                                                                                                                                       |
| `+name "<s>"`                     | player name (≤ 19 chars stored; no character validation here - the in-game sanitizer applies later, see [§ Player names](#player-names--in-game-text))                                                                                                |
| `+team red\|blue\|auto`           | team (→ `DAT_00557558`)                                                                                                                                                                                                                               |
| `+hostname "<s>"`                 | server name (≤ 39 chars)                                                                                                                                                                                                                              |
| `+map "<name>"`                   | resolve a `LEVELS.NFO` name → level index                                                                                                                                                                                                             |
| `+game deathmatch\|ctf\|teamplay` | gametype (→ `DAT_00557557` = 0/1/2)                                                                                                                                                                                                                   |
| `+dedicated`                      | dedicated mode (`DAT_0053fa6c = 3`)                                                                                                                                                                                                                   |
| `+h`                              | **undocumented** - print the usage string and exit                                                                                                                                                                                                    |
| `+edit "<map>"`                   | **undocumented** - built-in level-editor mode: forces `maxplayers = 1`, selection byte `0xfa`/250, and copies the quoted map directory name into `DAT_00557480` (missing/unquoted name = fatal `wrong edit mode, mapname %s`). See § Level 250 below. |

**A `+host` or `+connect` is mandatory.** After the token loop, unless the parse saw `+host` (mode 3), `+connect` (mode 4) or `+edit`, the parser logs `no host/join in arglist error` and pops a MessageBox (`ShowErrorMessageBox` `0x486190` = `MessageBoxA`) whose body is **the raw command line echoed back verbatim**, then rejects the launch (return 0). So `ce.exe +name "joe"` alone shows you your own arguments in an error box - the flag itself parsed fine. Two more parsing quirks: the settings are bracketed by a `menuinfo.dat` load at parse start (`LoadMenuInfo` `0x4400c0`) and save at parse end (`SaveMenuInfo` `0x440080`), so accepted flag values **persist into the profile**; and between flags the scanner just skips to the next `+` _anywhere_ - even mid-word - so an unquoted value containing `+` resumes flag-matching inside it (`+name foo+dedicated` turns on dedicated mode).

**Quoting is mandatory for string values.** The string extractor (`ParseQuotedValue` `0x442dc0`) returns null unless the value starts with a literal `"` in the raw command line: an unquoted `+game deathmatch` is **silently ignored** (no error, no log echo; the setting keeps its `menuinfo.dat` default). There is no escape mechanism, so a value can contain any byte except `"` (a backslash is literal - the engine reads `GetCommandLine` raw, with no argv-style backslash processing); a value longer than 255 chars between the quotes is dropped whole, not truncated. Numeric values (`+host <port>`, `+maxplayers`) are `sscanf`'d and need no quotes. This bites under Wine, which only re-quotes argv elements containing spaces when rebuilding the Windows command line (`+hostname "CE Server"` survives, `+game "deathmatch"` arrives unquoted and is dropped; `start "" /wait` re-parses argv and has the same problem). Workaround: launch via a `.bat`, since `cmd` passes the batch line to `CreateProcess` verbatim.

**`+dedicated` details** (verified live, hosting under Wine headless): with `+host` it takes the engine's real server path. It skips the menu, cutscenes and video init (`FUN_00483800`, gated on `DAT_0053fa6c & 1`), minimizes and retitles the window ("Codename: Eagle dedicated server"), and allocates a "Codename: Eagle server console" (`FUN_004436b0`: `AllocConsole` + `WriteConsoleA`). A window is still created, so a display must exist (Xvfb suffices; no GPU needed). `+connect`/join clears the flag (`DAT_0053fa6c = 0`), so dedicated is host-only. The dedicated host doesn't count as a player: the GameSpy status reply reports `maxplayers` as N-1 and `numplayers` 0 with no one connected.

**Tick loop and player count.** The per-tick update is `FUN_00477640`, called from ~11 sites (the in-game run loop `FUN_0047a6e0`, the `WaitForLocalPlayer` join loop `FUN_0047a790`, and several host/wait loops around `0x47a900`-`0x47b000`). None of the driving loops has a frame limiter or `Sleep`: an idle dedicated server free-runs and pins a core. The raw session player count (including the host slot) is `DAT_00554f00`; the GameSpy getters subtract the dedicated bit: `numplayers = FUN_00472160() = DAT_00554f00 - (DAT_0053fa6c & 1)` and `maxplayers = FUN_00472180() = DAT_004de780 - (DAT_0053fa6c & 1)` (hence the N-1 reporting). Hooking `FUN_00477640`'s prologue with a conditional `Sleep` when dedicated and `FUN_00472160() <= 0` throttles an empty server to ~20 Hz with no effect once a player connects.

### Level 250 - the built-in editor, and why the 1.36 folder trick broke in 1.41

Level number **250** (`0xfa` in the running-level global `DAT_004c2d14`) is the engine's edit/debug mode. The per-feature checks are scattered as `== 0xfa` comparisons and are **byte-identical across 1.36/1.41/1.42/1.43**: the chat-line `place <object>` handler (`FUN_0043bff0`), the numpad/`~` placement + tab-map editor (in the lifecycle loop `FUN_004438c0`), shoot-to-delete (`FUN_0044f0e0` swaps the bullet callback), the debug overlay + god-mode auto-enable at level load, and the `world.dat` write-back. The full control map and the complete `== 0xfa` inventory are in § The editor's controls below. The community method for 1.36 (documented in fan mapmaking guides) was: copy a level into a `level250\` directory, add a `Val:250` entry to `LEVELS.NFO`, host a game on it, and you're in the editor.

That stopped working in 1.41 not because the editor changed, but because **1.41 repurposed the `level250` directory name as an indirection for the new `+edit` flag**:

- The `+edit "<map>"` parser (`FUN_004426a0`) stores the quoted directory name in `DAT_00557480` - the **only** writer of that global.
- The global fopen wrapper `FUN_00468f50` (0x468f50) got a new hook: any path beginning `level250\` (compared with `_strnicmp`, so `LEVEL250\World.DAT` matches too) is rewritten to `sprintf("%s\\%s", DAT_00557480, path + 9)` before the open. 1.36 has no such code (the string `level250` does not exist in the 1.36 binary; its wrapper opens paths verbatim).
- `SetScriptPath` (`FUN_004885e0`) similarly substitutes `DAT_00557480` for the script directory when the level is 250, and GameSpy init (`FUN_00423bd0`) is skipped.

So in 1.41, hosting a `Val:250` level from the menu still enters edit mode, but every file open of `LEVEL250\...` is redirected to `<empty>\...` (the `+edit` buffer is zero-initialized BSS) - i.e. the root of the current drive - and the load dies on the first missing level file. The `level250\` folder itself is never read. The editor still works in 1.41/1.42 via `ce.exe +edit "<dir>"`, which is exactly what the redirect was built for; `+edit "level250"` reproduces the old 1.36 behavior (the rewrite maps `level250\` onto itself). A trivial patch to restore the folder trick would be to skip the rewrite in `FUN_00468f50` when `DAT_00557480[0] == 0`.

### The editor's controls

All keyboard reads go through the DirectInput helper `FUN_00483770(scancode)` - it returns `keystate[scancode] & 0x80` on the 256-byte state array at `DAT_005523b8` - so these are **physical DirectInput scancodes, independent of NumLock**. The whole editor input block lives in the lifecycle loop `FUN_004438c0`. Two things gate it: the **`` ` ``/`~` key (grave, `0x29`)** is a per-frame _mode switch_ (released → object nudge; held → tab-map matrix editor), and object placement first needs a "held" preview object spawned via the chat command `place <object>` (`FUN_0043bff0` sets the preview handle `DAT_004c1830`).

**Adding an object.** Type `place <object>` in the chat line to spawn a ghost/preview, then position it with the numpad (offsets accumulate in camera-relative axes via `FUN_0043b890`, re-applied each frame by `FUN_0043bdb0`, which also copies the camera's orientation onto the object). `~` must **not** be held:

| Key      | Scancode | Action                                                    |
| -------- | -------- | --------------------------------------------------------- |
| Numpad 8 | `0x48`   | move +Z                                                   |
| Numpad 2 | `0x50`   | move −Z                                                   |
| Numpad 4 | `0x4B`   | move −X                                                   |
| Numpad 6 | `0x4D`   | move +X                                                   |
| Numpad 9 | `0x49`   | move −Y                                                   |
| Numpad 3 | `0x51`   | move +Y                                                   |
| Numpad 0 | `0x52`   | reset the offset to zero (re-center on camera)            |
| Numpad 5 | `0x4C`   | **stamp/commit** the object (with a key-release debounce) |
| L-Shift  | `0x2A`   | step-size modifier (scales the nudge by `_DAT_004a13b8`)  |

Numpad 5 runs `FUN_0043b980`: spawns a real object of the held type, copies the preview's position + orientation onto it, clears the preview flags, and **appends the block to `LEVEL<n>\world.dat`** (opened via the fopen wrapper; path format `level%d\world.dat`). So the write-back happens per-stamp, not only on exit.

**Deleting an object - shoot it.** In edit mode the gun-fire setup `FUN_0044f0e0` sets the projectile's on-hit callback (`obj+0x30c`) to `LAB_0043b730` instead of the normal impact handler `LAB_00450180`. That edit-mode handler (Ghidra leaves it undecompiled - it's only address-referenced; disassembly shows it calls `FUN_0043b5a0` at `0x43b775`/`0x43b7c5`/`0x43b802`) opens `LEVEL<n>\world.dat` in mode `"r+t"`, scans records for the one whose **Translation X and Z** match the shot object, seeks back over its 4-byte record tag and overwrites it with `"Dele"` in place, then deletes `LEVEL<n>\faccache.bin` and `LEVEL<n>\data1.bin` so the level rebuilds without it. This is the live counterpart to the `place`+numpad-5 stamp, and produces exactly the `Dele:` tombstone documented in [formats.md](./formats.md) (the loader skips `Dele` blocks; the editor keeps them so it can list/restore). Objects are matched by X/Z only, so two stacked at the same X/Z are ambiguous to this routine. Data confirmed against 1.41: `DAT_004c1b70` = the literal bytes `Dele`, fopen mode `r+t`, path `level%d\world.dat`.

**Tab-map (MAPMTX) matrix editor - `~` held.** Operates on the 3×3 matrix at `&DAT_004c2d18` (prints `EditMap Scale`):

| Key          | Scancode      | Action                                                             |
| ------------ | ------------- | ------------------------------------------------------------------ |
| Numpad 4 / 6 | `0x4B`/`0x4D` | translate matrix X (`DAT_004c2d20`)                                |
| Numpad 8 / 2 | `0x48`/`0x50` | translate matrix Y (`DAT_004c2d2c`)                                |
| Numpad 1     | `0x4F`        | scale ×0.98 (shrink)                                               |
| Numpad 3     | `0x51`        | scale ×1.02 (grow)                                                 |
| Numpad 5     | `0x4C`        | **save** → writes `LEVEL<n>\MAPMTX.DAT` (9 floats, `FUN_00447270`) |

This is the same set of physical keys the community guides describe as "`~`+arrows to move, End/PgDn to scale, `~`+numpad-5 to save": with NumLock off, numpad 4/8/6/2 are the arrows, numpad 1 = End, numpad 3 = PgDn. DirectInput reads the scancode regardless of NumLock, so both descriptions point at the same keys.

**Sun/horizon - `~` held, edit mode only.** `N` (`0x31`) / `M` (`0x32`) decrement/increment `SunDirection` (`DAT_004de960`); `K` (`0x25`) applies and prints `horizonRotation %f SunDirection %f` (debounced).

**Debug / camera (not strictly editor-gated).** `F10` (`0x44`) toggles the debug/god overlay (`DAT_004d3c94`, needs `DAT_004d7abc==1`); `PrintScreen`/`SysRq` (`0xB7`) writes a screenshot `shot<d>.tga` via the per-renderer grab pointer `DAT_0053fae4` (`ecx`=filename, `edx`=mode; PrintScreen passes 0). The D3D routine `D3DGrabScreen` (`0x460180`) captures at a hardcoded **640×480**: it mallocs `640*480*3`, `StretchBlt`s (HALFTONE) the front buffer — rendered at `DAT_005555b0`×`DAT_005555b4` — down into a 640×480 surface, and hands it to the TGA writer (`0x4646c0`). The Glide routine (`0x4631c0`) captures at the render resolution. The savegame path (`0x441ebe`) calls the same routine with `edx=1` to derive the save/load-menu thumbnail via `HalfScalePic` (`0x464770`), which repeatedly halves the capture until it fits the target box (640×480 → 80×60). The shot number is a zero-initialized stack local of `FUN_004438c0` incremented per shot (`0x4443cf`) — it restarts at 1 every run, and the TGA writer `fopen`s `"wb"`, so a new session overwrites the previous one's screenshots. The handler polls the key at three sites (`0x4443a9` trigger + `0x4443b4`/`0x4443c4` wait-for-release debounce) via the key-down poll `0x483770` (`cl` = DIK code → `eax` = 0/0x80 from the DirectInput state array `0x5523b8`). Chat/console keys live in `ConsoleKeyHandler` (`0x43b310`): from the idle state, `F7` (`0x41`) opens chat (team chat when `DAT_004de794` is set, else all-chat), `F8` (`0x42`) opens all-chat, and the console opens on `F12` (`0x58`, poll at `0x43b421`) **or `LAlt`+`S`** (`0x38`+`0x1F`); the selected mode is written to `[menuobj+0x9c]` (1/2 = chat, 4 = console). The console predates 1.41 (present since at least 1.33). `F11` (`0x57`) is polled nowhere in 1.41 or 1.43 — when checking whether the engine uses a key, byte-scan the binary for `b1 <key> e8 →0x483770` call patterns rather than grepping the decompile (pointer-reached handlers only appear in the dump because they are force-seeded via `scripts/ghidra/force-functions-ce.txt`). Free-camera rotate/pan (`FUN_0047cca0`), gated on the spectator cam being active (`object[0x286] > 0`) rather than on edit mode: `PgUp` `0xC9`, `Insert` `0xD2`, `Delete` `0xD3`, `PgDn` `0xD1`, `End` `0xCF`, `Home` `0xC7`; view presets `F1`–`F4` (`0x3B`–`0x3E`) and `F9` (`0x43`).

#### The complete `DAT_004c2d14 == 0xfa` inventory

Every place the engine branches on edit mode (`1.41` addresses; behavior identical on 1.42/1.43):

- **`FUN_00423bd0` (0x423bd0)** - GameSpy init is **skipped** in edit mode.
- **`FUN_0043bff0` (0x43bff0)** - the `place <object>` chat command: resolves object-name aliases (`aship`/`plane`/`plane2`/`battleshipa`/…), spawns the preview handle `DAT_004c1830`, and turns god-mode on (`DAT_004d7abc = 1`).
- **`FUN_004438c0` (0x4438c0), level-load** - on entering an edit-mode level, **god-mode auto-enables** (`DAT_004d7abc = 1`) and the **debug overlay** turns on (`DAT_004d3c94 = -1`).
- **`FUN_004438c0`, input loop** - the `~`/numpad placement + tab-map editor above. (Firing god-mode in a _non_-edit multiplayer level instead prints `godmode on in multiplayer` and refuses.)
- **`FUN_0044f0e0` (0x44f0e0)** - swaps the bullet on-hit callback to the shoot-to-delete handler (above).
- **object update (~0x443…, near line 43432)** - a preview/held object (flag `0x20000`) is **frozen** in edit mode: its flags are cleared and recomputed but the normal drop/simulate path (`FUN_00475ae0` gravity + `FUN_00440170`) is skipped, so it doesn't fall while you position it. (Vehicles still fall once _entered_ - see [new-level-recipe.md](./new-level-recipe.md).)
- **`FUN_004764b0` (0x4764b0)** - the player/camera spawns at world **origin** `(0,0,0)` and is snapped to the terrain surface (raycast via `FUN_00470700`).
- **`FUN_00473a60` (0x473a60)** - the per-change network state broadcast (`thunk_FUN_004242e0`) is a **no-op** in edit mode (single-player, nothing to sync).
- **player-join handler (0x476…, near line 70881)** - a joining player is **refused** (early return sending message `0x23`), consistent with `+edit` forcing `maxplayers = 1`.
- **`FUN_0047aef0` (0x47aef0) and the periodic update (near line 76037)** - the GameSpy master-server heartbeat (`FUN_00423ba0` / `FUN_004240b0`) is **skipped** in edit mode.
- **`SetScriptPath` `FUN_004885e0` (0x4885e0)** - the script directory is redirected to the `+edit` buffer `DAT_00557480` (see the `+edit` indirection above).

### `4711 <N>` - the dev autostart token (not a port)

`FUN_004438c0` first tries `sscanf(cmdline, "4711 %d", &N)`. **`4711` is a magic literal** (the "4711" eau-de-cologne constant - also, by coincidence, the GameSpy query port `0x1267` and a "menu returned > 4711" ceiling check), **not** a port here. On a match it calls the menu-command dispatcher `FUN_00441d80(N)` directly, skipping the menu UI:

| N                | Menu command                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2                | **leave the current level** - if one is loaded (`DAT_004c2d14 != -1`), tears down the level + re-execs `ce.exe` (`_spawnl(_P_OVERLAY,"ce.exe")`) for a clean restart. From a **cold boot** (no level loaded) it instead launches the **last-played level** (`menuinfo.dat` `PlayInfo` `0x10`) as a local, non-networked game - so `4711 2` replays the last map, MP or SP, with no server. |
| **3**            | **host / start a game** (`DAT_004de78c \|= 1`)                                                                                                                                                                                                                                                                                                                                             |
| **4**            | **join / reconnect** (`\|= 2`) - dials the **last-connected server IP** in `menuinfo.dat` (`PlayInfo` `0x16`), so `4711 4` rejoins the last server unattended                                                                                                                                                                                                                              |
| 5 / 6            | **save** (5) / **load** (6) a game via `sg<N>.dat`. Load reads the slot `<N>` from `menuinfo.dat` (`PlayInfo` `0x58`, or `temp.dat` for the quick-save sentinel); save also writes a `MENU_sg<N>.tga` thumbnail and is a no-op unless an SP level is active with the player alive                                                                                                          |
| 7                | back / cancel                                                                                                                                                                                                                                                                                                                                                                              |
| else (incl. `1`) | `default:` → the `DirectStartGame` assert (crash)                                                                                                                                                                                                                                                                                                                                          |

So `ce.exe 4711 3` autostarts a **hosted game** on the current/default map (LEVEL128) - the fast load-test path. `N == -1` just opens the menu. If the cmdline is neither `4711 …` nor `+…`, the `+flags` parser runs instead.

## Player names & in-game text

Player names pass through **three independent gates**, which is why the menu accepts characters that never survive into a game:

1. **Input** (`+name` / the MENUDLL name field / `menuinfo.dat`) stores up to **19 raw bytes** with no validation - MENUDLL renders with its own `menufont.tga`, not the in-game font.
2. **The name sanitizer** (`SanitizePlayerName` `0x476ef0`) runs when a player enters a session - `SetPlayerStatus` (`0x476fe0`; the engine's own assert names it) calls it for the local name and for every remote name off the wire, then truncates the result to **10 chars** into the per-player status array (`0x554f20`, stride `0x12`). The sanitizer:
   - strips leading spaces; an empty result becomes **`no name`**;
   - a 1-2 char result gets **`(XXXXXX)` appended** (short names would be illegible in the overhead tag);
   - otherwise each character outside `!`(`0x21`)-`}`(`0x7D`), plus the explicit blocklist **`_ - . , ^ ~ `` ` ``**, is overwritten with a literal **`X`**. The range test is a _signed_ char compare, so every byte ≥ `0x80` (all accented letters) is also X'd. The blocklist is exactly the small, hard-to-see-above-a-player punctuation. Space is in the excluded range too, so the usage string's own example `+name "joe black"` plays as `joeXblack`.
3. **The glyph atlas** (see [formats.md § Font textures](./formats.md#font-textures-font_1-font_4-font)) draws what's left; its one substitution that matters here is that `$` renders as **`€`**.

Net effective player-name alphabet in a session: `A-Z a-z 0-9` and `! " # $ % & ' ( ) * + / : ; < = > ? @ [ \ ] { | }` - with `$` displaying as `€` - minimum effective length 3, display length ≤ 10.

Chat/HUD text (the same draw path, `DrawChar` `0x43d170` / `DrawString` `0x43d100`) is _not_ sanitized - the full atlas incl. the CP850 letters and the icon cells is reachable there.

## Menu

The main menu is `FUN_004415a0` (called from the lifecycle function for the initial menu and again on every ESC / return-to-menu):

- Plays the startup cutscene reel (see § Cutscene playback below) and runs the menu loop.
- Level/campaign names come from `LEVELS.NFO` (`Name ↔ Val`, where `Val` is the `LEVEL<n>` folder number; 1-12 campaign, 128-132 bonus/multiplayer).
- A selection (or multiplayer/host parse) sets the selection global `DAT_00557510` (byte 0 = level number, byte 3 = max players; edit-mode forces `0xfa` / 250). The transition into level load copies it into the **running-level global**: `DAT_004c2d14 = DAT_00557510 & 0xff` - the copy lives at `0x4439b9` in the lifecycle function, immediately followed by `sprintf("LEVEL%d")` → `SetScriptPath` (`FUN_004885e0`).

### Cutscene playback

All cutscene playback funnels through a shared play-by-name routine, plus a boot-time list player (offsets/addresses verified byte-identical on 1.41/1.42/1.43):

- **The boot reel.** The menu function builds a NUL-terminated pointer array of exactly three paths on its stack at entry (`0x4415b8`..`0x4415d2`): `cutscn\logga.smk` (the Refraction Games logo), `cutscn\intro.smk` (the campaign intro movie) and `cutscn\m1c2.smk` (mission 1's opening cutscene). Each is prefixed with the Drive path (`sprintf "%s\%s"`, CDPath getter `FUN_0044c120`) and the array is handed to the Smacker list player `0x447c60`, which `SmackOpen`s each entry and **skips silently on failure** - why installs without the CD (or a copied `CUTSCN/` folder) show nothing at boot. The whole block is gated by `test esi,esi; je 0x441718` at `0x4416bd` on the menu function's arguments (the skip path and the after-playback path converge on identical code). Notably `m1c2.smk` appears in **no level script** - the boot reel is the only place it ever plays. (The community 1.50 patch skips the reel and plays intro + m1c2 once at campaign start instead.)
- **Play-by-name** `0x44c1a0` (fastcall, `ecx` = bare filename; `0x44c320` is a thin jmp alias): logs `"Try to play: %s"`, builds `<Drive>\cutscn\<name>` (`"%s\cutscn\%s"`), and plays; a missing file is logged and skipped. On **level 1** it substitutes the localized variants for `m1c4.smk` (`m1c4fr/it/sp/ty.smk`, switch at `0x44c1f4` on the language byte `DAT_0055763d`). Callers: `REFShowCutscene` (`0x48cdb0` pops the script string and tail-jumps here) and the hardcoded end-of-campaign credits at level 12 (`0x44485a`).
- **Menu commands 8/9** - the menu DLL driver (`0x442ef0`, which LoadLibrary's `MENUDLL.DLL` and calls its ordinal-2 entry) treats menudll return codes **8** and **9** as "view intro" / "view credits": handled at `0x442f4e`/`0x442f64` via a sibling single-file player (`0x442e80`, same `<Drive>\cutscn\` prefixing), then re-enters the menu.

## Input: two separate systems

Keyboard input is handled by **two independent paths that live in different binaries and never meet**. This is why some keys are rebindable in the menu and a much larger set (camera views, editor keys, screenshot, …) are not.

### 1. Configurable "actions" - `MENUDLL.DLL` + `lobby.exe`, networked

The 13 rebindable gameplay actions - the ones the `Configure keys` menu lists - are owned entirely by the menu DLL and the multiplayer helper, **not** `ce.exe`:

- **`KEYCONF.DAT` / `KEYDEFS.DAT`** hold the bindings (see [formats.md](./formats.md#text-config-family-keyvalue)). `KEYDEFS.DAT` is the name -> scancode dictionary; `KEYCONF.DAT` is the `Action:primary [secondary]` list.
- **`MENUDLL.DLL`** reads and writes `KEYCONF.DAT` and draws the config screen. Two facts make the action set effectively hardcoded despite the menu looking data-driven:
  - The **reader** pre-fills a fixed **13-slot** array, stores each line's binding **by line index** (the action name before the `:` is never parsed), and hard-requires the count to equal `0xd` or it bails with `error bindkeydefs %d(i)!=%d(SIZE_OF_ACTIONS)`. So an action's identity is its **slot position**, not its name - and an extra line makes the whole file fail to load.
  - The **writer** is fully unrolled: 13 literal calls emitting `Fire:`, `UseItem:`, `ChangeItem:`, `DropItem:`, `Jump:`, `Pitch+:`, `Pitch-:`, `Roll+:`, `Roll-:`, `Forward+:`, `Forward-:`, `Yaw+:`, `Yaw-:`. The on-screen labels (`"FIRE"`, `"JUMP"`, …) are `.rdata` strings used both as the row label and as the in-menu registry key the binding is stored/looked-up under; they are **not** written to the file.
- **`lobby.exe`** (not `ce.exe`) resolves the 13 bindings, reads the DirectInput keyboard, and packs the current state into a **4-byte input frame** (`FUN_00409860`) sent as UDP type `0x02` to the host - abstracted "action intent", not scancodes (see [network.md](./network.md)). Even single-player runs through this host/slave path.
- `ce.exe`'s own keyconf loader (`FUN_00441490`) reads **only** the optional `InvertMouseY` line; it does not parse the bindings, and `FUN_00409860` isn't present in `ce.exe` at all.

Because the slot index is wired to a fixed bit in the wire frame and to fixed gameplay behavior, adding an action means bumping `SIZE_OF_ACTIONS` in **both** `MENUDLL.DLL` and `lobby.exe`, possibly widening the frame, and giving the new slot a consumer - i.e. touching the netcode. (One action is dual-purpose without any of that: `Jump:` also drops a bomb while flying - the community patch relabels it `Jump/drop bomb`, a `MENUDLL.DLL`-only string change.)

### 2. Hardcoded local keys - `ce.exe`, direct scancodes

Everything else - camera views (`F1`-`F4`/`F9`), the whole numpad/`~` editor set (see § The editor's controls), the screenshot key, camera rotate (`PgUp`/`End`/…), `F10`, Esc/Enter/Space - is read by `ce.exe` directly through the DirectInput helper **`FUN_00483770(scancode)`** (`keystate[scancode] & 0x80` on the 256-byte array at `DAT_005523b8`). There are **98** such reads; **77** are the literal form `mov cl, imm8 ; call FUN_00483770` (a one-byte scancode immediate). These keys are **local view/UI concerns**: not networked, not in `KEYCONF.DAT`, and not exposed by the menu.

Making these rebindable is therefore a **local** job in `ce.exe` (a binding table + loader + per-call-site detours), with no reason to route them through the 13-action system - the `mov cl, imm8` immediate is the whole binding. The input region is byte-identical across 1.41/1.42/1.43, so one patch set covers all three.

## Level load

With `DAT_004c2d14` set, the lifecycle function loads `LEVEL<n>/` in order (each step bracketed by a perf timestamp + log line):

1. **Subsystems** - `InitDialogueSystem` (`FUN_0042e800`), `InitInterfaceSystem` (`FUN_00438640`).
2. **Caches** - `LoadAllCacheFiles` (`FUN_004434e0`) reads `texcache`/`acache`/`scache`/ `ocache.bin`; `ocache` pulls in **`objects.dat`** (`FUN_00480190`). These are pure optimisation - missing ones are silently rebuilt on exit (see [`formats.md`](./formats.md#cache-files-cachebin)). Logs `"LoadAllCacheFiles - took %f seconds"`.
3. **World** - `FUN_004514b0` loads `LEVEL<n>/World.DAT`: the terrain (an `objects.dat` project `land<n>`/`level<n>`), object **placements** (`data1.bin` / `World.dat`), lighting (`LIGHTS.DAT`), and minimap projection (`MAPMTX.DAT`). Logs `"World and sounds loaded…"`.
4. **AI** - `FUN_0042b230` loads the `AIMap*` rasters (walkable mask + nav data); `AI.DAT` / `data2.bin` (AI entities + patrol routes, `FUN_0042a820`), which reaches the stat tables `data3.bin`/`data4.bin` (`FUN_004299b0`). Then `faccache.bin` (`FUN_00482560`).
5. **Player & vehicles** - `StartPlayer RED` (`FUN_0047ae60`), vehicles (`FUN_00477c40`).
6. **Bring-up** - briefing (`FUN_00445ff0`), in-game interface, then **`PrepareWorld`** (`FUN_0047a6c0`), a first `UpdateWorld` tick and a first render to prime everything, and `MakeAIMap` (`FUN_0042b840`). Logs `"TotalLoadTime %f seconds"`.

`MOBJS.DAT` (the `Name`/`Type` manifest), lights, and the minimap are read inside the World/ interface loaders rather than as separate top-level steps.

## Per-frame game loop

The loop is a `do`-while inside the lifecycle function. Each iteration:

1. **Input** - DirectInput keyboard poll (`FUN_00483680` → 256-byte keystate; re-`Acquire` on focus loss) and the Win32 message pump (`FUN_00485290`). ESC calls back into the menu.
2. **Render** - `FUN_00444ea0` (`DisplayWorld`): scene → camera → backend present.
3. **Simulation** - a time-gated scheduler (`FUN_0047a880`, decoupled from render via a tick counter) drives the per-object sim step (`FUN_00477640`) plus net/replay sync.

**Script callbacks are event-driven**, not run from a central per-frame walker: each trigger site resolves the handler by name with `Script_FindHandler` (`0x487150`) and invokes it with the arity-specific caller (`CallScriptOne` `0x487bf0`, etc.). `startup` fires on spawn; `killed`, `Touched`, `seeplayer`, `ItemUsed`, `EnterVehicle`, … fire from their respective subsystems during the sim step. The handlers call the `REF*` builtins, which is where every subsystem connects:

- `REFPlayDlg` → a `DIALOGUE.DAT` id → the matching `SOUNDS/DIALOGUE/*.wav`
- `REFPlayFX` → a `SOUNDS/FX/*.wav` clip
- `REFAddItem` / `REFChangePlayer` → weapons/stats from `data4.bin`
- `REFSpawnAI` → units from `data3.bin` / `objects.dat`
- `REFDoneObjective` / `REFEndGame` → mission progress (text from `MISSION.DAT`, end screen from `ENDBRF.DAT`)
- `REFShowCutscene` → `CUTSCN/*.SMK`

So the loop is: world + placed objects → scripts react to events → builtins move objects, play audio/dialogue, spawn AI, and advance objectives → mission ends.

### The fire pipeline, weapon cooldowns & the "8 trick"

Confirmed combat fields on the character object (all verified 1.41≡1.43):

| Offset                 | Meaning                                                                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `+0x44`                | held item id (byte; the input applier special-cases ids `0`, `0x28`, `0x39`, `0x3a`, `0x3c`, `0x3d`)                                                                                                                                                   |
| `+0x50/0x54/0x58/0x5c` | smoothed aim/fire values (written via the smoother `0x47aac0` with the per-character factor `+0x2a0`)                                                                                                                                                  |
| `+0x60`                | input bits; **bit 0 = fire trigger**                                                                                                                                                                                                                   |
| `+0x68`                | last-shot tick - **one shared clock per character**, not per weapon                                                                                                                                                                                    |
| `+0x6c`                | the held weapon's `FireDelay`, in ticks (from the `data4`/`mdata4` class record)                                                                                                                                                                       |
| `+0x7c`                | own object index (into the object pointer table `DAT_0053fa98`)                                                                                                                                                                                        |
| `+0x94`/`+0x98`        | held-item object indexes; the engine resolves identity as `[+0x98]` → object table → `[itemObj+0x2b4]` (project index), compared against `GetProjectIndexByName` (`FUN_00480360`, cached) - e.g. `"Detonat"` at `0x414cea`, `"SnipeGun"` at `0x414c62` |
| `+0x2b0`               | weapon animation progress (float 0..1)                                                                                                                                                                                                                 |
| `+0x2c4`               | switch state: `0`/`3` = ready (`3` is an alternate ready state reached from take-up state `5`; the update special-cases it for the sniper rifle), `4` = taking up → `0`, `5` = taking up → `3`                                                         |
| `+0x2c8`/`+0x2cc`      | switch start tick / take-up duration (float, ticks)                                                                                                                                                                                                    |

Per tick the order is **input first, then the character update**:

1. The input applier (`0x47ab50`) smooths aim into `+0x50..0x5c`, stores the input bits into `+0x60`, and calls the **fire-rate gate `FUN_0047ab20`** - the single fire throttle. Its only other caller is the AI fire path (`0x4201c6`), which sets the bit, calls the gate, and on survival calls the shot spawner (`0x407e30`).
2. The gate: with bit 0 set, if `now (DAT_0053fab0) - [+0x68] < [+0x6c]` it **vetoes by silently clearing bit 0** (input-driven animations still play - vetoed pulls animate but do nothing); otherwise it allows and **commits `[+0x68] = now`** in the same call.
3. The per-tick character update (`0x414ba0` region) advances the switch state machine and consumes the surviving fire bit. Consequence: on the tick a take-up completes, the gate ran while the state still read "taking up", yet its verdict is the one the real shot spawns from.

While a switch state is active (elapsed < the `+0x2cc` duration), the update **zeroes `[+0x68]` every tick** (`0x414be8`) - except the completion tick, whose branch flips the state (`4→0`/`5→3`) without zeroing, so the completion-tick gate commit survives and throttles the following ticks. Net effect: the take-up _replaces_ the fire delay - the first trigger pull after any weapon switch always fires. That is the root cause of the **"8 trick"** (re-selecting the held weapon trades the bazooka's 2 s delay for the ~1 s (36.4-tick) take-up). The fix is per-weapon cooldown ownership instead of the shared per-character clock.

The shared clock also means the delay is charged against the _character's_ last shot, whatever weapon fired it. Slot 7 is two weapons behind one key: the explosive stick is `data4` class 13 (`EXPPACK`, `FireDelay` 4 s SP / 3 s MP) while the detonator (the `Detonat` project) is class **4 - the grenade class** (`detonat.scr` sets `WEAPON_TYPE 4`).

### Projectile collision & the spontaneous explosion bug (SEB)

Projectiles (GunShot/STShot, spawned around `0x450850`/`0x44ea20` in 1.41) have no per-object think function; the generic physics pass integrates them and two collision passes test them each tick: object-vs-object (swept-AABB broadphase over a 16×16 grid of 1024-unit cells → swept segment-vs-face narrowphase `0x465750` → response `0x464ea0`, which fires the hit object's `+0x30c` on-hit handler) and object-vs-landscape (`DetectCollisions` `0x470c30` → per-object LandFace walk). A shot's on-hit handler (`0x450180`) ignores `fence`/`fence5` objects, kills the shot, and on a land hit confirms the face before the ground-hit effect - structurally identical in 1.36 and 1.41.

**The SEB (introduced in 1.41; the community 1.42 hid it per-map rather than fixing it, see below):** 1.41 added a vertical-band gate to `DetectCollisions`: the band is the min/max vertical coordinate over all land vertices (`0x46e210` → globals `0x4ce868`/`0x4ce864`). Objects past the band on the sky side skip terrain tests; objects past the **deepest land vertex** - only reachable by a projectile whose swept face test tunneled through the terrain mesh - hit a new out-of-world branch (`0x470d1e`): ownerless objects are silently removed, but an **owned** projectile calls its _owner's_ first child's damage handler with `3000.0f` damage and no attacker (`0x470d42`) - the shooter's own body takes 3000 damage → instant uncredited death. Almost certainly a typo for detonating the projectile itself. 1.36 has no band gate: tunneled shots simply fly on until their lifetime expires, which is why SEB is 1.41-only. The global trigger depth (deepest vertex per map) explains the per-map "seb points": tunneling near deep terrain crosses the threshold within the bullet's lifetime.

The community 1.42 patch changed **no engine code** (its `ce.exe` differs from 1.41 by one byte: the version getter `0x472060`, 141→142). It hid the bug per-map: a new `sebguard` project (a flat 14000×14000 plane, 4×4 quads) shipped in each MP level's `objects.dat` (a standalone 2621-byte file for levels without one, appended for Level133/248) and placed 4-6× per level in `World.dat`/`data1.bin` at a stored height just above the map's deepest vertex, so tunneled bullets hit the plane (a normal object-mesh collision) before reaching the trigger depth. SP levels never got sebguards, so SEB persists in single-player on 1.41+. The real fix is one byte: the owner test `je` at `0x470d26` (`74 2c` → `eb 2c`) makes every out-of-world projectile take the silent-removal path (1.36 behavior); byte-identical on 1.41/1.42/1.43.

## Level exit / transition

When the level ends, **teardown** (`FUN_00441a10`) tears down render/input/timers and calls the **cache-writer aggregate** (`FUN_00443430`), which rewrites `scrcache`/`acache`/`scache`/ `ocache`/`texcache.bin` from what the level actually used (only for real levels, not edit-mode). Then:

- **Next level** - `FUN_00441d80(level)` loads the next level number and the lifecycle loops back to the load phase.
- **Credits** - at level **12** (`if (DAT_004c2d14 == 0xc)`) the engine plays `credits.smk` and returns to the menu.
- **Return to menu** - ESC / quit paths fall back to `FUN_004415a0`.

## What this enables / blocks

- **Readable now:** the full `objects.dat` mesh format (vertices/faces/materials/UVs; terrain is `land<n>`/`level<n>` projects) with a **write path**, the `.scr` VM end-to-end (disassembler + decompiler + byte-exact compiler) with all `REF` builtins and callbacks, the per-level **placements** (`data1.bin`/`World.dat`, read+write), AI routes (`data2.bin`), `.anm` animations, textures, audio, and all text/config/stat tables. A whole level - terrain + placed objects - can be assembled into one scene (`cnetool level`).
- **Remaining:** assembling a fully from-scratch level; the spawn conventions are the main open question (see [`new-level-recipe.md`](./new-level-recipe.md)).
