import {describe, expect, test} from 'vitest'

import {applyAnmFrame, parseAnm} from '../src/index.ts'
import type {Mesh} from '../src/index.ts'

/** Build a .anm: header [nframes, 1, nverts] + frames of nverts vec3 + a per-frame trailer. */
function buildAnm(frames: number[][][], trailerBytes: number, trailers?: number[][]): Uint8Array {
  const nverts = frames[0]!.length
  const stride = nverts * 12 + trailerBytes
  const buf = new Uint8Array(12 + frames.length * stride)
  const dv = new DataView(buf.buffer)
  dv.setUint32(0, frames.length, true)
  dv.setUint32(4, 1, true)
  dv.setUint32(8, nverts, true)
  frames.forEach((frame, f) => {
    let off = 12 + f * stride
    for (const [x, y, z] of frame) {
      dv.setFloat32(off, x!, true)
      dv.setFloat32(off + 4, y!, true)
      dv.setFloat32(off + 8, z!, true)
      off += 12
    }
    trailers?.[f]?.forEach((val, i) =>
      dv.setFloat32(12 + f * stride + nverts * 12 + i * 4, val, true),
    )
  })
  return buf
}

describe('parseAnm', () => {
  test('decodes frames of vertex positions, deriving the stride past a trailer', () => {
    const frames = [
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
      [
        [0, 0, 0],
        [2, 0, 0],
        [0, 2, 0],
      ],
    ]
    const anm = parseAnm(buildAnm(frames, 12)) // 12-byte trailer per frame (< 60: no transform)
    expect(anm.frameCount).toBe(2)
    expect(anm.vertexCount).toBe(3)
    expect(anm.frames[1]![1]).toEqual({x: 2, y: 0, z: 0})
    expect(anm.frames[0]![2]).toEqual({x: 0, y: 1, z: 0})
    expect(anm.transforms[0]).toBeNull() // 12-byte trailer is too small for a transform
  })

  test('decodes the per-frame trailer transform (position + 3×3 rotation + translation)', () => {
    // a 90° yaw about Y as a row-major 3×3, plus a position
    const rot90 = [0, 0, 1, 0, 1, 0, -1, 0, 0]
    const trailer = [5, 6, 7, ...rot90, 0, 0, 0] // pos (5,6,7), rot, trans (0,0,0)
    const anm = parseAnm(buildAnm([[[0, 0, 0]], [[0, 0, 0]]], 60, [trailer, trailer]))
    const t = anm.transforms[0]!
    expect(t.position).toEqual({x: 5, y: 6, z: 7})
    expect(t.rotation).toEqual(rot90)
    expect(Math.round((Math.atan2(t.rotation[2]!, t.rotation[0]!) * 180) / Math.PI)).toBe(90) // yaw
  })

  test('throws on an inconsistent header/stride', () => {
    const bad = new Uint8Array(12 + 10) // 2 frames * 5 bytes is not a clean vec3 stride
    const dv = new DataView(bad.buffer)
    dv.setUint32(0, 2, true)
    dv.setUint32(8, 3, true)
    expect(() => parseAnm(bad)).toThrow(/stride/)
  })
})

describe('applyAnmFrame', () => {
  test('replaces a mesh’s vertices with the frame, keeping faces', () => {
    const mesh: Mesh = {
      vertices: [
        {x: 9, y: 9, z: 9},
        {x: 8, y: 8, z: 8},
      ],
      faces: [
        {vertices: [0, 1], color: {r: 1, g: 2, b: 3}, alpha: 255, flags: 0, texId: null, uv: null},
      ],
    }
    const posed = applyAnmFrame(mesh, [
      {x: 0, y: 0, z: 0},
      {x: 1, y: 1, z: 1},
    ])
    expect(posed.vertices).toEqual([
      {x: 0, y: 0, z: 0},
      {x: 1, y: 1, z: 1},
    ])
    expect(posed.faces).toBe(mesh.faces) // faces shared, not copied
  })

  test('rejects a frame with the wrong vertex count', () => {
    const mesh: Mesh = {vertices: [{x: 0, y: 0, z: 0}], faces: []}
    expect(() =>
      applyAnmFrame(mesh, [
        {x: 0, y: 0, z: 0},
        {x: 1, y: 1, z: 1},
      ]),
    ).toThrow(/verts/)
  })
})
