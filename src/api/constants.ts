/**
 * The archive begins with a little-endian uint32 entry count.
 */
export const ENTRY_COUNT_OFFSET = 0
export const TOC_START_OFFSET = 4

/**
 * The table of contents is an array of fixed-size records. Each record is a
 * NUL-terminated, zero/garbage-padded name field followed by a little-endian
 * uint32 absolute offset to the entry's data blob.
 *
 * Verified identical across `textures.dat`, `MENU/menupics.dat` and
 * `objects.dat`. The padding bytes in the name field are uninitialized and
 * differ between files, but carry no meaning.
 */
export const RECORD_LENGTH = 17
export const NAME_FIELD_LENGTH = 13
export const OFFSET_FIELD_LENGTH = 4

/**
 * Texture payloads are stored as a TGA file with its constant first 8 header
 * bytes removed: id length (0), color map type (0), image type (2 =
 * uncompressed true-color) and the empty 5-byte color map specification. We
 * prepend these to rebuild a spec-compliant TGA.
 */
export const TGA_HEADER_PREFIX = Uint8Array.from([0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00])

/** Lower-cased file extension used to recognise texture entries. */
export const TGA_EXTENSION = '.tga'

/** Pixel depths supported by the texture reconstruction. */
export const SUPPORTED_DEPTHS = [24, 32]

/**
 * Byte length of the partial header retained in each texture blob:
 * x-origin (2), y-origin (2), width (2), height (2), pixel depth (1),
 * image descriptor (1).
 */
export const BLOB_HEADER_LENGTH = 10

/** Field offsets within a texture blob's partial header. */
export const BLOB_WIDTH_OFFSET = 4
export const BLOB_HEIGHT_OFFSET = 6
export const BLOB_DEPTH_OFFSET = 8
export const BLOB_DESCRIPTOR_OFFSET = 9

/**
 * Some config files (`data3.bin`, `data4.bin`) are lightly obfuscated by adding
 * this value to every byte. Subtract it to recover the original bytes.
 */
export const OBFUSCATION_KEY = 0x78

/**
 * `MAPMTX.DAT` is a 3×3 affine matrix stored as 9 row-major little-endian
 * float32 values (world coordinates → minimap pixels).
 */
export const MAP_MATRIX_VALUE_COUNT = 9
export const MAP_MATRIX_SIZE = MAP_MATRIX_VALUE_COUNT * 4

/**
 * `LIGHTS.DAT` is a header-less array of fixed 23-byte light records. The RGB
 * triplet is packed without padding, so the record is intentionally unaligned.
 */
export const LIGHT_RECORD_LENGTH = 23

/** `servinfo.dat` size: four little-endian uint32 fields. */
export const SERVER_INFO_SIZE = 16
export const LIGHT_RANGE_OFFSET = 0
export const LIGHT_ID_OFFSET = 4
export const LIGHT_COLOR_OFFSET = 8
export const LIGHT_POSITION_OFFSET = 11

/**
 * `menuinfo.dat` (the persisted menu profile / options / progress) codec. The
 * payload is three fixed 272-byte blocks (16-byte tag + 256-byte struct),
 * zlib-compressed under two layers of a cyclic byte-add cipher whose keys are
 * developer taunts baked into `ce.exe`. Decode subtracts KEY1 (outer, over the
 * compressed body) then inflates then subtracts KEY2 (inner, over the payload);
 * encode is the inverse.
 */
export const MENUINFO_KEY1 =
  "You really shouldn't be messing about with this file, you should be playing the game. You will find nothing in here you know ;-)"
export const MENUINFO_KEY2 =
  "Didn't you read the first message? I promise there is nothing in here."
/** One block: 16-byte tag + 256-byte struct. */
export const MENUINFO_BLOCK_SIZE = 272
/** Tag length; the struct body starts at this block-relative offset. */
export const MENUINFO_STRUCT_OFFSET = 16
/** Decoded payload size: three blocks. */
export const MENUINFO_PAYLOAD_SIZE = 816

/**
 * Network ports for multiplayer discovery / queries (all UDP).
 */
/** GameSpy query port - where a server answers `\status\`-style queries. */
export const GAMESPY_QUERY_PORT = 4711
/** Game/session (DirectPlay) port a server advertises as `hostport`. */
export const GAME_PORT = 24711
/** Port a host broadcasts its `'D'` LAN beacon to (and `iplist` binds). */
export const LAN_BEACON_PORT = 210

/** The community-run master server list (bare IPv4-per-line, `#` comments). */
export const IPLIST_URL = 'https://ceservers.net/iplist.txt'

/**
 * LAN beacon (`'D'` → `:210`) byte layout. The 24-byte payload is the type-3
 * status reply minus its 4-byte IP field. Confirmed against captured beacons
 * (incl. a 25-char name that disambiguates offsets 7 and 13).
 */
export const LAN_BEACON_TYPE = 0x44 // 'D'
/** Server-name length is stored here as `name_len + 7`. */
export const LAN_BEACON_NAMELEN_OFFSET = 7
/** Player count is stored here as `numPlayers + 1`. */
export const LAN_BEACON_PLAYERS_OFFSET = 12
/** Max-player count is stored here as `maxPlayers + 1`. */
export const LAN_BEACON_MAXPLAYERS_OFFSET = 13
/** The NUL-terminated server name starts here. */
export const LAN_BEACON_NAME_OFFSET = 14

/**
 * Script-VM enums - the symbolic names for the magic-number arguments to the
 * `REF` builtins. Sourced from the original CE script SDK header (`Global.h`,
 * shipped inside `LEVEL133`), cross-checked against the 1.41 engine.
 */

/**
 * `REFSetProjectVars(obj, slot, value)` slot selector. Each slot toggles a bit
 * in the object property word `[proj+0x2a8]`, stores a field, or installs a
 * behaviour handler. Names verified against the `0x48af20` switch.
 */
export const PROJECT_VAR = {
  GRAVITY: 0,
  MOVE: 1,
  ROTATE: 2,
  LANDCOLLISION: 3,
  OBJECTCOLLISION: 4,
  IMMATERIAL: 5,
  GLOWING: 6,
  INSTANCEMOD: 7,
  ITEM: 8,
  MASS: 9,
  CRUSHEDBYVEHICLE: 10,
  AFFECTEDBYEXPLOSION: 11,
  VISIBLE: 12,
  NO_ZBUFFER: 13,
  SOLID_MATERIAL: 14,
  BOMB_PROJECTILE: 15,
  IMMORTAL: 16,
  WEAPON_TYPE: 17,
  REMOVETRANSFACES: 18,
  TYPE_PROJECTILE: 19,
  TREEEXPLODEFUNCTION: 20,
  PROJHEALTH: 21,
}

/** `REFSetAIVars(name, slot, value)` slot selector (worker `0x4256d0`). */
export const AI_VAR = {
  LOOKFOR: 0,
  AWARE: 1,
  MORALE: 2,
  MODE: 3,
  USE: 4,
  TEAM: 5,
  SEERADIUS: 6,
  HEARRADIUS: 7,
  ATTACKRANGE: 8,
  DELETE: 9,
  AIMDEVIATION: 10,
  DROPBOMBS: 11,
}

/** Values for `AI_VAR.MODE` - bitflags, so they combine. */
export const AI_MODE = {
  ATTACK: 1,
  PATROL: 2,
  GUARD: 4,
  FOLLOW: 8,
  SPAWN: 16,
}

/**
 * `REFChangePlayer(player, stat, value)` / `REFReadPlayer(player, stat, →out)`
 * stat selector. Distinct from the vehicle stat table (`REFReadVehicleStat`).
 */
export const PLAYER_STAT = {
  HEALTH: 0,
  AMMO: 1,
  BULLETS: 1,
  ARMOR: 2,
  ABSORBS: 3,
  GAS: 4,
  SHELLS: 5,
  FUEL: 6,
  SETABSARMOR: 7,
  CLIPBULLETS: 8,
  CLIPSHELLS: 9,
  CLIPGAS: 10,
}

/** `REFSetScore(team, mode, value)` - arg 1 is a team, not a player. */
export const SCORE_TEAM = {TEAMA: 0, TEAMB: 1}
export const SCORE_MODE = {FLAG_SCORE: 0, KILLED_SCORE: 1}

/** `REFSetViewMode(mode, ...)` camera mode. */
export const VIEW_MODE = {INSIDE: 0, OUTSIDE: 1, FRONTFLYBY: 2, BEHINDCHASE: 3}

/** `HitItem(otherInx, playerType)` callback - the `playerType` arg. */
export const HITITEM_TYPE = {LOCALPLAYER: 0, OTHERPLAYER: 1, VEHICLE: 2}

/** `REFGetProVect(obj, type, →out)` direction selector; axis component vars. */
export const PROVECT_TYPE = {DOF: 0, UP: 1, RIGHT: 2}
export const AXIS_VAR = {XVAR: 0, YVAR: 1, ZVAR: 2}

/** `REFSetWeatherType(type)`. */
export const WEATHER_TYPE = {OFF: 0, SNOW: 1, RAIN: 2}

/** `SetLight` type. */
export const LIGHT_TYPE = {SPOTLIGHT: 0, NORMALLIGHT: 1}

/** General script literals. */
export const SCRIPT_MYSELF = -1
export const SCRIPT_LASTFRAME = 65535
export const MAX_PLAYER_BULLETS = 200
export const MAX_PLAYER_SHELLS = 50
export const MAX_PLAYER_GAS = 100

/**
 * Flat name→value table of every script constant, for the compiler to resolve a
 * symbolic argument name back to its number (the inverse of the decompiler's
 * symbolization - see `decompileScript`). Names are unique across the enums;
 * where a value has aliases (`AMMO`/`BULLETS`, `TRUE`/`ON`) each name resolves to
 * it. Kept in sync with the enums above.
 */
export const SCRIPT_CONSTANTS: Record<string, number> = {
  ...PROJECT_VAR,
  ...AI_VAR,
  ...AI_MODE,
  ...PLAYER_STAT,
  ...SCORE_TEAM,
  ...SCORE_MODE,
  ...VIEW_MODE,
  ...HITITEM_TYPE,
  ...PROVECT_TYPE,
  ...AXIS_VAR,
  ...WEATHER_TYPE,
  ...LIGHT_TYPE,
  // General literals last so they win any value-identical alias (e.g. OFF vs WEATHER_TYPE.OFF).
  MYSELF: -1,
  THIS: 0,
  TOPLAYER: 0,
  CAMERA: 0,
  CALL_NEXT_FRAME: 0,
  TRUE: 1,
  FALSE: 0,
  ON: 1,
  OFF: 0,
  LASTFRAME: 65535,
}
