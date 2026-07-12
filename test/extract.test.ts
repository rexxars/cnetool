import {describe, expect, test} from 'vitest'

import {
  extractEntries,
  extractFile,
  extractTexture,
  getTextureInfo,
  parseArchive,
} from '../src/index.ts'

type FixtureEntry =
  | {name: string; kind: 'tga'; width: number; height: number; depth: 24 | 32}
  | {name: string; kind: 'raw'; bytes: number[]}

const RECORD_LENGTH = 17
const NAME_FIELD_LENGTH = 13
const TGA_PREFIX = [0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00]

function blobFor(entry: FixtureEntry): Uint8Array {
  if (entry.kind === 'raw') return Uint8Array.from(entry.bytes)

  const pixels = entry.width * entry.height * (entry.depth / 8)
  const blob = new Uint8Array(10 + pixels)
  const view = new DataView(blob.buffer)
  view.setUint16(4, entry.width, true)
  view.setUint16(6, entry.height, true)
  view.setUint8(8, entry.depth)
  view.setUint8(9, entry.depth === 32 ? 8 : 0)
  for (let i = 0; i < pixels; i++) blob[10 + i] = (i * 7 + entry.name.length) & 0xff
  return blob
}

/**
 * Build an archive in the on-disk format: a uint32 count, fixed 17-byte records
 * (13-byte NUL-terminated name field + uint32 offset), then the data blobs.
 * The name field is intentionally filled with `0xee` padding to prove the
 * parser ignores the padding bytes.
 */
function buildArchive(entries: FixtureEntry[]): Uint8Array {
  const encoder = new TextEncoder()
  const blobs = entries.map(blobFor)

  const tocLength = entries.length * RECORD_LENGTH
  const dataStart = 4 + tocLength
  const offsets: number[] = []
  let cursor = dataStart
  for (const blob of blobs) {
    offsets.push(cursor)
    cursor += blob.length
  }

  const out = new Uint8Array(cursor).fill(0xee, 4, dataStart)
  const view = new DataView(out.buffer)
  view.setUint32(0, entries.length, true)

  entries.forEach((entry, index) => {
    const base = 4 + index * RECORD_LENGTH
    const name = encoder.encode(entry.name)
    out.set(name.subarray(0, NAME_FIELD_LENGTH), base)
    if (name.length < NAME_FIELD_LENGTH) out[base + name.length] = 0x00 // NUL terminator
    view.setUint32(base + NAME_FIELD_LENGTH, offsets[index]!, true)
    out.set(blobs[index]!, offsets[index]!)
  })

  return out
}

const fixture: FixtureEntry[] = [
  {name: '6MAP36.tga', kind: 'tga', width: 4, height: 4, depth: 24},
  {name: 'Water.tga', kind: 'tga', width: 2, height: 2, depth: 24},
  {name: 'Alpha.tga', kind: 'tga', width: 2, height: 1, depth: 32},
  {name: 'TankPjb', kind: 'raw', bytes: [1, 2, 3, 4, 5]},
]

describe('parseArchive', () => {
  test('parses the declared count and every entry', () => {
    const parsed = parseArchive(buildArchive(fixture))

    expect(parsed.declaredCount).toBe(4)
    expect(parsed.entries.map((entry) => entry.name)).toEqual([
      '6MAP36.tga',
      'Water.tga',
      'Alpha.tga',
      'TankPjb',
    ])
  })

  test('derives blob length from neighbouring offsets', () => {
    const parsed = parseArchive(buildArchive(fixture))
    expect(parsed.entries[0]!.blobLength).toBe(10 + 4 * 4 * 3)
    expect(parsed.entries[3]!.blobLength).toBe(5)
  })

  test('rejects data that is not a recognised archive', () => {
    const tooSmall = new Uint8Array(8)
    new DataView(tooSmall.buffer).setUint32(0, 1000, true)
    expect(() => parseArchive(tooSmall)).toThrow(/not a recognised archive/i)
  })
})

describe('getTextureInfo', () => {
  test('reports geometry for texture entries', () => {
    const parsed = parseArchive(buildArchive(fixture))
    expect(getTextureInfo(buildArchive(fixture), parsed.entries[2]!)).toEqual({
      width: 2,
      height: 1,
      depth: 32,
      descriptor: 8,
    })
  })

  test('returns null for non-texture entries', () => {
    const archive = buildArchive(fixture)
    const parsed = parseArchive(archive)
    expect(getTextureInfo(archive, parsed.entries[3]!)).toBeNull()
  })
})

describe('extractTexture', () => {
  test('rebuilds a valid TGA header reporting the original geometry', () => {
    const archive = buildArchive(fixture)
    const parsed = parseArchive(archive)
    const tga = extractTexture(archive, parsed.entries[0]!)
    const view = new DataView(tga.buffer)

    expect(Array.from(tga.slice(0, 8))).toEqual(TGA_PREFIX)
    expect(view.getUint16(12, true)).toBe(4) // width
    expect(view.getUint16(14, true)).toBe(4) // height
    expect(view.getUint8(16)).toBe(24) // depth
  })

  test('pixel data survives the round-trip', () => {
    const archive = buildArchive(fixture)
    const parsed = parseArchive(archive)
    const pixels = extractTexture(archive, parsed.entries[0]!).slice(18)

    const nameLength = fixture[0]!.name.length
    const expected = Array.from({length: 3}, (_, i) => (i * 7 + nameLength) & 0xff)

    expect(pixels).toHaveLength(4 * 4 * 3)
    expect(Array.from(pixels.slice(0, 3))).toEqual(expected)
  })

  test('throws for entries that are not textures', () => {
    const archive = buildArchive(fixture)
    const parsed = parseArchive(archive)
    expect(() => extractTexture(archive, parsed.entries[3]!)).toThrow(/not a supported texture/i)
  })
})

describe('extractFile', () => {
  test('returns the raw stored blob', () => {
    const archive = buildArchive(fixture)
    const parsed = parseArchive(archive)
    expect(Array.from(extractFile(archive, parsed.entries[3]!))).toEqual([1, 2, 3, 4, 5])
  })
})

describe('extractEntries', () => {
  test('rebuilds textures and passes other entries through as raw blobs', () => {
    const entries = extractEntries(buildArchive(fixture))

    expect(entries.map((entry) => entry.kind)).toEqual(['tga', 'tga', 'tga', 'raw'])
    expect(Array.from(entries[0]!.data.slice(0, 8))).toEqual(TGA_PREFIX)
    expect(Array.from(entries[3]!.data)).toEqual([1, 2, 3, 4, 5])
  })
})
