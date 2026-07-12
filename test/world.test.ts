import {describe, expect, test} from 'vitest'

import {formatWorld, parseWorld} from '../src/index.ts'

const SAMPLE = [
  'Name:tank_01',
  'Translation: -3162.09,-9.48,3790.53',
  'Dof: 0.0 0.0 -1.0',
  'Up: 0.0 1.0 0.0',
  'Right: 1.0 0.0 0.0',
  'Dele:cwall1_07',
  'Translation: -7475.21,-411.574,310.408',
  'Dof: -1.68587e-007 0.0 1.0',
  'Up: 0.0 1.0 0.0',
  'Right: -1.0 0.0 -1.68587e-007',
].join('\r\n')

describe('parseWorld', () => {
  test('parses Name/Dele entries with position and Dof/Up/Right rotation', () => {
    const entries = parseWorld(SAMPLE)
    expect(entries).toHaveLength(2)

    const [tank, wall] = entries
    expect(tank!.kind).toBe('Name')
    expect(tank!.name).toBe('tank_01')
    expect(tank!.position).toEqual({x: -3162.09, y: -9.48, z: 3790.53})
    // rotation is [Dof, Up, Right] flattened - matching data1.bin's matrix layout
    expect(tank!.rotation).toEqual([0, 0, -1, 0, 1, 0, 1, 0, 0])

    expect(wall!.kind).toBe('Dele')
    expect(wall!.name).toBe('cwall1_07')
    expect(wall!.rotation[0]).toBeCloseTo(-1.68587e-7)
  })

  test('accepts raw bytes and tolerates blank/unknown lines', () => {
    const bytes = new TextEncoder().encode('Name:x\n\nFoo: bar\nTranslation: 1,2,3\n')
    const entries = parseWorld(bytes)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.position).toEqual({x: 1, y: 2, z: 3})
  })

  test('defaults missing fields to origin + identity', () => {
    const entries = parseWorld('Name:lonely')
    expect(entries[0]!.position).toEqual({x: 0, y: 0, z: 0})
    expect(entries[0]!.rotation).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1])
  })
})

describe('formatWorld', () => {
  test('round-trips through parseWorld (values preserved)', () => {
    const reparsed = parseWorld(formatWorld(parseWorld(SAMPLE)))
    expect(reparsed).toEqual(parseWorld(SAMPLE))
  })

  test('defaults kind to Name and emits CRLF blocks', () => {
    const text = formatWorld([
      {name: 'tree_1', position: {x: 1, y: 2, z: 3}, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1]},
    ])
    expect(text).toContain('Name:tree_1\r\n')
    expect(text).toContain('Translation: 1,2,3')
    expect(text).toContain('Dof: 1 0 0')
  })
})
