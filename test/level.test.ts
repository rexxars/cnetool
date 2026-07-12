import {describe, expect, test} from 'vitest'

import {
  assembleLevel,
  controllableGeometry,
  createTextureResolver,
  readLandscape,
} from '../src/index.ts'

const MARKER = 0x004c3964

// --- builders mirroring the on-disk formats ---

function le32(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]
}

/** A minimal archive: uint32 count, 17-byte name+offset records, then blobs. */
function archive(items: Array<{name: string; blob: number[]}>): Uint8Array {
  const bytes: number[] = [...le32(items.length)]
  const tocLen = items.length * 17
  let cursor = 4 + tocLen
  const offsets = items.map((it) => {
    const o = cursor
    cursor += it.blob.length
    return o
  })
  items.forEach((it, i) => {
    const name = [...new TextEncoder().encode(it.name)]
    for (let k = 0; k < 13; k++) bytes.push(name[k] ?? 0)
    bytes.push(...le32(offsets[i]!))
  })
  for (const it of items) bytes.push(...it.blob)
  return Uint8Array.from(bytes)
}

/** A single-quad textured project blob. */
function quadBlob(texId: number): number[] {
  const b: number[] = [...le32(4)]
  for (let i = 0; i < 12; i++) b.push(0, 0, 0, 0) // 4 vertices (zeroed)
  b.push(...le32(0)) // no edges
  b.push(...le32(1)) // 1 face
  b.push(4) // quad
  for (let i = 0; i < 4; i++) b.push(0, 0) // edge indices (skipped)
  b.push(0, 0, 1, 0, 2, 0, 3, 0) // vertex indices
  b.push(0, 0, 0, 0, 0, 0, texId & 0xff, (texId >> 8) & 0xff) // material + texId
  for (let i = 0; i < 8; i++) b.push(0, 0, 0, 0) // UVs (4 × 2 float)
  b.push(...le32(0)) // end
  return b
}

/** A script opcode carrying a length-prefixed, NUL-terminated string argument. */
function strOp(opcode: number, s: string): number[] {
  const bytes = [...new TextEncoder().encode(s), 0]
  return [opcode, bytes.length & 0xff, (bytes.length >> 8) & 0xff, ...bytes]
}

/** A data1.bin placement record. */
function placement(name: string, pos: [number, number, number]): number[] {
  const b: number[] = Array.from({length: 80}, () => 0)
  const name8 = [...new TextEncoder().encode(name)]
  name8.forEach((c, i) => (b[i] = c))
  le32(MARKER).forEach((v, i) => (b[28 + i] = v))
  const fv = new DataView(new ArrayBuffer(12))
  pos.forEach((p, i) => fv.setFloat32(i * 4, p, true))
  for (let i = 0; i < 12; i++) b[32 + i] = fv.getUint8(i)
  return b
}

describe('assembleLevel', () => {
  const objects = archive([
    {name: 'land1', blob: quadBlob(0)},
    {name: 'tree', blob: quadBlob(0)},
  ])

  test('includes the terrain and resolves placements (stripping _NN)', () => {
    const data1 = Uint8Array.from([
      ...placement('tree_01', [10, 0, 20]),
      ...placement('tree_02', [30, 0, 40]),
    ])
    const scene = assembleLevel(objects, {placements: data1, terrain: 'land1'})
    expect(scene.items.map((i) => i.name)).toEqual(['terrain_land1', 'tree_01', 'tree_02'])
    expect(scene.missing).toEqual([])
  })

  test('reports placements whose project has no mesh', () => {
    const data1 = Uint8Array.from(placement('ghost_01', [0, 0, 0]))
    const scene = assembleLevel(objects, {placements: data1})
    expect(scene.items).toHaveLength(0)
    expect(scene.missing).toEqual(['ghost'])
  })

  describe('controllable option', () => {
    // An empty stub (vehicle logical name) plus body meshes. The built-in map
    // resolves `car` -> `rcbody` (confirmed from the ce.exe resolver).
    const withVehicle = archive([
      {name: 'land1', blob: quadBlob(0)},
      {name: 'car', blob: [...le32(0)]}, // empty stub: no geometry
      {name: 'rcbody', blob: quadBlob(0)}, // the real body mesh
      {name: 'altbody', blob: quadBlob(0)}, // for the custom-map override test
    ])
    const data1 = Uint8Array.from(placement('car_03', [5, 0, 5]))

    test('leaves controllable stubs unrendered by default', () => {
      const scene = assembleLevel(withVehicle, {placements: data1})
      expect(scene.items).toHaveLength(0)
      expect(scene.missing).toEqual(['car'])
    })

    test('substitutes body geometry when enabled (built-in map)', () => {
      const scene = assembleLevel(withVehicle, {placements: data1, controllable: true})
      // built-in `car` is the armored car: its chassis renders from this archive; the
      // turret/wheel parts are absent here, so they're reported missing
      expect(scene.items.map((i) => i.name)).toEqual(['car_03__rcbody'])
      expect(scene.missing).toContain('Car2Tur')
    })

    test('accepts a custom map that overrides the built-in one', () => {
      const scene = assembleLevel(withVehicle, {
        placements: data1,
        controllable: {car: ['altbody']},
      })
      expect(scene.items.map((i) => i.name)).toEqual(['car_03__altbody'])
    })

    test('the built-in map matches the ce.exe type->model resolver', () => {
      expect(controllableGeometry.car![0]).toBe('rcbody') // armored car: chassis + turret/wheels
      // AA gun: rigid base + offset-placed shield/box and twin cannons
      const aagun = controllableGeometry.aagun3!
      expect(aagun[0]).toBe('AALegs')
      expect(aagun).toContainEqual({
        project: 'AACanon',
        at: [
          {x: -2, y: -26, z: 15},
          {x: 2, y: -26, z: 15},
        ],
      })
      // tank: rigid hull + offset-placed tracks and turret
      const tank = controllableGeometry.tank!
      expect(tank[0]).toBe('STBody')
      expect(tank).toContainEqual({project: 'STBandL', at: [{x: -20, y: 6.5, z: 0}]})
      expect(tank).toContainEqual({project: 'STBandR', at: [{x: 20, y: 6.5, z: 0}]})
      expect(tank).toContainEqual({project: 'STTower', at: [{x: 0, y: -16, z: 7}]})
    })

    test('instances a part at each body-local offset', () => {
      const withParts = archive([
        {name: 'car', blob: [...le32(0)]},
        {name: 'chassis', blob: quadBlob(0)},
        {name: 'wheel', blob: quadBlob(0)},
      ])
      const carPlacement = Uint8Array.from(placement('car_01', [0, 0, 0]))
      const scene = assembleLevel(withParts, {
        placements: carPlacement,
        controllable: {
          car: [
            'chassis',
            {
              project: 'wheel',
              at: [
                {x: -10, y: 0, z: 5},
                {x: 10, y: 0, z: 5},
              ],
            },
          ],
        },
      })
      expect(scene.items.map((i) => i.name)).toEqual([
        'car_01__chassis',
        'car_01__wheel#0',
        'car_01__wheel#1',
      ])
    })

    test('a single-offset instanced part gets no #index suffix', () => {
      const withPart = archive([
        {name: 'tank', blob: [...le32(0)]},
        {name: 'body', blob: quadBlob(0)},
        {name: 'track', blob: quadBlob(0)},
      ])
      const tankPlacement = Uint8Array.from(placement('tank_01', [0, 0, 0]))
      const scene = assembleLevel(withPart, {
        placements: tankPlacement,
        controllable: {tank: ['body', {project: 'track', at: [{x: -20, y: 0, z: 0}]}]},
      })
      expect(scene.items.map((i) => i.name)).toEqual(['tank_01__body', 'tank_01__track'])
    })
  })

  describe('extraObjects (multi-archive resolution)', () => {
    // Primary has the terrain only; the body geometry lives in a second archive.
    const primary = archive([{name: 'land1', blob: quadBlob(0)}])
    const secondary = archive([{name: 'HeliBody', blob: quadBlob(7)}])
    const data1 = Uint8Array.from(placement('tree_01', [0, 0, 0]))

    test('resolves a placement whose geometry is only in an extra archive', () => {
      const direct = Uint8Array.from(placement('HeliBody_02', [1, 2, 3]))
      const scene = assembleLevel(primary, {placements: direct, extraObjects: [secondary]})
      expect(scene.items).toHaveLength(1)
      expect(scene.items[0]!.name).toBe('HeliBody_02')
      expect(scene.items[0]!.source).toBe(1) // came from the extra archive
    })

    test('substitutes a controllable body sourced from an extra archive', () => {
      const heli = Uint8Array.from(placement('helicopter_01', [0, 0, 0]))
      const scene = assembleLevel(primary, {
        placements: heli,
        controllable: {helicopter: ['HeliBody']},
        extraObjects: [secondary],
      })
      expect(scene.items.map((i) => i.name)).toEqual(['helicopter_01__HeliBody'])
      expect(scene.items[0]!.source).toBe(1)
    })

    test('tags primary-archive items with source 0', () => {
      const scene = assembleLevel(primary, {placements: data1, terrain: 'land1'})
      expect(scene.items.every((i) => i.source === 0)).toBe(true)
    })
  })
})

describe('readLandscape', () => {
  test('extracts the REFSetLandscape string arguments from script bytecode', () => {
    const script = Uint8Array.from([
      ...strOp(0x08, 'dm1'), // push
      ...strOp(0x08, 'horizon1'), // push
      ...strOp(0x10, 'REFSetLandscape'), // call
    ])
    expect(readLandscape(script)).toEqual({landscape: 'dm1', horizon: 'horizon1'})
  })

  test('returns null when there is no REFSetLandscape call', () => {
    expect(readLandscape(new TextEncoder().encode('nothing here'))).toBeNull()
  })
})

describe('createTextureResolver', () => {
  test('maps a texId to a material + textures.dat entry', () => {
    // objects.dat texture table: project TOC (0 projects) + 1 texture name.
    const objects = Uint8Array.from([...le32(0), ...le32(1), ...nameField('WATER.TGA', 13)])
    const textures = archive([{name: 'WATER.tga', blob: [1, 2, 3]}])
    const resolve = createTextureResolver(objects, textures)
    const ref = resolve(0)
    expect(ref?.material).toBe('WATER')
    expect(ref?.entry.name).toBe('WATER.tga')
    expect(ref?.textures).toBe(textures)
    expect(resolve(99)).toBeNull()
  })

  test('searches several texture archives and reports the matching one', () => {
    // texId 0 -> WATER (base archive), texId 1 -> HELICOPT (patch archive only).
    const objects = Uint8Array.from([
      ...le32(0),
      ...le32(2),
      ...nameField('WATER.TGA', 13),
      ...nameField('HELICOPT.TGA', 13),
    ])
    const base = archive([{name: 'WATER.tga', blob: [1]}])
    const patch = archive([{name: 'HELICOPT.tga', blob: [2]}])
    const resolve = createTextureResolver(objects, [base, patch])
    expect(resolve(0)?.textures).toBe(base)
    expect(resolve(1)?.material).toBe('HELICOPT')
    expect(resolve(1)?.textures).toBe(patch) // only in the patch archive
  })
})

function nameField(name: string, length: number): number[] {
  const bytes = [...new TextEncoder().encode(name)]
  return Array.from({length}, (_, i) => bytes[i] ?? 0)
}
