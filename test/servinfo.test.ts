import {describe, expect, test} from 'vitest'

import {formatServerInfo, parseServerInfo} from '../src/index.ts'

/** Build a 16-byte servinfo.dat from four little-endian uint32 values. */
function bytes(frag: number, score: number, time: number, nextMap: number): Uint8Array {
  const data = new Uint8Array(16)
  const view = new DataView(data.buffer)
  view.setUint32(0, frag, true)
  view.setUint32(4, score, true)
  view.setUint32(8, time, true)
  view.setUint32(12, nextMap, true)
  return data
}

describe('parseServerInfo', () => {
  test('reads the four little-endian uint32 fields in order', () => {
    expect(parseServerInfo(bytes(10, 250, 30, 129))).toEqual({
      fragLimit: 10,
      scoreLimit: 250,
      timeLimit: 30,
      nextMap: 129,
    })
  })

  test('reads the shipped all-zero file as all-zero fields', () => {
    expect(parseServerInfo(new Uint8Array(16))).toEqual({
      fragLimit: 0,
      scoreLimit: 0,
      timeLimit: 0,
      nextMap: 0,
    })
  })

  test('throws when given fewer than 16 bytes', () => {
    expect(() => parseServerInfo(new Uint8Array(15))).toThrow(/16 bytes/)
  })
})

describe('formatServerInfo', () => {
  test('writes exactly 16 bytes of little-endian uint32 fields', () => {
    const data = formatServerInfo({fragLimit: 0, scoreLimit: 0, timeLimit: 30, nextMap: 129})
    expect(data).toEqual(bytes(0, 0, 30, 129))
  })

  test('round-trips through parseServerInfo', () => {
    const info = {fragLimit: 15, scoreLimit: 100, timeLimit: 20, nextMap: 128}
    expect(parseServerInfo(formatServerInfo(info))).toEqual(info)
  })
})
