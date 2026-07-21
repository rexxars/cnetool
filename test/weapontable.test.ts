import {describe, expect, test} from 'vitest'

import {
  groupRecords,
  obfuscate,
  parseStatTable,
  parseWeaponTable,
  serializeUnitTable,
  serializeWeaponTable,
  STAT_CHUNK_SIZE,
  type Unit,
  type WeaponTable,
} from '../src/index.ts'

// Decode a serialized table's leading `Key:Value` lines, in file order, as
// `key=value` strings (before the header is grouped into weapon records).
function fieldLines(data: Uint8Array): string[] {
  return parseStatTable(data).map((f) => `${f.key}=${f.value}`)
}

// Build an obfuscated weapon table from field lines, mimicking the game's files:
// one 0x7F chunk per line (`Key:Value` + filler), the whole thing obfuscated.
function buildWeaponBytes(lines: string[], fill = 0xab): Uint8Array {
  const plain = new Uint8Array(lines.length * STAT_CHUNK_SIZE).fill(fill)
  lines.forEach((line, i) => {
    const text = `${line}\n`
    for (let j = 0; j < text.length; j++) plain[i * STAT_CHUNK_SIZE + j] = text.charCodeAt(j) & 0xff
  })
  return obfuscate(plain)
}

const HEADER = [
  'Armor:  Heavy Light No',
  'gas:100,100,100',
  'bullet:11,21,100',
  'shell:100,100,100',
]

const TABLE: WeaponTable = {
  ammoDamage: {
    gas: {heavy: 100, light: 100, none: 100},
    bullet: {heavy: 11, light: 21, none: 100},
    shell: {heavy: 100, light: 100, none: 100},
  },
  weapons: [
    {
      index: 0,
      name: '0-GUN',
      ammoSpeed: 75,
      fireDelay: 1,
      damage: 5.5,
      ammoType: 'bullet',
      weaponLength: 3,
      sound: 'Sounds\\FX\\WGunFi.WAV',
    },
    {
      index: 1,
      name: '1-CANNON',
      ammoSpeed: 500.25,
      fireDelay: 2.5,
      damage: 120,
      ammoType: 'shell',
      weaponLength: 10,
      sound: 'Sounds\\FX\\cannon.WAV',
    },
  ],
}

describe('parseWeaponTable / serializeWeaponTable', () => {
  test('round-trips ammoDamage rows and weapons with fractional values', () => {
    const bytes = serializeWeaponTable(TABLE)
    expect(parseWeaponTable(bytes)).toEqual(TABLE)
  })

  test('output length is a multiple of the chunk size', () => {
    const bytes = serializeWeaponTable(TABLE)
    expect(bytes.length % STAT_CHUNK_SIZE).toBe(0)
    // 4 header slots + 2 weapons × 7 slots = 18 slots
    expect(bytes.length).toBe(18 * STAT_CHUNK_SIZE)
  })

  test('emits the header block first: Armor comment, then gas/bullet/shell rows', () => {
    const lines = fieldLines(serializeWeaponTable(TABLE))
    expect(lines[0]).toMatch(/^Armor=/) // ignored human comment slot, present
    expect(lines.slice(1, 4)).toEqual(['gas=100,100,100', 'bullet=11,21,100', 'shell=100,100,100'])
  })

  test('bullet matrix maps {heavy:11,light:21,none:100} <-> "bullet:11,21,100"', () => {
    const bytes = serializeWeaponTable(TABLE)
    expect(fieldLines(bytes)).toContain('bullet=11,21,100')
    expect(parseWeaponTable(bytes).ammoDamage.bullet).toEqual({heavy: 11, light: 21, none: 100})
  })

  test('a weapon record emits the exact 7-field order with FireDelay (capital D)', () => {
    const bytes = serializeWeaponTable(TABLE)
    const records = groupRecords(parseStatTable(bytes), 'Name')
    expect(records[0]!.map((f) => f.key)).toEqual([
      'Name',
      'AmmoSpeed',
      'FireDelay',
      'Damage',
      'AmmoType',
      'WeaponLength',
      'Sound',
    ])
    // Capital D (units use lowercase `Firedelay`).
    const keys = parseStatTable(bytes).map((f) => f.key)
    expect(keys).toContain('FireDelay')
    expect(keys).not.toContain('Firedelay')
  })

  test('index is the record position on parse', () => {
    const parsed = parseWeaponTable(serializeWeaponTable(TABLE))
    expect(parsed.weapons.map((w) => w.index)).toEqual([0, 1])
  })

  test('serialize ignores index and emits in array order (order is truth)', () => {
    const scrambled: WeaponTable = {
      ammoDamage: TABLE.ammoDamage,
      weapons: [
        {...TABLE.weapons[0]!, index: 99}, // "wrong" indices
        {...TABLE.weapons[1]!, index: 7},
      ],
    }
    const parsed = parseWeaponTable(serializeWeaponTable(scrambled))
    // Emitted in array order; parse re-derives index from position.
    expect(parsed.weapons.map((w) => w.name)).toEqual(['0-GUN', '1-CANNON'])
    expect(parsed.weapons.map((w) => w.index)).toEqual([0, 1])
  })

  test('parses AmmoType with mixed case and surrounding whitespace', () => {
    const raw = buildWeaponBytes([
      ...HEADER,
      'Name:0-GUN',
      'AmmoSpeed:75',
      'FireDelay:1',
      'Damage:5',
      'AmmoType:  ShElL ',
      'WeaponLength:3',
      'Sound:x.wav',
    ])
    expect(parseWeaponTable(raw).weapons[0]!.ammoType).toBe('shell')
  })

  test('throws on an unrecognized AmmoType value', () => {
    const raw = buildWeaponBytes([
      ...HEADER,
      'Name:0-GUN',
      'AmmoSpeed:75',
      'FireDelay:1',
      'Damage:5',
      'AmmoType:plasma',
      'WeaponLength:3',
      'Sound:x.wav',
    ])
    expect(() => parseWeaponTable(raw)).toThrow(/AmmoType/i)
  })

  test('throws when a required weapon field is missing or out of order', () => {
    const raw = buildWeaponBytes([
      ...HEADER,
      'Name:0-GUN',
      'Damage:5', // AmmoSpeed missing; Damage where AmmoSpeed expected
      'FireDelay:1',
      'AmmoType:bullet',
      'WeaponLength:3',
      'Sound:x.wav',
    ])
    expect(() => parseWeaponTable(raw)).toThrow(/AmmoSpeed/i)
  })

  test('throws when the leading Armor header slot is missing', () => {
    const raw = buildWeaponBytes([
      'gas:100,100,100',
      'bullet:11,21,100',
      'shell:100,100,100',
      'Name:0-GUN',
      'AmmoSpeed:75',
      'FireDelay:1',
      'Damage:5',
      'AmmoType:bullet',
      'WeaponLength:3',
      'Sound:x.wav',
    ])
    expect(() => parseWeaponTable(raw)).toThrow(/Armor/i)
  })

  test('throws when a non-finite number is serialized (weapon)', () => {
    const bad: WeaponTable = {
      ammoDamage: TABLE.ammoDamage,
      weapons: [{...TABLE.weapons[0]!, damage: Number.NaN}],
    }
    expect(() => serializeWeaponTable(bad)).toThrow(/finite|NaN/i)
  })
})

describe('serializeUnitTable non-finite guard (shared helper retrofit)', () => {
  test('throws when a unit number is non-finite', () => {
    const units: Unit[] = [{name: 'tank', health: Number.POSITIVE_INFINITY, fireDelay: 1}]
    expect(() => serializeUnitTable(units)).toThrow(/finite|Infinity/i)
  })
})
