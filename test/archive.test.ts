import {describe, expect, test} from 'vitest'

import {
  buildArchive,
  buildTextureArchive,
  encodeTga,
  extractEntries,
  parseArchive,
  parseObjectTextures,
} from '../src/index.ts'

const entry = (name: string, bytes: number[]): {name: string; data: Uint8Array} => ({
  name,
  data: Uint8Array.from(bytes),
})

/** A tiny solid-color TGA, for texture-archive tests. */
const tga = (
  name: string,
  w: number,
  h: number,
  rgb: [number, number, number],
): {name: string; data: Uint8Array} => {
  const data = new Uint8Array(w * h * 3)
  for (let i = 0; i < w * h; i++) [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]] = rgb
  return {name, data: encodeTga({width: w, height: h, channels: 3, data})}
}

describe('buildArchive', () => {
  test('writes a parseable archive that round-trips through extractEntries', () => {
    const entries = [entry('alpha', [1, 2, 3, 4]), entry('bb', [9]), entry('gamma12', [7, 7, 7])]
    const blob = buildArchive(entries)
    const parsed = parseArchive(blob)
    expect(parsed.declaredCount).toBe(3)
    expect(parsed.entries.map((e) => e.name)).toEqual(['alpha', 'bb', 'gamma12'])
    expect(parsed.entries[0]!.dataOffset).toBe(4 + 3 * 17) // blobs follow the TOC, contiguously
    expect(extractEntries(blob).map((e) => [e.name, [...e.data]])).toEqual(
      entries.map((e) => [e.name, [...e.data]]),
    )
  })

  test('its own output round-trips byte-identically', () => {
    const entries = [entry('a', [1, 2]), entry('b', [3, 4, 5])]
    const once = buildArchive(entries)
    const twice = buildArchive(extractEntries(once).map((e) => ({name: e.name, data: e.data})))
    expect([...twice]).toEqual([...once])
  })

  test('supports add / replace / remove via extractEntries', () => {
    const base = buildArchive([entry('keep', [1]), entry('drop', [2]), entry('edit', [3])])
    const list = extractEntries(base).map((e) => ({name: e.name, data: e.data}))
    const edited = list.filter((e) => e.name !== 'drop') // remove
    edited.find((e) => e.name === 'edit')!.data = Uint8Array.from([9, 9]) // replace
    edited.push(entry('new', [5, 5, 5])) // add
    const out = extractEntries(buildArchive(edited))
    expect(out.map((e) => e.name)).toEqual(['keep', 'edit', 'new'])
    expect([...out.find((e) => e.name === 'edit')!.data]).toEqual([9, 9])
  })

  test('rejects names longer than the 13-byte field', () => {
    expect(() => buildArchive([entry('this_name_too_long', [1])])).toThrow(/max is 13/)
  })

  test('writes the objects.dat texture-name list (count + 13-byte names) before the blobs', () => {
    const entries = [entry('land1', [10, 20, 30]), entry('box', [40])]
    const textures = ['GRASS.TGA', 'ROCK1.TGA', 'SAND.TGA']
    const blob = buildArchive(entries, {textures})
    // blobs now follow the TOC *and* the texture block (u32 count + 3 × 13-byte names)
    const texBlock = 4 + textures.length * 13
    expect(parseArchive(blob).entries[0]!.dataOffset).toBe(4 + 2 * 17 + texBlock)
    // entry names + blobs still round-trip, and the texture list reads back exactly
    expect(extractEntries(blob).map((e) => [e.name, [...e.data]])).toEqual(
      entries.map((e) => [e.name, [...e.data]]),
    )
    expect(parseObjectTextures(blob)).toEqual(textures)
  })

  test('rejects a texture name that overflows the 13-byte record', () => {
    expect(() => buildArchive([entry('a', [1])], {textures: ['WAY_TOO_LONG.TGA']})).toThrow(
      /texture name/,
    )
  })
})

describe('buildTextureArchive', () => {
  test('uses the fixed 2048-slot TOC (blobs at 34820) and strips the 8-byte TGA prefix', () => {
    const out = buildTextureArchive([tga('grass.tga', 16, 16, [10, 200, 30])])
    const parsed = parseArchive(out)
    expect(parsed.declaredCount).toBe(1)
    expect(parsed.entries[0]!.dataOffset).toBe(4 + 2048 * 17) // 34820, fixed regardless of count
    // stored blob is the TGA minus its constant 8-byte header (10-byte internal header + pixels)
    expect(parsed.entries[0]!.blobLength).toBe(16 * 16 * 3 + 10)
  })

  test('round-trips through extractEntries (texture pixels preserved)', () => {
    const textures = [tga('a.tga', 8, 8, [1, 2, 3]), tga('bb.tga', 16, 16, [9, 9, 9])]
    const out = buildTextureArchive(textures)
    const back = extractEntries(out)
    expect(back.map((e) => e.name)).toEqual(['a.tga', 'bb.tga'])
    // extractEntries rebuilds a standard TGA - identical to what we put in
    expect([...back[0]!.data]).toEqual([...textures[0]!.data])
    expect([...back[1]!.data]).toEqual([...textures[1]!.data])
  })

  test('rejects more than 2048 entries and non-TGA blobs', () => {
    const many = Array.from({length: 2049}, (_, i) => tga(`t${i}.tga`, 2, 2, [0, 0, 0]))
    expect(() => buildTextureArchive(many)).toThrow(/at most 2048/)
    expect(() => buildTextureArchive([entry('x.tga', [1, 2, 3])])).toThrow(/not a TGA/)
  })
})
