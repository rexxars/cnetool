/**
 * A single `Key:Value` pair parsed from a text-config `.dat` file.
 */
export interface ConfigEntry {
  /** The key, trimmed (text before the first `:`). */
  key: string
  /** The value, trimmed (text after the first `:`). */
  value: string
}

/**
 * Options for `parseConfig`.
 */
export interface ParseConfigOptions {
  /**
   * Match `Key:Value` pairs anywhere via a `bareword:printable` pattern instead
   * of parsing line by line. Use for text interleaved with binary, such as the
   * deobfuscated `data3.bin` / `data4.bin` stat tables.
   */
  scan?: boolean
}

/**
 * The `MAPMTX.DAT` affine transform that maps world coordinates to minimap
 * pixels.
 */
export interface MapMatrix {
  /** The 9 matrix values, row-major (a 3×3 affine; the last row is `0 0 1`). */
  values: number[]
}

/** Decoded raw pixels: top-down, row-major, `channels` bytes per pixel (RGB or RGBA). */
export interface RawImage {
  width: number
  height: number
  /** 3 (RGB) or 4 (RGBA). */
  channels: number
  data: Uint8Array
}

/** An RGB color, each channel 0-255. */
export interface RgbColor {
  r: number
  g: number
  b: number
}

/** A 3D position in world coordinates. */
export interface Vector3 {
  x: number
  y: number
  z: number
}

/**
 * A single light source from a `LIGHTS.DAT` file.
 */
export interface LightSource {
  /** Light id (sequential within the file). */
  id: number
  /** Effective range/radius of the light. */
  range: number
  /** Light color. */
  color: RgbColor
  /** Light position in world coordinates. */
  position: Vector3
}

/**
 * A single polygon face of a {@link Mesh}.
 */
export interface MeshFace {
  /** Indices into the mesh's vertex array (3 = triangle, 4 = quad, …). */
  vertices: number[]
  /** Face color. */
  color: RgbColor
  /** Opacity, 0 (transparent) - 255 (opaque). */
  alpha: number
  /**
   * Raw render-flags byte. Decoded bits (internal-flag mapping confirmed; gameplay
   * names not): `0x04` = use raw color (else color is scaled), `0x20`/`0x40`/`0x80`
   * pass through to render flags. See `docs/formats.md`.
   */
  flags: number
  /** Texture id, or `null` when the face is untextured (raw value `0xffff`). */
  texId: number | null
  /** Per-face-vertex UV coordinates (same length as `vertices`), or `null` if untextured. */
  uv: Array<[number, number]> | null
}

/**
 * A 3D mesh parsed from an `objects.dat` "project" blob.
 */
export interface Mesh {
  /** Vertex positions in world coordinates. */
  vertices: Vector3[]
  /** Polygon faces. */
  faces: MeshFace[]
}

/**
 * A part placed at one or more **body-local offsets** (in the model's own −Y-up
 * space). The engine seats each sub-object at `body position + offset` (via its
 * `SetPosition`), drawing the part mesh relative to that - so this is how the
 * steam tank's side tracks sit at ±20 lateral, how wheels reach the corners, etc.
 * Offsets are extracted from the vehicle's setup code in `ce.exe`.
 */
export interface ControllableInstancedPart {
  /** Project name of the part mesh. */
  project: string
  /** Body-local offsets to place a copy of the part at; one copy per entry. */
  at: Vector3[]
  /**
   * Optional yaw (degrees, about the vertical axis) applied to the part *before* its
   * offset - for a part the engine orients rather than just positions, eg the
   * motorcycle's front wheel, which the engine steers to follow the (baked-turned)
   * fork. Without it the wheel would render straight while the fork points off.
   */
  yaw?: number
}

/** A part of a controllable's geometry: a plain `string` (drawn once at the body
 * origin) or an {@link ControllableInstancedPart} (copies at body-local offsets). */
export type ControllablePart = string | ControllableInstancedPart

/**
 * Maps a *controllable* object's logical project name (lowercased) to the parts
 * that make up its visible geometry. See `controllableGeometry` and
 * `assembleLevel`'s `controllable` option.
 */
export type ControllableGeometryMap = Record<string, ControllablePart[]>

/**
 * One decoded instruction of a `.scr` script's bytecode (a stack-machine op).
 * The serialized form is `[u8 opcode][u16 operandLen][operand bytes]`.
 */
export interface ScriptInstruction {
  /** Byte offset of this instruction within its handler's bytecode. */
  offset: number
  /** Instruction index within the handler (jump targets reference this). */
  index: number
  /** Raw opcode byte (`0x00`-`0x10`). */
  opcode: number
  /** Short mnemonic, eg `add`, `pushvar`, `call`, `jz`. */
  mnemonic: string
  /**
   * Decoded operand: a variable index (`pushvar`), float (`pushf`), string
   * (`pushs`/`call`), or a target instruction index (`jmp`/`jz`); `null` for the
   * operand-less ops (operators, `pop`).
   */
  arg: number | string | null
}

/** One event handler of a parsed `.scr` script. */
export interface ScriptHandler {
  /** Handler/event name, eg `startup`, `Touched`. */
  name: string
  /**
   * Number of parameters the handler declares, or `-1` when it couldn't be
   * recovered (multi-handler scripts). The shared globals occupy the variable
   * slots before the params, so `globalCount = paramBytes / 4 − paramCount`.
   */
  paramCount: number
  /** The handler's decoded bytecode. */
  code: ScriptInstruction[]
}

/** A parsed `.scr` script - see `parseScript`. */
export interface ParsedScript {
  /** Header word0 - total variable storage in bytes: `(globals + params) × 4`. */
  paramBytes: number
  /** Decoded event handlers. */
  handlers: ScriptHandler[]
}

/** A `REF*` builtin call recovered from a script, with its literal arguments. */
export interface LevelCall {
  name: string
  /** Evaluated literal arguments (numbers/strings, with simple arithmetic folded); `NaN` for a non-constant arg. */
  args: (number | string)[]
}

/** A level's ambient configuration, resolved from its `mainscr.scr` `startup` `REF*` calls - see `getLevelInfo`. */
export interface LevelInfo {
  /** Terrain, from `REFSetLandscape(name, sky, _, fogDistance)` (eg level 128 → `dm1`). */
  landscape?: {name: string; sky: string; fogDistance: number}
  /** Wave-bob amplitude, from `REFSetWater` - water levels come from the terrain mesh, not this (absent when the script sets none). */
  water?: {amplitude: number}
  /** Directional lighting, from `REFLightColor` / `REFLightMin` / `REFLightDirection`. */
  light: {color?: RgbColor; min?: RgbColor; direction?: Vector3}
  /** Horizon/fog backdrop colour, from `REFBackColor`. */
  backColor?: RgbColor
  /** Sky-dome texture, from `REFSetPlanet(texture, flag)`. */
  planet?: {texture: string; flag: number}
  /** Weather, from `REFSetWeatherType(type, _)`. */
  weather?: {type: number}
  /** Footstep/ground sound set, from `REFSetGroundSounds(a, b)`. */
  groundSounds?: [string, string]
  /** Every `REF*` call in the `startup` handler, with literal args (raw, in order). */
  calls: LevelCall[]
}

/**
 * A placed object instance from a level's `data1.bin`.
 */
export interface Placement {
  /** Instance name, eg `aagun3_03` (strip the trailing `_NN` for the project name). */
  name: string
  /** World position. */
  position: Vector3
  /**
   * 3×3 rotation matrix (9 values). Stored row-major but applied with the
   * engine's row-vector convention, `world = vertex · M` (see `transformMesh`).
   */
  rotation: number[]
}

/**
 * A placed object instance from a level's text `World.dat` - the same data as a
 * {@link Placement} (so it is usable anywhere a `Placement` is), plus which
 * keyword introduced it.
 */
export interface WorldEntry extends Placement {
  /**
   * The entry keyword: `Name` places an object; `Dele` is an edit/removal
   * directive seen in patch files (eg the unofficial 1.42 `World.dat`).
   */
  kind: 'Name' | 'Dele'
}

/**
 * One localized string within a dialogue entry.
 */
export interface Translation {
  /** Language tag as written in the file, eg `Eng`, `Fre`, `Ger`. */
  language: string
  /** The text, with surrounding quotes removed. Empty if untranslated. */
  text: string
}

/**
 * A single dialogue line, identified by its filename and translated into each
 * of the file's languages.
 */
export interface DialogueEntry {
  /** Dialogue id, eg `SPYOUWIL` (matches a sound file). */
  filename: string
  /** One {@link Translation} per language, in file order. */
  translations: Translation[]
}

/**
 * A parsed dialogue file (`DIALOGUE.DAT`).
 */
export interface DialogueFile {
  /** Language count declared by the `Languages:` header (0 if absent). */
  languageCount: number
  /** Dialogue entries, in file order. */
  entries: DialogueEntry[]
}

/**
 * One language's block of a briefing file (`MISSION.DAT`, `ENDBRF.DAT`),
 * delimited by a `//<language>:----` line.
 */
export interface BriefingSection {
  /** Language tag from the delimiter, eg `Eng`, `Fre`. */
  language: string
  /** The block's body text, verbatim except for trimmed surrounding blank lines. */
  text: string
}

/**
 * A single entry parsed from an archive's table of contents. This is generic:
 * it describes the named blob and where it lives, without interpreting the
 * payload.
 */
export interface ArchiveEntry {
  /** Original name as stored in the table of contents, eg `Water.tga` or `TankPjb`. */
  name: string
  /** Absolute byte offset into the archive of this entry's data blob. */
  dataOffset: number
  /** Byte length of the stored blob. */
  blobLength: number
}

/**
 * The fully parsed table of contents of an archive.
 */
export interface ParsedArchive {
  /** Entry count declared in the archive header. */
  declaredCount: number
  /** Parsed entries, in the order they appear in the archive. */
  entries: ArchiveEntry[]
}

/**
 * Image geometry of a texture entry, read from its blob's partial TGA header.
 */
export interface TextureInfo {
  /** Image width in pixels. */
  width: number
  /** Image height in pixels. */
  height: number
  /** Bits per pixel. Observed values are 24 and 32. */
  depth: number
  /** TGA image descriptor byte (alpha-channel bit count and origin). */
  descriptor: number
}

/** How an entry was extracted. */
export type ExtractedKind = 'tga' | 'raw'

/**
 * An extracted entry. Texture entries are rebuilt into standalone TGA files
 * (`kind: 'tga'`); every other entry is returned as its raw stored blob
 * (`kind: 'raw'`).
 */
export interface ExtractedEntry {
  /** File name to write, equal to the entry's name. */
  name: string
  /** The entry this was extracted from. */
  entry: ArchiveEntry
  /** File contents: a complete TGA for textures, or the raw blob otherwise. */
  data: Uint8Array
  /** Whether `data` is a rebuilt TGA or the raw stored blob. */
  kind: ExtractedKind
}

/**
 * The host multiplayer match settings persisted in `servinfo.dat` - four
 * little-endian uint32 fields (16 bytes). Written by the game host on session
 * end and reloaded on the next host start, so these settings survive restarts.
 */
export interface ServerInfo {
  /** Kill limit that ends the round (0 = no limit). */
  fragLimit: number
  /** Score limit that ends the round (0 = no limit). */
  scoreLimit: number
  /** Time limit in **minutes** that ends the round (0 = no limit). */
  timeLimit: number
  /**
   * Map-rotation target: the level number to switch to when a round ends.
   * `0` disables rotation. When rotation is on, the host advances this by one
   * each round, wrapping to `128` (No Man's Land) once the next level number is
   * not found in `LEVELS.NFO`.
   */
  nextMap: number
}

/** One line of `LEVELS.NFO`: a level's display name and its numeric id. */
export interface LevelIndexEntry {
  /** Display name, eg `No mans land` (the `Name:` field). */
  name: string
  /** Numeric level id / `LEVEL<n>/` folder number (the `Val:` field). */
  number: number
}

/**
 * A Codename Eagle multiplayer server's status, as recovered from a GameSpy
 * `\status\` query (see {@link queryServer}) or a LAN beacon fallback. This is
 * the base record without the per-player roster; {@link GameServer} adds
 * `players`.
 */
export interface GameServerStatus {
  /** Server IPv4 address (dotted quad). */
  ip: string
  /** UDP port the GameSpy query was answered on (default `4711`). */
  queryPort: number
  /** UDP game/session port the server advertises (`hostport`, usually `24711`). */
  gamePort: number
  /** Advertised server name (`hostname`). */
  name: string
  /** Game version with the `cneagle` prefix stripped, eg `1.43` (`gamever`). */
  version: string
  /** Current map name (`mapname`). */
  map: string
  /** Game mode (`gametype`); the stock modes are the three named here. */
  gameType: 'ctf' | 'deathmatch' | 'teamplay' | (string & {})
  /** Players currently connected (`numplayers`). */
  numPlayers: number
  /** Maximum player slots (`maxplayers`). */
  maxPlayers: number
  /** Round time limit in minutes, `0` = no limit (`timelimit`). */
  timeLimit: number
  /** Kill limit that ends the round, `0` = no limit (`fraglimit`). */
  fragLimit: number
  /** Score limit that ends the round, `0` = no limit (`scorelimit`). */
  scoreLimit: number
  /** Whether team play is on (`teamplay`). */
  teamplay: boolean
  /** Measured query round-trip in milliseconds, if it was timed. */
  ping?: number
  /** Where the server was discovered - the internet list or a LAN beacon. */
  source: 'internet' | 'lan'
}

/** A {@link GameServerStatus} including the connected-player roster. */
export interface GameServer extends GameServerStatus {
  /** The connected players (empty if none). */
  players: GamePlayer[]
}

/** One connected player from a GameSpy `\players\` / `\status\` reply. */
export interface GamePlayer {
  /** Player nickname (`player_N`). */
  nickname: string
  /** Kills (`frags_N`). */
  frags: number
  /** Deaths (`deaths_N`). */
  deaths: number
  /** Skill value (`skill_N`); unused by the stock game, usually `0`. */
  skill: number
  /** Reported latency in milliseconds (`ping_N`). */
  ping: number
  /** Team (`team_N`), eg `red` / `blue`; empty in non-team modes. */
  team: string
}

/**
 * A parsed Codename Eagle LAN beacon - the 24-byte `'D'` announcement a host
 * broadcasts about once a second to UDP `:210`. The beacon carries no IP; the
 * receiver uses the datagram's source address (see {@link discoverLanServers}).
 */
export interface LanBeacon {
  /** Server name (NUL-terminated, from offset 14). */
  name: string
  /** Players currently connected (beacon byte 12 minus one). */
  numPlayers: number
  /** Maximum player slots (beacon byte 13 minus one). */
  maxPlayers: number
}

/** A LAN host discovered by {@link discoverLanServers}: its address + beacon. */
export interface LanServer {
  /** Source IPv4 address the beacon arrived from (dotted quad). */
  ip: string
  /** The parsed beacon payload. */
  beacon: LanBeacon
}
