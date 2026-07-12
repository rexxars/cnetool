import {describe, expect, test} from 'vitest'

import {encodePng, meshesToGlb, meshesToGltf} from '../src/index.ts'
import type {GltfMeshInput, Mesh} from '../src/index.ts'

/** A 2×2 RGBA PNG with a transparent (alpha 0) texel - stands in for a color-keyed texture. */
function rgbaPng(): Uint8Array {
  const data = Uint8Array.from([
    255,
    0,
    0,
    255,
    0,
    255,
    0,
    255,
    0,
    0,
    255,
    255,
    0,
    0,
    0,
    0, // last texel transparent
  ])
  return encodePng({width: 2, height: 2, channels: 4, data})
}

/** One textured triangle + one untextured (red) triangle. */
function mesh(): Mesh {
  return {
    vertices: [
      {x: 0, y: 0, z: 0},
      {x: 1, y: 0, z: 0},
      {x: 0, y: 1, z: 0},
      {x: 1, y: 1, z: 0},
    ],
    faces: [
      {
        vertices: [0, 1, 2],
        color: {r: 255, g: 255, b: 255},
        alpha: 255,
        flags: 0,
        texId: 0,
        uv: [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
      },
      {
        vertices: [1, 3, 2],
        color: {r: 200, g: 30, b: 30},
        alpha: 255,
        flags: 0,
        texId: null,
        uv: null,
      },
    ],
  }
}

const items: GltfMeshInput[] = [
  {name: 'part', mesh: mesh(), materialFor: (f) => (f.texId === null ? null : 'tex0')},
]
const options = {materials: [{name: 'tex0', texture: rgbaPng(), alphaMode: 'MASK' as const}]}

/** Parse a GLB into {json, binLength}. */
function parseGlb(glb: Uint8Array): {json: Record<string, any>; binLength: number} {
  const dv = new DataView(glb.buffer, glb.byteOffset)
  expect(dv.getUint32(0, true)).toBe(0x46546c67) // 'glTF'
  expect(dv.getUint32(4, true)).toBe(2) // version
  expect(dv.getUint32(8, true)).toBe(glb.length) // total length
  const jsonLen = dv.getUint32(12, true)
  expect(dv.getUint32(16, true)).toBe(0x4e4f534a) // 'JSON'
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)))
  const binStart = 20 + jsonLen
  expect(dv.getUint32(binStart + 4, true)).toBe(0x004e4942) // 'BIN\0'
  return {json, binLength: dv.getUint32(binStart, true)}
}

describe('meshesToGlb', () => {
  test('produces a valid GLB with embedded geometry and texture', () => {
    const {json, binLength} = parseGlb(meshesToGlb(items, options))
    expect(json.asset.version).toBe('2.0')
    expect(json.meshes).toHaveLength(1)
    // the textured triangle + the untextured (colour) triangle => two primitives, two materials
    expect(json.meshes[0].primitives).toHaveLength(2)
    expect(json.materials).toHaveLength(2)
    // every bufferView (geometry + the embedded image) fits inside buffer 0
    expect(json.buffers[0].byteLength).toBeLessThanOrEqual(binLength)
    for (const bv of json.bufferViews) {
      expect(bv.byteOffset + bv.byteLength).toBeLessThanOrEqual(json.buffers[0].byteLength)
    }
  })

  test('textured material is MASK (cutoff) and references an embedded PNG; untextured is a colour factor', () => {
    const {json} = parseGlb(meshesToGlb(items, options))
    const tex = json.materials.find((m: any) => m.pbrMetallicRoughness.baseColorTexture)
    expect(tex.alphaMode).toBe('MASK')
    expect(tex.alphaCutoff).toBe(0.5)
    const img = json.images[tex.pbrMetallicRoughness.baseColorTexture.index]
    expect(img.mimeType).toBe('image/png')
    expect(img.bufferView).toBeTypeOf('number') // embedded, not a URI

    const col = json.materials.find((m: any) => m.pbrMetallicRoughness.baseColorFactor)
    expect(col.pbrMetallicRoughness.baseColorFactor).toEqual([200 / 255, 30 / 255, 30 / 255, 1])
  })

  test('a vertex-coloured (untextured) mesh needs no materials option', () => {
    const glb = meshesToGlb([{name: 'p', mesh: mesh()}])
    const {json} = parseGlb(glb)
    // both faces fall back to per-face colour materials (no textures/images)
    expect(json.images).toBeUndefined()
    expect(json.materials.every((m: any) => m.pbrMetallicRoughness.baseColorFactor)).toBe(true)
  })
})

describe('meshesToGltf', () => {
  test('references an external .bin and image files', () => {
    const {json, bin, images} = meshesToGltf(items, {...options, bufferName: 'part.bin'})
    const doc = JSON.parse(new TextDecoder().decode(json))
    expect(doc.buffers[0].uri).toBe('part.bin')
    expect(doc.buffers[0].byteLength).toBe(bin.length)
    expect(images).toHaveLength(1)
    expect(images[0]!.name).toBe('tex0.png')
    // the image is referenced by URI (external), not a bufferView
    expect(doc.images[0].uri).toBe('tex0.png')
    expect(doc.images[0].bufferView).toBeUndefined()
  })
})
