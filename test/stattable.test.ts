import {describe, expect, test} from 'vitest'

import {
  deobfuscate,
  formatStatTable,
  groupRecords,
  obfuscate,
  packStatSlot,
  parseStatTable,
  setStatField,
  setStatValue,
  STAT_CHUNK_SIZE,
} from '../src/index.ts'

// Mimic the engine's unbounded deobfuscator: walk raw bytes `while (byte !== 0)`.
// Returns the index of the terminating 0x00 (or the buffer length if none).
function scanToTerminator(slot: Uint8Array): number {
  let i = 0
  while (i < slot.length && slot[i] !== 0) i++
  return i
}

// Build an obfuscated fixed-chunk table from field lines, mimicking the game's
// files: each field is one 0x7F-byte chunk (a `Key:Value` line + filler), and the
// whole thing is obfuscated. `fill` sets the post-line filler byte (the real files
// use non-zero garbage there; the engine ignores it).
function buildTable(lines: string[], fill = 0xab): Uint8Array {
  const plain = new Uint8Array(lines.length * STAT_CHUNK_SIZE).fill(fill)
  lines.forEach((line, i) => {
    const text = `${line}\n`
    for (let j = 0; j < text.length; j++) plain[i * STAT_CHUNK_SIZE + j] = text.charCodeAt(j) & 0xff
  })
  return obfuscate(plain)
}

const WEAPONS = [
  'Armor:  Heavy Light No',
  'Name:0-GUN',
  'AmmoSpeed:75.0',
  'Damage:5.0',
  'Name:1-MACHINEGUN',
  'AmmoSpeed:150.0',
  'Damage:30.0',
]

describe('parseStatTable', () => {
  test('reads one located field per 0x7F chunk', () => {
    const fields = parseStatTable(buildTable(WEAPONS))
    expect(fields).toEqual([
      {key: 'Armor', value: '  Heavy Light No', chunk: 0},
      {key: 'Name', value: '0-GUN', chunk: 1},
      {key: 'AmmoSpeed', value: '75.0', chunk: 2},
      {key: 'Damage', value: '5.0', chunk: 3},
      {key: 'Name', value: '1-MACHINEGUN', chunk: 4},
      {key: 'AmmoSpeed', value: '150.0', chunk: 5},
      {key: 'Damage', value: '30.0', chunk: 6},
    ])
  })

  test('groupRecords(fields, "Name") splits into weapons, dropping the header', () => {
    const records = groupRecords(parseStatTable(buildTable(WEAPONS)), 'Name')
    expect(records.length).toBe(2)
    expect(records[1]!.map((f) => `${f.key}=${f.value}`)).toEqual([
      'Name=1-MACHINEGUN',
      'AmmoSpeed=150.0',
      'Damage=30.0',
    ])
    // the class index is the record position; chunk index is retained for writes
    expect(records[1]![1]!.chunk).toBe(5)
  })

  test('ignores filler after the newline', () => {
    // different filler byte must not change the parse
    expect(parseStatTable(buildTable(WEAPONS, 0x00))).toEqual(parseStatTable(buildTable(WEAPONS)))
  })
})

describe('setStatValue / setStatField', () => {
  test('rewrites one value and leaves every other chunk byte-identical', () => {
    const table = buildTable(WEAPONS)
    const out = setStatValue(table, 5, '45.00') // retune the machinegun speed
    const reread = parseStatTable(out)
    expect(reread.find((f) => f.chunk === 5)).toEqual({key: 'AmmoSpeed', value: '45.00', chunk: 5})
    // all chunks except #5 are untouched at the byte level
    for (let c = 0; c < WEAPONS.length; c++) {
      if (c === 5) continue
      const a = table.subarray(c * STAT_CHUNK_SIZE, (c + 1) * STAT_CHUNK_SIZE)
      const b = out.subarray(c * STAT_CHUNK_SIZE, (c + 1) * STAT_CHUNK_SIZE)
      expect(b).toEqual(a)
    }
  })

  test('supports a length-changing value; chunk stays 0x7F, trailing filler preserved', () => {
    const table = buildTable(WEAPONS, 0xab)
    const out = setStatValue(table, 3, '5.0 -> 12.5') // longer than "5.0"
    expect(parseStatTable(out).find((f) => f.chunk === 3)!.value).toBe('5.0 -> 12.5')
    expect(out.length).toBe(WEAPONS.length * STAT_CHUNK_SIZE)
    // the chunk's trailing filler is kept as-is (minimal diff), not zeroed
    const plain = deobfuscate(out)
    expect(plain[3 * STAT_CHUNK_SIZE + STAT_CHUNK_SIZE - 1]).toBe(0xab)
  })

  test('a same-length value edit changes only the value bytes (minimal diff)', () => {
    const table = buildTable(WEAPONS)
    const out = setStatValue(table, 5, '045.0') // same length as "150.0"
    let diffs = 0
    for (let i = 0; i < table.length; i++) if (table[i] !== out[i]) diffs++
    expect(diffs).toBe(3) // only "150" -> "045"
  })

  test('setStatField can change the key too', () => {
    const out = setStatField(buildTable(WEAPONS), 2, 'AmmoSpeed', '99.0')
    expect(parseStatTable(out).find((f) => f.chunk === 2)).toEqual({
      key: 'AmmoSpeed',
      value: '99.0',
      chunk: 2,
    })
  })

  test('rejects an out-of-range chunk and an overlong field', () => {
    const table = buildTable(WEAPONS)
    expect(() => setStatValue(table, 99, 'x')).toThrow(RangeError)
    expect(() => setStatField(table, 0, 'Sound', 'x'.repeat(200))).toThrow(RangeError)
  })
})

describe('packStatSlot', () => {
  test('emits a literal 0x00 terminator within the slot (engine-safe)', () => {
    const slot = packStatSlot('Name:0-GUN')
    expect(slot.length).toBe(STAT_CHUNK_SIZE)
    // the engine's unbounded scan must stop inside the slot, not run off the end
    expect(scanToTerminator(slot)).toBeLessThan(STAT_CHUNK_SIZE)
  })

  test('matches the stock slot layout (obfuscated text + newline, then NUL, then zeros)', () => {
    const slot = packStatSlot('Name:0-GUN')
    const nul = scanToTerminator(slot)
    // deobfuscating just the text portion recovers the line with its trailing newline
    const text = new TextDecoder('latin1').decode(deobfuscate(slot.subarray(0, nul)))
    expect(text).toBe('Name:0-GUN\n')
    // the byte after the text is a literal (un-obfuscated) 0x00
    expect(slot[nul]).toBe(0x00)
    // remainder is zero-filled
    for (let i = nul + 1; i < STAT_CHUNK_SIZE; i++) expect(slot[i]).toBe(0x00)
  })

  test('throws a clear error when the record does not fit in a slot', () => {
    // a `key:value` of >= 127 bytes cannot fit alongside the terminator
    expect(() => packStatSlot('K'.repeat(200))).toThrow(RangeError)
    expect(() => packStatSlot('K'.repeat(200))).toThrow(/exceed/i)
  })
})

describe('formatStatTable', () => {
  test('round-trips fields functionally (chunk-sized, engine ignores filler)', () => {
    const fields = parseStatTable(buildTable(WEAPONS))
    const rebuilt = formatStatTable(fields)
    expect(rebuilt.length).toBe(WEAPONS.length * STAT_CHUNK_SIZE)
    expect(parseStatTable(rebuilt)).toEqual(fields)
  })

  test('output length is a multiple of the chunk size', () => {
    const rebuilt = formatStatTable(parseStatTable(buildTable(WEAPONS)))
    expect(rebuilt.length % STAT_CHUNK_SIZE).toBe(0)
  })

  test('every emitted slot has a NUL terminator (regression: no infinite deobfuscation)', () => {
    const fields = parseStatTable(buildTable(WEAPONS))
    const rebuilt = formatStatTable(fields)
    for (let c = 0; c < WEAPONS.length; c++) {
      const slot = rebuilt.subarray(c * STAT_CHUNK_SIZE, (c + 1) * STAT_CHUNK_SIZE)
      expect(scanToTerminator(slot)).toBeLessThan(STAT_CHUNK_SIZE)
    }
  })

  test('throws a clear error for an overlong field', () => {
    expect(() => formatStatTable([{key: 'Sound', value: 'x'.repeat(200)}])).toThrow(RangeError)
  })
})
