// @env node
import {deflateSync, inflateSync} from 'node:zlib'

import {
  MENUINFO_BLOCK_SIZE,
  MENUINFO_KEY1,
  MENUINFO_KEY2,
  MENUINFO_PAYLOAD_SIZE,
  MENUINFO_STRUCT_OFFSET,
} from './constants.ts'
import type {MenuInfo} from './types.ts'

const decoder = new TextDecoder('latin1')

/** Encode a Latin-1 string to bytes (all `menuinfo` strings are single-byte). */
function latin1Bytes(value: string): Uint8Array {
  const out = new Uint8Array(value.length)
  for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff
  return out
}

const KEY1 = latin1Bytes(MENUINFO_KEY1)
const KEY2 = latin1Bytes(MENUINFO_KEY2)

// Field offsets, block-relative (tag is 0x00-0x0f, struct body starts at 0x10).
const PLAY = {
  lastLevel: 0x10,
  multiplayer: 0x11,
  maxPlayers: 0x13,
  networkProtocol: 0x15,
  serverIp: 0x16,
  hostName: 0x1a,
  playerName: 0x42,
  gameMode: 0x57,
  saveSlot: 0x58,
  team: 0x5a,
}
const OPTIONS = {
  soundVolume: 0x10,
  musicVolume: 0x11,
  soundChannels: 0x12,
  detail: 0x13,
  graphicFx: 0x14,
  renderer: 0x15,
  width: 0x16,
  height: 0x18,
  depth: 0x1a,
  language: 0x1d,
  subtitles: 0x21,
}
const HOST_NAME_SIZE = 40
const PLAYER_NAME_SIZE = 20

/** A partial set of {@link MenuInfo} fields to overwrite; see {@link formatMenuInfo}. */
export interface MenuInfoPatch {
  playerName?: string
  hostName?: string
  serverIp?: string
  networkProtocol?: number
  team?: number
  gameMode?: number
  maxPlayers?: number
  lastLevel?: number
  multiplayer?: boolean
  saveSlot?: number
  soundVolume?: number
  musicVolume?: number
  soundChannels?: number
  detail?: number
  graphicFx?: number
  renderer?: number
  language?: number
  subtitles?: boolean
  resolution?: {width?: number; height?: number; depth?: number}
}

/** Subtract a cyclic key from every byte, in place (mod 256). */
function subtractKey(data: Uint8Array, key: Uint8Array): void {
  for (let i = 0; i < data.length; i++) data[i] = (data[i]! - key[i % key.length]!) & 0xff
}

/** Add a cyclic key to every byte, in place (mod 256). */
function addKey(data: Uint8Array, key: Uint8Array): void {
  for (let i = 0; i < data.length; i++) data[i] = (data[i]! + key[i % key.length]!) & 0xff
}

/**
 * Decode a `menuinfo.dat` file to its 816-byte plaintext payload (three
 * 272-byte blocks). Reverses the two-layer cipher and the zlib compression:
 * strip {@link MENUINFO_KEY1} from the body, inflate, then strip
 * {@link MENUINFO_KEY2}.
 *
 * @param data - Raw `menuinfo.dat` bytes.
 */
export function decodeMenuInfo(data: Uint8Array): Uint8Array {
  if (data.byteLength < 8) {
    throw new Error('menuinfo.dat too small: missing the 8-byte header')
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const uncompressedSize = view.getUint32(0, true)
  const compressedSize = view.getUint32(4, true)
  if (data.byteLength < 8 + compressedSize) {
    throw new Error(
      `menuinfo.dat truncated: header claims ${compressedSize} body bytes, have ${data.byteLength - 8}`,
    )
  }

  const body = Uint8Array.from(data.subarray(8, 8 + compressedSize))
  subtractKey(body, KEY1)
  const inflated = inflateSync(body)
  if (inflated.length !== uncompressedSize) {
    throw new Error(
      `menuinfo.dat: inflated ${inflated.length} bytes, header expected ${uncompressedSize}`,
    )
  }

  const plain = Uint8Array.from(inflated)
  subtractKey(plain, KEY2)
  if (plain.length !== MENUINFO_PAYLOAD_SIZE) {
    throw new Error(
      `menuinfo.dat: expected a ${MENUINFO_PAYLOAD_SIZE}-byte payload, got ${plain.length}`,
    )
  }
  return plain
}

/**
 * Encode an 816-byte plaintext payload back to `menuinfo.dat` bytes - the
 * inverse of {@link decodeMenuInfo}. Adds {@link MENUINFO_KEY2}, deflates, adds
 * {@link MENUINFO_KEY1}, and prepends the 8-byte header. The output round-trips
 * through {@link decodeMenuInfo}, but is not byte-identical to a game-written
 * file (the deflate stream differs).
 *
 * @param plain - The 816-byte payload.
 */
export function encodeMenuInfo(plain: Uint8Array): Uint8Array {
  if (plain.length !== MENUINFO_PAYLOAD_SIZE) {
    throw new Error(`menuinfo payload must be ${MENUINFO_PAYLOAD_SIZE} bytes, got ${plain.length}`)
  }

  const mid = Uint8Array.from(plain)
  addKey(mid, KEY2)
  const body = Uint8Array.from(deflateSync(mid))
  addKey(body, KEY1)

  const out = new Uint8Array(8 + body.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, mid.length, true)
  view.setUint32(4, body.length, true)
  out.set(body, 8)
  return out
}

/** Find a 272-byte block by its NUL-padded tag (eg `PlayInfo`). */
function findBlock(plain: Uint8Array, tag: string): number {
  for (
    let offset = 0;
    offset + MENUINFO_BLOCK_SIZE <= plain.length;
    offset += MENUINFO_BLOCK_SIZE
  ) {
    if (readString(plain, offset, MENUINFO_STRUCT_OFFSET) === tag) return offset
  }
  throw new Error(`menuinfo.dat: "${tag}" block not found`)
}

/** Read a NUL-terminated Latin-1 string from a fixed-size field. */
function readString(data: Uint8Array, offset: number, fieldSize: number): string {
  let end = offset
  const limit = offset + fieldSize
  while (end < limit && data[end] !== 0) end++
  return decoder.decode(data.subarray(offset, end))
}

/** Write a Latin-1 string into a fixed field: value + NUL + zero-fill. */
function writeString(data: Uint8Array, offset: number, fieldSize: number, value: string): void {
  const bytes = latin1Bytes(value)
  if (bytes.length > fieldSize - 1) {
    throw new Error(
      `"${value}" is ${bytes.length} bytes; this field holds at most ${fieldSize - 1} (plus a terminator)`,
    )
  }
  data.fill(0, offset, offset + fieldSize)
  data.set(bytes, offset)
}

/** Read a 4-octet IPv4 as a dotted-quad string. */
function readIp(data: Uint8Array, offset: number): string {
  return `${data[offset]}.${data[offset + 1]}.${data[offset + 2]}.${data[offset + 3]}`
}

/** Write a dotted-quad IPv4 into 4 octets. */
function writeIp(data: Uint8Array, offset: number, value: string): void {
  const octets = value.split('.').map((part) => Number.parseInt(part, 10))
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`invalid IPv4 address: "${value}"`)
  }
  for (let i = 0; i < 4; i++) data[offset + i] = octets[i]!
}

/**
 * Parse `menuinfo.dat` into a {@link MenuInfo}. Locates the `PlayInfo` and
 * `OptionsMenu` blocks by tag and reads the confirmed fields; numeric fields
 * keep their raw byte values (the enum meanings are on {@link MenuInfo}).
 *
 * @param data - Raw `menuinfo.dat` bytes.
 */
export function parseMenuInfo(data: Uint8Array): MenuInfo {
  const plain = decodeMenuInfo(data)
  const pi = findBlock(plain, 'PlayInfo')
  const om = findBlock(plain, 'OptionsMenu')
  const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength)

  return {
    lastLevel: plain[pi + PLAY.lastLevel]!,
    multiplayer: plain[pi + PLAY.multiplayer]! !== 0,
    maxPlayers: plain[pi + PLAY.maxPlayers]!,
    networkProtocol: plain[pi + PLAY.networkProtocol]!,
    serverIp: readIp(plain, pi + PLAY.serverIp),
    hostName: readString(plain, pi + PLAY.hostName, HOST_NAME_SIZE),
    playerName: readString(plain, pi + PLAY.playerName, PLAYER_NAME_SIZE),
    gameMode: plain[pi + PLAY.gameMode]!,
    saveSlot: view.getUint16(pi + PLAY.saveSlot, true),
    team: view.getUint16(pi + PLAY.team, true),
    soundVolume: plain[om + OPTIONS.soundVolume]!,
    musicVolume: plain[om + OPTIONS.musicVolume]!,
    soundChannels: plain[om + OPTIONS.soundChannels]!,
    detail: plain[om + OPTIONS.detail]!,
    graphicFx: plain[om + OPTIONS.graphicFx]!,
    renderer: plain[om + OPTIONS.renderer]!,
    resolution: {
      width: view.getUint16(om + OPTIONS.width, true),
      height: view.getUint16(om + OPTIONS.height, true),
      depth: plain[om + OPTIONS.depth]!,
    },
    language: plain[om + OPTIONS.language]!,
    subtitles: plain[om + OPTIONS.subtitles]! !== 0,
  }
}

/**
 * Rewrite `menuinfo.dat` with a set of field overrides, preserving every other
 * byte. Decodes the original, overwrites only the fields present in `patch`
 * (string fields are NUL-terminated and zero-filled), and re-encodes. All other
 * blocks and any unmapped bytes round-trip untouched.
 *
 * @param original - The existing `menuinfo.dat` bytes to edit.
 * @param patch - The fields to overwrite.
 */
export function formatMenuInfo(original: Uint8Array, patch: MenuInfoPatch): Uint8Array {
  const plain = decodeMenuInfo(original)
  const pi = findBlock(plain, 'PlayInfo')
  const om = findBlock(plain, 'OptionsMenu')
  const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength)

  if (patch.playerName !== undefined) {
    writeString(plain, pi + PLAY.playerName, PLAYER_NAME_SIZE, patch.playerName)
  }
  if (patch.hostName !== undefined)
    writeString(plain, pi + PLAY.hostName, HOST_NAME_SIZE, patch.hostName)
  if (patch.serverIp !== undefined) writeIp(plain, pi + PLAY.serverIp, patch.serverIp)
  if (patch.networkProtocol !== undefined) plain[pi + PLAY.networkProtocol] = patch.networkProtocol
  if (patch.team !== undefined) view.setUint16(pi + PLAY.team, patch.team, true)
  if (patch.gameMode !== undefined) plain[pi + PLAY.gameMode] = patch.gameMode
  if (patch.maxPlayers !== undefined) plain[pi + PLAY.maxPlayers] = patch.maxPlayers
  if (patch.lastLevel !== undefined) plain[pi + PLAY.lastLevel] = patch.lastLevel
  if (patch.multiplayer !== undefined) plain[pi + PLAY.multiplayer] = patch.multiplayer ? 1 : 0
  if (patch.saveSlot !== undefined) view.setUint16(pi + PLAY.saveSlot, patch.saveSlot, true)
  if (patch.soundVolume !== undefined) plain[om + OPTIONS.soundVolume] = patch.soundVolume
  if (patch.musicVolume !== undefined) plain[om + OPTIONS.musicVolume] = patch.musicVolume
  if (patch.soundChannels !== undefined) plain[om + OPTIONS.soundChannels] = patch.soundChannels
  if (patch.detail !== undefined) plain[om + OPTIONS.detail] = patch.detail
  if (patch.graphicFx !== undefined) plain[om + OPTIONS.graphicFx] = patch.graphicFx
  if (patch.renderer !== undefined) plain[om + OPTIONS.renderer] = patch.renderer
  if (patch.language !== undefined) plain[om + OPTIONS.language] = patch.language
  if (patch.subtitles !== undefined) plain[om + OPTIONS.subtitles] = patch.subtitles ? 1 : 0
  if (patch.resolution) {
    const {width, height, depth} = patch.resolution
    if (width !== undefined) view.setUint16(om + OPTIONS.width, width, true)
    if (height !== undefined) view.setUint16(om + OPTIONS.height, height, true)
    if (depth !== undefined) plain[om + OPTIONS.depth] = depth
  }

  return encodeMenuInfo(plain)
}
