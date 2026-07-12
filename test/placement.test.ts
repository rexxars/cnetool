import {describe, expect, test} from 'vitest'

import {meshesToObj, parsePlacements, serializePlacements, transformMesh} from '../src/index.ts'
import type {Mesh} from '../src/index.ts'

const MARKER = 0x004c3964

/** Build a data1.bin-style record: 28-byte name field, marker, position, 3×3 rotation. */
function record(
  name: string,
  pos: [number, number, number],
  rot: number[],
  marker = MARKER,
): Uint8Array {
  const buf = new Uint8Array(80)
  const view = new DataView(buf.buffer)
  buf.set(new TextEncoder().encode(name)) // NUL-padded by the zero-filled buffer
  view.setUint32(28, marker, true)
  pos.forEach((v, i) => view.setFloat32(32 + i * 4, v, true))
  rot.forEach((v, i) => view.setFloat32(44 + i * 4, v, true))
  return buf
}

describe('parsePlacements', () => {
  test('reads name, position and rotation from 80-byte records', () => {
    const ident = [1, 0, 0, 0, 1, 0, 0, 0, 1]
    const a = record('aagun3_03', [100, -5, 200], ident)
    const b = record('Tree1_48', [10, 20, 30], ident)
    const data = new Uint8Array(160)
    data.set(a, 0)
    data.set(b, 80)

    const placements = parsePlacements(data)
    expect(placements).toHaveLength(2)
    expect(placements[0]).toEqual({
      name: 'aagun3_03',
      position: {x: 100, y: -5, z: 200},
      rotation: ident,
    })
    expect(placements[1]!.name).toBe('Tree1_48')
  })

  test('skips all-zero / garbage slots', () => {
    const data = new Uint8Array(160) // second slot is all zeros (empty name)
    data.set(record('x_1', [0, 0, 0], [1, 0, 0, 0, 1, 0, 0, 0, 1]), 0)
    expect(parsePlacements(data)).toHaveLength(1)
  })

  test('reads records whose markers differ (1.42 sebguard appends)', () => {
    // The unofficial 1.42 patch appended sebguard records to LEVEL130/131's
    // data1.bin with a different (stale-pointer) marker than the rest of the
    // file; the engine ignores the marker field, so cetool must too.
    const ident = [1, 0, 0, 0, 1, 0, 0, 0, 1]
    const data = new Uint8Array(160)
    data.set(record('bridge_01', [1, 2, 3], ident, 0x006cfc6f), 0)
    data.set(record('sebguard_01', [0, 500, 0], ident, 0x006cfc60), 80)

    const placements = parsePlacements(data)
    expect(placements.map((p) => p.name)).toEqual(['bridge_01', 'sebguard_01'])
  })
})

describe('serializePlacements', () => {
  test('round-trips through parsePlacements (with the default marker 0)', () => {
    const placements = [
      {
        name: 'aagun3_03',
        position: {x: 100, y: -5, z: 200},
        rotation: [0, 0, 1, 0, 1, 0, -1, 0, 0],
      },
      {
        name: 'Tree1_48',
        position: {x: 10.5, y: 20.25, z: -30.5},
        rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      },
    ]
    const round = parsePlacements(serializePlacements(placements))
    expect(round).toEqual(placements)
  })

  test('writes 80-byte records and honours a custom marker', () => {
    const bytes = serializePlacements(
      [{name: 'x_1', position: {x: 0, y: 0, z: 0}, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1]}],
      {marker: MARKER},
    )
    expect(bytes).toHaveLength(80)
    expect(new DataView(bytes.buffer).getUint32(28, true)).toBe(MARKER)
  })

  test('fills a short rotation from the identity matrix', () => {
    const round = parsePlacements(
      serializePlacements([{name: 'a', position: {x: 1, y: 2, z: 3}, rotation: []}]),
    )
    expect(round[0]!.rotation).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1])
  })
})

describe('transformMesh', () => {
  const mesh: Mesh = {
    vertices: [{x: 1, y: 0, z: 0}],
    faces: [],
  }

  test('translates with the identity rotation', () => {
    const out = transformMesh(mesh, {
      position: {x: 10, y: 20, z: 30},
      rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    })
    expect(out.vertices[0]).toEqual({x: 11, y: 20, z: 30})
  })

  test('applies the rotation by columns (engine v·M convention)', () => {
    // A 90° yaw. Applied as v·M, (1,0,0) maps to (0,0,1) - using the matrix's
    // first column (a,d,g). (Applying rows instead would give z = -1, the bug
    // that left 90°/270° placements flipped.)
    const rot = [0, 0, 1, 0, 1, 0, -1, 0, 0]
    const out = transformMesh(mesh, {position: {x: 0, y: 0, z: 0}, rotation: rot})
    expect(out.vertices[0]!.x).toBeCloseTo(0)
    expect(out.vertices[0]!.z).toBeCloseTo(1)
  })

  test('leaves symmetric rotations (eg 180° yaw) the same either way', () => {
    // nHangar_06's matrix - transpose-invariant, so it was always correct.
    const rot = [-1, 0, 0, 0, 1, 0, 0, 0, -1]
    const out = transformMesh(mesh, {position: {x: 0, y: 0, z: 0}, rotation: rot})
    expect(out.vertices[0]!.x).toBeCloseTo(-1)
    expect(out.vertices[0]!.z).toBeCloseTo(0)
  })
})

describe('meshesToObj', () => {
  test('combines meshes with o groups and global vertex indices', () => {
    const m1: Mesh = {vertices: [{x: 0, y: 0, z: 0}], faces: []}
    const m2: Mesh = {
      vertices: [{x: 1, y: 1, z: 1}],
      faces: [
        {vertices: [0], color: {r: 0, g: 0, b: 0}, alpha: 255, flags: 0, texId: null, uv: null},
      ],
    }
    const obj = meshesToObj([
      {name: 'a', mesh: m1},
      {name: 'b', mesh: m2},
    ])
    expect(obj).toContain('o a')
    expect(obj).toContain('o b')
    // b's single vertex is global index 2 -> face references it
    expect(obj).toContain('f 2')
  })
})
