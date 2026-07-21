import {describe, expect, test} from 'vitest'

import {
  deobfuscate,
  groupRecords,
  obfuscate,
  parseStatTable,
  parseUnitTable,
  serializeUnitTable,
  STAT_CHUNK_SIZE,
  type Unit,
} from '../src/index.ts'

// Build an obfuscated fixed-chunk unit table from field lines, mimicking the
// game's files: each field is one 0x7F-byte chunk (a `Key:Value` line + filler),
// and the whole thing is obfuscated.
function buildTable(lines: string[], fill = 0xab): Uint8Array {
  const plain = new Uint8Array(lines.length * STAT_CHUNK_SIZE).fill(fill)
  lines.forEach((line, i) => {
    const text = `${line}\n`
    for (let j = 0; j < text.length; j++) plain[i * STAT_CHUNK_SIZE + j] = text.charCodeAt(j) & 0xff
  })
  return obfuscate(plain)
}

// Decode a serialized table back into per-record key sequences (the deobfuscated
// leading `Key:Value` line of each slot), grouped by Name.
function recordKeySequences(data: Uint8Array): string[][] {
  return groupRecords(parseStatTable(data), 'Name').map((record) => record.map((f) => f.key))
}

const UNITS: Unit[] = [
  {name: 'airplane', armor: 'light', health: 75, fireDelay: 2},
  {name: 'gggun', armor: 'heavy', health: 150, fireDelay: 0.5},
  {name: 'crate', health: 30, fireDelay: 1.25}, // no armor
  {name: 'bunker', armor: 'none', health: 999, fireDelay: 0},
]

describe('parseUnitTable / serializeUnitTable', () => {
  test('round-trips units with and without armor and fractional fireDelay', () => {
    const bytes = serializeUnitTable(UNITS)
    expect(parseUnitTable(bytes)).toEqual(UNITS)
  })

  test('a unit without armor omits the Armor slot', () => {
    const bytes = serializeUnitTable([{name: 'crate', health: 30, fireDelay: 1}])
    expect(recordKeySequences(bytes)).toEqual([['Name', 'Health', 'Firedelay']])
  })

  test('emits the exact key spelling and order (Name, [Armor], Health, Firedelay)', () => {
    const bytes = serializeUnitTable(UNITS)
    expect(recordKeySequences(bytes)).toEqual([
      ['Name', 'Armor', 'Health', 'Firedelay'],
      ['Name', 'Armor', 'Health', 'Firedelay'],
      ['Name', 'Health', 'Firedelay'],
      ['Name', 'Armor', 'Health', 'Firedelay'],
    ])
    // The `Firedelay` key must have a lowercase 'd' (weapons use `FireDelay`).
    const fields = parseStatTable(bytes)
    expect(fields.some((f) => f.key === 'Firedelay')).toBe(true)
    expect(fields.some((f) => f.key === 'FireDelay')).toBe(false)
    // Armor is capitalized to the stock convention.
    const armorValues = fields.filter((f) => f.key === 'Armor').map((f) => f.value)
    expect(armorValues).toEqual(['Light', 'Heavy', 'None'])
  })

  test('serialized output length is a multiple of the chunk size', () => {
    const bytes = serializeUnitTable(UNITS)
    expect(bytes.length % STAT_CHUNK_SIZE).toBe(0)
    // 3 records × 4 slots + 1 record × 3 slots = 15 slots
    expect(bytes.length).toBe(15 * STAT_CHUNK_SIZE)
  })

  test('parses armor case-insensitively into the lowercased union', () => {
    const bytes = buildTable([
      'Name:tank',
      'Armor:LIGHT',
      'Health:100',
      'Firedelay:2',
      'Name:jeep',
      'Armor:none',
      'Health:50',
      'Firedelay:1',
      'Name:No', // "No" armor value maps to 'none'
      'Armor:No',
      'Health:10',
      'Firedelay:1',
    ])
    expect(parseUnitTable(bytes)).toEqual([
      {name: 'tank', armor: 'light', health: 100, fireDelay: 2},
      {name: 'jeep', armor: 'none', health: 50, fireDelay: 1},
      {name: 'No', armor: 'none', health: 10, fireDelay: 1},
    ])
  })

  test('trims whitespace from values', () => {
    const bytes = buildTable(['Name:  tank  ', 'Armor:  Heavy ', 'Health:  100 ', 'Firedelay:  2 '])
    expect(parseUnitTable(bytes)).toEqual([
      {name: 'tank', armor: 'heavy', health: 100, fireDelay: 2},
    ])
  })

  test('throws on an unrecognized armor value', () => {
    const bytes = buildTable(['Name:tank', 'Armor:Titanium', 'Health:100', 'Firedelay:2'])
    expect(() => parseUnitTable(bytes)).toThrow(/armor/i)
  })

  test('throws when a required field is missing', () => {
    const bytes = buildTable(['Name:tank', 'Armor:Heavy', 'Firedelay:2']) // no Health
    expect(() => parseUnitTable(bytes)).toThrow(/Health/i)
  })

  test('throws on an unexpected key sequence', () => {
    const bytes = buildTable(['Name:tank', 'Health:100', 'Firedelay:2', 'Speed:5'])
    expect(() => parseUnitTable(bytes)).toThrow()
  })

  test('parses the deobfuscated bytes it produces back to plain text (spot check)', () => {
    const bytes = serializeUnitTable([{name: 'tank', armor: 'heavy', health: 100, fireDelay: 2.5}])
    const plain = deobfuscate(bytes.subarray(0, STAT_CHUNK_SIZE))
    const nl = plain.indexOf(0x0a)
    expect(new TextDecoder('latin1').decode(plain.subarray(0, nl))).toBe('Name:tank')
  })
})
