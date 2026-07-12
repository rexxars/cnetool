import {describe, expect, test} from 'vitest'

import {deobfuscate, obfuscate, parseConfig} from '../src/index.ts'

describe('deobfuscate / obfuscate', () => {
  test('deobfuscate subtracts 0x78 and recovers text', () => {
    // "Name:" encoded by adding 0x78 to each byte.
    const encoded = Uint8Array.from([0xc6, 0xd9, 0xe5, 0xdd, 0xb2])
    expect(new TextDecoder('latin1').decode(deobfuscate(encoded))).toBe('Name:')
  })

  test('obfuscate is the inverse of deobfuscate', () => {
    const plain = new TextEncoder().encode('Armor:Heavy\nHealth:75')
    expect(deobfuscate(obfuscate(plain))).toEqual(plain)
  })

  test('wraps around the byte range', () => {
    expect(Array.from(deobfuscate(Uint8Array.from([0x00, 0x77, 0x78])))).toEqual([0x88, 0xff, 0x00])
  })
})

describe('parseConfig scan mode', () => {
  test('extracts Key:Value pairs from text interleaved with binary', () => {
    // A deobfuscated-style record: text fields separated by binary noise.
    const buf = Uint8Array.from([
      ...new TextEncoder().encode('Name:airplane'),
      0x00,
      0x8a,
      0x1c,
      0x03, // binary field
      ...new TextEncoder().encode('Health:75'),
      0xff,
      0x01, // binary field
      ...new TextEncoder().encode('Firedelay:2'),
    ])
    expect(parseConfig(buf, {scan: true})).toEqual([
      {key: 'Name', value: 'airplane'},
      {key: 'Health', value: '75'},
      {key: 'Firedelay', value: '2'},
    ])
  })

  test('round-trips through obfuscate for the stat-table workflow', () => {
    const plain = new TextEncoder().encode('Name:tank\x00\x01\x02Armor:Heavy')
    const entries = parseConfig(deobfuscate(obfuscate(plain)), {scan: true})
    expect(entries).toEqual([
      {key: 'Name', value: 'tank'},
      {key: 'Armor', value: 'Heavy'},
    ])
  })
})
