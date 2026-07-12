import {describe, expect, test} from 'vitest'

import {formatLights, formatMatrix, parseLights, parseMatrix, projectToMap} from '../src/index.ts'

/** Build a little-endian buffer from float32 / uint32 / uint8 instructions. */
function bytes(fields: Array<['f32' | 'u32', number] | ['u8', number]>): Uint8Array {
  const out: number[] = []
  const scratch = new DataView(new ArrayBuffer(4))
  for (const [type, value] of fields) {
    if (type === 'u8') {
      out.push(value & 0xff)
      continue
    }
    if (type === 'f32') scratch.setFloat32(0, value, true)
    else scratch.setUint32(0, value, true)
    for (let i = 0; i < 4; i++) out.push(scratch.getUint8(i))
  }
  return Uint8Array.from(out)
}

describe('parseMatrix', () => {
  // Mirrors the real LEVEL12/MAPMTX.DAT shape (values chosen to be exact in float32).
  const matrixBytes = bytes([
    ['f32', 0.5],
    ['f32', 0],
    ['f32', 198],
    ['f32', 0],
    ['f32', -0.5],
    ['f32', 255],
    ['f32', 0],
    ['f32', 0],
    ['f32', 1],
  ])

  test('reads 9 row-major float32 values', () => {
    expect(parseMatrix(matrixBytes).values).toEqual([0.5, 0, 198, 0, -0.5, 255, 0, 0, 1])
  })

  test('projectToMap applies the affine transform', () => {
    const matrix = parseMatrix(matrixBytes)
    expect(projectToMap(matrix, 100, 40)).toEqual({x: 0.5 * 100 + 198, y: -0.5 * 40 + 255})
  })

  test('throws on a short buffer', () => {
    expect(() => parseMatrix(new Uint8Array(20))).toThrow(/at least 36 bytes/i)
  })

  test('formatMatrix is the byte-exact inverse of parseMatrix', () => {
    expect([...formatMatrix(parseMatrix(matrixBytes))]).toEqual([...matrixBytes])
  })

  test('formatMatrix pads missing values with zero', () => {
    expect([...formatMatrix({values: [1]})]).toEqual([
      ...bytes([['f32', 1]]),
      ...Array.from<number>({length: 32}).fill(0),
    ])
  })
})

describe('parseLights', () => {
  const lightBytes = bytes([
    ['f32', 300], // range
    ['u32', 0], // id
    ['u8', 255], // r
    ['u8', 128], // g
    ['u8', 0], // b
    ['f32', -1476], // x
    ['f32', 635], // y
    ['f32', -1766], // z
  ])

  test('decodes 23-byte records into typed light sources', () => {
    expect(parseLights(lightBytes)).toEqual([
      {
        id: 0,
        range: 300,
        color: {r: 255, g: 128, b: 0},
        position: {x: -1476, y: 635, z: -1766},
      },
    ])
  })

  test('returns an empty array for an empty file', () => {
    expect(parseLights(new Uint8Array(0))).toEqual([])
  })

  test('reads multiple consecutive records', () => {
    const two = new Uint8Array(lightBytes.length * 2)
    two.set(lightBytes, 0)
    two.set(lightBytes, lightBytes.length)
    expect(parseLights(two)).toHaveLength(2)
  })

  test('throws when the length is not a multiple of the record size', () => {
    expect(() => parseLights(new Uint8Array(30))).toThrow(/multiple of 23/i)
  })

  test('respects a non-zero byteOffset (Node Buffer pooling)', () => {
    const padded = new Uint8Array(8 + lightBytes.length)
    padded.set(lightBytes, 8)
    const slice = padded.subarray(8) // shares the buffer with a byteOffset of 8
    expect(parseLights(slice)[0]!.range).toBe(300)
  })

  test('formatLights is the byte-exact inverse of parseLights', () => {
    expect([...formatLights(parseLights(lightBytes))]).toEqual([...lightBytes])
  })

  test('formatLights round-trips multiple records and an empty list', () => {
    const lights = [
      {id: 1, range: 50, color: {r: 10, g: 20, b: 30}, position: {x: 1.5, y: -2.5, z: 3}},
      {id: 7, range: 999, color: {r: 255, g: 0, b: 127}, position: {x: -100, y: 0, z: 64}},
    ]
    expect(parseLights(formatLights(lights))).toEqual(lights)
    expect(formatLights([])).toHaveLength(0)
  })
})
