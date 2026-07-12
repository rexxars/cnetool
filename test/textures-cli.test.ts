import {describe, expect, test} from 'vitest'

import {buildTextureArchive, encodeTga, parseArchive} from '../src/index.ts'
import type {Mesh, MeshFace} from '../src/index.ts'
import {resolveGltfGroup} from '../src/cli/textures.ts'

// 2×2 24-bit texture: one black texel (the key), three gray.
const KEYED_TGA = encodeTga({
  width: 2,
  height: 2,
  channels: 3,
  data: Uint8Array.from([0, 0, 0, 128, 128, 128, 128, 128, 128, 128, 128, 128]),
})
const RGBA_TGA = encodeTga({
  width: 2,
  height: 2,
  channels: 4,
  data: Uint8Array.from([64, 64, 64, 255, 64, 64, 64, 0, 64, 64, 64, 128, 64, 64, 64, 255]),
})

function face(flags: number): MeshFace {
  return {vertices: [0, 1, 2], color: {r: 0, g: 0, b: 0}, alpha: 255, flags, texId: 0, uv: null}
}
function meshWith(faces: MeshFace[]): Mesh {
  return {
    vertices: [
      {x: 0, y: 0, z: 0},
      {x: 1, y: 0, z: 0},
      {x: 0, y: 1, z: 0},
    ],
    faces,
  }
}

describe('resolveGltfGroup', () => {
  test('splits a 24-bit texture into keyed (MASK) and plain (OPAQUE) materials by face flag 0x02', () => {
    const archive = buildTextureArchive([{name: 'T.tga', data: KEYED_TGA}])
    const entry = parseArchive(archive).entries[0]!
    const mesh = meshWith([face(0x02), face(0)]) // one keyed wheel-like face, one plain
    const group = resolveGltfGroup(() => ({material: 'T', entry, textures: archive}), [mesh])

    const keyedName = group.materialFor(mesh.faces[0]!)
    const plainName = group.materialFor(mesh.faces[1]!)
    expect(keyedName).toBe('T_key')
    expect(plainName).toBe('T')
    const byName = new Map(group.materials.map((m) => [m.name, m]))
    expect(byName.get('T_key')?.alphaMode).toBe('MASK')
    expect(byName.get('T')?.alphaMode).toBe('OPAQUE')
  })

  test('a 32-bit texture keeps its native alpha (MASK) regardless of face flag', () => {
    const archive = buildTextureArchive([{name: 'A.tga', data: RGBA_TGA}])
    const entry = parseArchive(archive).entries[0]!
    const group = resolveGltfGroup(
      () => ({material: 'A', entry, textures: archive}),
      [meshWith([face(0)])],
    )
    expect(group.materials[0]?.alphaMode).toBe('MASK')
  })
})
