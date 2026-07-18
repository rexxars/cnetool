import {describe, expect, test} from 'vitest'

import {decodeMenuInfo, encodeMenuInfo, formatMenuInfo, parseMenuInfo} from '../src/index.ts'

const BLOCK_SIZE = 272
const PAYLOAD_SIZE = 816

/** Write a NUL-padded ASCII tag/string at an offset. */
function writeAscii(data: Uint8Array, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) data[offset + i] = value.charCodeAt(i)
}

function writeU16(data: Uint8Array, offset: number, value: number): void {
  data[offset] = value & 0xff
  data[offset + 1] = (value >> 8) & 0xff
}

/**
 * Build a known 816-byte plaintext payload: the three tagged blocks with a
 * representative set of PlayInfo + OptionsMenu field values.
 */
function buildPlain(): Uint8Array {
  const p = new Uint8Array(PAYLOAD_SIZE)
  writeAscii(p, 0, 'PlayInfo')
  writeAscii(p, BLOCK_SIZE, 'LevelsDone')
  writeAscii(p, BLOCK_SIZE * 2, 'OptionsMenu')

  // PlayInfo (block 0)
  p[0x10] = 128 // last level (MP map)
  p[0x11] = 1 // multiplayer flag
  p[0x13] = 16 // max players
  p[0x15] = 1 // network protocol = TCP/IP
  p.set([62, 212, 89, 142], 0x16) // last server IP
  writeAscii(p, 0x1a, 'MyServer') // host name
  writeAscii(p, 0x42, 'Rexxie') // player name
  p[0x57] = 1 // game mode = ctf
  writeU16(p, 0x58, 2) // savegame slot 2
  writeU16(p, 0x5a, 1) // team = blue

  // OptionsMenu (block 2, base 544)
  const om = BLOCK_SIZE * 2
  p[om + 0x10] = 190 // soundfx
  p[om + 0x11] = 51 // music
  p[om + 0x12] = 16 // channels
  p[om + 0x13] = 255 // detail = max
  p[om + 0x14] = 128 // graphicFX = medium
  p[om + 0x15] = 1 // renderer = Direct3D
  writeU16(p, om + 0x16, 1400) // width
  writeU16(p, om + 0x18, 1050) // height
  p[om + 0x1a] = 32 // colour depth
  p[om + 0x1d] = 3 // language = italian
  p[om + 0x21] = 1 // subtitles on
  return p
}

describe('decodeMenuInfo / encodeMenuInfo', () => {
  test('round-trips an 816-byte payload at the plaintext layer', () => {
    const plain = buildPlain()
    const file = encodeMenuInfo(plain)
    expect(decodeMenuInfo(file)).toEqual(plain)
  })

  test('encoded file has the 8-byte header with uncompressedSize = 816', () => {
    const file = encodeMenuInfo(buildPlain())
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
    expect(view.getUint32(0, true)).toBe(PAYLOAD_SIZE)
    expect(view.getUint32(4, true)).toBe(file.byteLength - 8)
  })

  test('throws on a payload that is not exactly 816 bytes', () => {
    expect(() => encodeMenuInfo(new Uint8Array(800))).toThrow(/816/)
  })

  test('throws on a header that is too small', () => {
    expect(() => decodeMenuInfo(new Uint8Array(4))).toThrow(/8-byte header/)
  })

  test('throws when the body length exceeds the file', () => {
    const file = new Uint8Array(12)
    new DataView(file.buffer).setUint32(4, 999, true) // compressedSize past the end
    expect(() => decodeMenuInfo(file)).toThrow(/truncated/)
  })
})

describe('parseMenuInfo', () => {
  test('reads the PlayInfo and OptionsMenu fields by block tag', () => {
    const info = parseMenuInfo(encodeMenuInfo(buildPlain()))
    expect(info).toEqual({
      lastLevel: 128,
      multiplayer: true,
      maxPlayers: 16,
      networkProtocol: 1,
      serverIp: '62.212.89.142',
      hostName: 'MyServer',
      playerName: 'Rexxie',
      gameMode: 1,
      saveSlot: 2,
      team: 1,
      soundVolume: 190,
      musicVolume: 51,
      soundChannels: 16,
      detail: 255,
      graphicFx: 128,
      renderer: 1,
      resolution: {width: 1400, height: 1050, depth: 32},
      language: 3,
      subtitles: true,
    })
  })
})

describe('formatMenuInfo', () => {
  test('patches only the requested field and preserves everything else', () => {
    const original = encodeMenuInfo(buildPlain())
    const patched = decodeMenuInfo(formatMenuInfo(original, {playerName: 'CEDemo'}))

    const baseline = buildPlain()
    expect(parseMenuInfo(formatMenuInfo(original, {playerName: 'CEDemo'})).playerName).toBe(
      'CEDemo',
    )

    // Every byte outside the 20-byte player-name field (0x42..0x55) is unchanged.
    for (let i = 0; i < baseline.length; i++) {
      if (i >= 0x42 && i < 0x42 + 20) continue
      expect(patched[i]).toBe(baseline[i])
    }
  })

  test('zero-fills the rest of a string field (no stale bytes)', () => {
    // Seed a long name, then overwrite with a short one.
    const original = encodeMenuInfo(formatMenuInfoPlain('LongPlayerName'))
    const patched = decodeMenuInfo(formatMenuInfo(original, {playerName: 'Al'}))
    // 'Al' + NUL, then zeros through the field end.
    expect(readField(patched, 0x42, 20)).toBe('Al')
    for (let i = 0x42 + 3; i < 0x42 + 20; i++) expect(patched[i]).toBe(0)
  })

  test('writes numeric enums and resolution parts independently', () => {
    const original = encodeMenuInfo(buildPlain())
    const info = parseMenuInfo(
      formatMenuInfo(original, {team: 0, renderer: 2, resolution: {depth: 16}}),
    )
    expect(info.team).toBe(0)
    expect(info.renderer).toBe(2)
    expect(info.resolution).toEqual({width: 1400, height: 1050, depth: 16})
  })

  test('round-trips the server IP', () => {
    const original = encodeMenuInfo(buildPlain())
    expect(parseMenuInfo(formatMenuInfo(original, {serverIp: '192.168.4.195'})).serverIp).toBe(
      '192.168.4.195',
    )
  })

  test('rejects a player name that overflows its field', () => {
    const original = encodeMenuInfo(buildPlain())
    expect(() => formatMenuInfo(original, {playerName: 'x'.repeat(20)})).toThrow(/at most 19/)
  })

  test('rejects an invalid IPv4 address', () => {
    const original = encodeMenuInfo(buildPlain())
    expect(() => formatMenuInfo(original, {serverIp: '1.2.3'})).toThrow(/invalid IPv4/)
  })
})

/** Read a NUL-terminated field back out (test helper mirroring the reader). */
function readField(data: Uint8Array, offset: number, size: number): string {
  let end = offset
  while (end < offset + size && data[end] !== 0) end++
  return String.fromCharCode(...data.subarray(offset, end))
}

/** Build a plaintext payload whose player name is set to a given value. */
function formatMenuInfoPlain(playerName: string): Uint8Array {
  const p = buildPlain()
  writeAscii(p, 0x42, playerName)
  return p
}
