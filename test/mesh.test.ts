import {describe, expect, test} from 'vitest'

import {
  buildMtl,
  meshToObj,
  objToMesh,
  orientMesh,
  parseDetectMesh,
  parseMesh,
  parseMeshLayers,
  serializeMesh,
} from '../src/index.ts'
import type {Mesh} from '../src/index.ts'

/** Encode a 32-bit value as little-endian bytes. */
const le32 = (v: number): number[] => [
  v & 0xff,
  (v >> 8) & 0xff,
  (v >> 16) & 0xff,
  (v >>> 24) & 0xff,
]

/**
 * Build a one-layer project blob: nv vertices, a skipped edge table, then faces.
 * Mirrors the on-disk format decoded from the loader.
 */
function buildProject(): Uint8Array {
  const bytes: number[] = []
  const u32 = (v: number) =>
    bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff)
  const u16 = (v: number) => bytes.push(v & 0xff, (v >> 8) & 0xff)
  const u8 = (v: number) => bytes.push(v & 0xff)
  const f32 = (v: number) => {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setFloat32(0, v, true)
    bytes.push(...b)
  }

  // 4 vertices (a quad in the XY plane)
  u32(4)
  f32(0)
  f32(0)
  f32(0)
  f32(2)
  f32(0)
  f32(0)
  f32(2)
  f32(2)
  f32(0)
  f32(0)
  f32(2)
  f32(0)

  // layer: edge table (skipped), then faces
  u32(2) // nEdges -> skip 2*5 = 10 bytes
  for (let i = 0; i < 10; i++) u8(0xaa)
  u32(1) // nFaces

  // one textured quad face
  u8(4) // 4 verts
  for (let i = 0; i < 4; i++) u16(0x1111) // edge indices (skipped)
  u16(0)
  u16(1)
  u16(2)
  u16(3) // vertex indices
  u8(10)
  u8(20)
  u8(30) // RGB
  u8(0)
  u8(0)
  u8(0) // alpha + flags + pad
  u16(7) // texId
  // UVs
  f32(0)
  f32(0)
  f32(1)
  f32(0)
  f32(1)
  f32(1)
  f32(0)
  f32(1)

  u32(0) // empty layer -> ends parsing
  return Uint8Array.from(bytes)
}

describe('parseMesh', () => {
  const mesh = parseMesh(buildProject())

  test('reads vertices', () => {
    expect(mesh.vertices).toHaveLength(4)
    expect(mesh.vertices[2]).toEqual({x: 2, y: 2, z: 0})
  })

  test('reads a face with indices, color, texId and UVs (skipping edge data)', () => {
    expect(mesh.faces).toHaveLength(1)
    expect(mesh.faces[0]).toEqual({
      vertices: [0, 1, 2, 3],
      color: {r: 10, g: 20, b: 30},
      alpha: 255,
      flags: 0,
      texId: 7,
      uv: [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
    })
  })

  test('decodes per-face alpha (stored inverted) and the flags byte', () => {
    // a face with stored-alpha byte 12 -> opacity 243, flags 0x24
    const b: number[] = []
    const u32 = (v: number) =>
      b.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff)
    const u16 = (v: number) => b.push(v & 0xff, (v >> 8) & 0xff)
    const u8 = (v: number) => b.push(v & 0xff)
    u32(3)
    for (let i = 0; i < 9; i++) b.push(0, 0, 0, 0)
    u32(0)
    u32(1)
    u8(3)
    u16(0)
    u16(1)
    u16(2) // edges (skipped)
    u16(0)
    u16(1)
    u16(2) // vertex indices
    u8(0)
    u8(0)
    u8(0) // rgb
    u8(12) // stored alpha -> 243
    u8(0x24) // flags
    u8(0) // pad
    u16(0xffff)
    u32(0)
    const face = parseMesh(Uint8Array.from(b)).faces[0]!
    expect(face.alpha).toBe(243)
    expect(face.flags).toBe(0x24)
  })

  test('untextured faces (texId 0xffff) have no UVs', () => {
    const bytes: number[] = []
    const u32 = (v: number) =>
      bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff)
    const u16 = (v: number) => bytes.push(v & 0xff, (v >> 8) & 0xff)
    const u8 = (v: number) => bytes.push(v & 0xff)
    u32(3) // 3 vertices, all zero
    for (let i = 0; i < 9; i++) bytes.push(0, 0, 0, 0)
    u32(0) // no edges
    u32(1) // 1 face
    u8(3) // triangle
    u16(0)
    u16(1)
    u16(2) // edge indices (skipped)
    u16(0)
    u16(1)
    u16(2) // vertex indices
    u8(1)
    u8(2)
    u8(3)
    u8(0)
    u8(0)
    u8(0)
    u16(0xffff) // untextured
    u32(0)
    const m = parseMesh(Uint8Array.from(bytes))
    expect(m.faces[0]!.texId).toBeNull()
    expect(m.faces[0]!.uv).toBeNull()
  })
})

describe('meshToObj', () => {
  test('emits v / vt / f with 1-based indices', () => {
    // up:'raw' to test raw emission mechanics without the default Y-flip
    const obj = meshToObj(parseMesh(buildProject()), {name: 'quad', up: 'raw'})
    expect(obj).toContain('o quad')
    expect(obj).toContain('v 0 0 0')
    expect(obj).toContain('v 2 2 0')
    expect(obj).toContain('vt 1 1')
    // textured quad face references v/vt, 1-based
    expect(obj).toMatch(/f 1\/1 2\/2 3\/3 4\/4/)
  })

  test('emits mtllib + usemtl when a material resolver is given', () => {
    const obj = meshToObj(parseMesh(buildProject()), {
      name: 'quad',
      mtllib: 'quad.mtl',
      material: (face) => `tex${face.texId}`,
    })
    expect(obj).toContain('mtllib quad.mtl')
    expect(obj).toContain('usemtl tex7') // face texId is 7
  })
})

/** A mesh of `n` untextured triangles over one shared 3-vertex triangle. */
function triMesh(n: number): Mesh {
  return {
    vertices: [
      {x: 0, y: 0, z: 0},
      {x: 1, y: 0, z: 0},
      {x: 0, y: 1, z: 0},
    ],
    faces: Array.from({length: n}, () => ({
      vertices: [0, 1, 2],
      color: {r: 0, g: 0, b: 0},
      alpha: 255,
      flags: 0,
      texId: null,
      uv: null,
    })),
  }
}

/** A project with one layer per entry in `faceCounts`, each `n` untextured triangles. */
function lodProject(faceCounts: number[]): Uint8Array {
  const b: number[] = [...le32(3)]
  for (let i = 0; i < 9; i++) b.push(0, 0, 0, 0) // 3 vertices
  for (const n of faceCounts) {
    b.push(...le32(0), ...le32(n)) // nEdges=0, nFaces=n
    for (let f = 0; f < n; f++) {
      // faceVerts=3, edge idx (skipped), vertex idx 0/1/2, 8-byte material (texId 0xffff)
      b.push(3, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff)
    }
  }
  return Uint8Array.from(b)
}

describe('parseMeshLayers (LOD chain)', () => {
  test('returns each layer separately, in stored high→low order', () => {
    expect(parseMeshLayers(lodProject([3, 2, 1])).map((l) => l.faces.length)).toEqual([3, 2, 1])
  })

  test('handles single-layer projects and a layer limit', () => {
    expect(parseMeshLayers(lodProject([5]))).toHaveLength(1)
    expect(parseMeshLayers(lodProject([3, 2, 1]), 1)).toHaveLength(1)
  })
})

/** A self-contained mesh group: nVerts (non-zero) vertices, one layer of `nFaces`
 *  untextured triangles, optionally followed by a `0` face-count terminator. */
function meshGroup(nVerts: number, nFaces: number, terminate: boolean): number[] {
  const one = [0x00, 0x00, 0x80, 0x3f] // 1.0f - non-zero so a misread can't look like a 0 terminator
  const b: number[] = [...le32(nVerts)]
  for (let i = 0; i < nVerts; i++) b.push(...one, ...one, ...one)
  b.push(...le32(0), ...le32(nFaces)) // 0 edges, nFaces
  // untextured triangle: fv=3, 6 edge bytes, 3 vertex indices (0,1,2), 8-byte material (texId 0xffff)
  for (let f = 0; f < nFaces; f++)
    b.push(3, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2, 0, 1, 2, 3, 0, 0, 0, 0xff, 0xff)
  if (terminate) b.push(...le32(0))
  return b
}

describe('parseDetectMesh (collision hull)', () => {
  test('extracts the detect mesh that follows the LOD chain', () => {
    // a 4-vertex LOD mesh directly followed by a separate 3-vertex collision hull
    const blob = Uint8Array.from([...meshGroup(4, 2, false), ...meshGroup(3, 1, true)])
    expect(parseMesh(blob).vertices).toHaveLength(4) // parseMesh still returns the render LOD
    const detect = parseDetectMesh(blob)
    expect(detect).not.toBeNull()
    expect(detect!.vertices).toHaveLength(3) // the appended collision hull, its own vertices
    expect(detect!.faces).toHaveLength(1)
  })

  test('returns null when a project has no trailing detect mesh', () => {
    expect(parseDetectMesh(buildProject())).toBeNull()
  })
})

describe('serializeMesh (project-blob writer)', () => {
  const mesh: Mesh = {
    vertices: [
      {x: 0, y: 0, z: 0},
      {x: 2, y: 0, z: 0},
      {x: 2, y: 2, z: 0},
      {x: 0, y: 2, z: 0},
    ],
    faces: [
      {
        vertices: [0, 1, 2, 3],
        color: {r: 10, g: 20, b: 30},
        alpha: 200,
        flags: 4,
        texId: 7,
        uv: [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      },
    ],
  }

  test('round-trips through parseMesh (geometry, colour, alpha, texId, UVs)', () => {
    const rt = parseMesh(serializeMesh(mesh))
    expect(rt.vertices).toEqual(mesh.vertices)
    expect(rt.faces).toEqual(mesh.faces)
  })

  test('appends a detect hull that parseDetectMesh recovers', () => {
    const detect: Mesh = {
      vertices: [
        {x: 0, y: 0, z: 0},
        {x: 1, y: 0, z: 0},
        {x: 0, y: 1, z: 0},
      ],
      faces: [
        {
          vertices: [0, 1, 2],
          color: {r: 1, g: 2, b: 3},
          alpha: 255,
          flags: 0,
          texId: null,
          uv: null,
        },
      ],
    }
    const blob = serializeMesh(mesh, {detect})
    expect(parseMesh(blob).faces).toHaveLength(1) // render mesh unaffected
    const d = parseDetectMesh(blob)
    expect(d?.vertices).toEqual(detect.vertices)
    expect(d?.faces).toEqual(detect.faces)
  })

  test('always emits three render layers + a detect slot (the engine reads a fixed shape)', () => {
    // The loader (FUN_00480b60) reads vc1 + 3 render layers, then vc2 + a 4th (detect)
    // layer. A single mesh must fill all three render slots or it vanishes at LOD distance.
    const layers = parseMeshLayers(serializeMesh(mesh))
    expect(layers).toHaveLength(3)
    for (const layer of layers) expect(layer.faces).toHaveLength(1)
    expect(parseDetectMesh(serializeMesh(mesh))).toBeNull() // empty detect slot
  })

  test('repeated render layers share one vertex array (no triplicated vertices)', () => {
    const blob = serializeMesh(mesh)
    const vc1 = new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getUint32(0, true)
    expect(vc1).toBe(mesh.vertices.length) // 4, not 12 - the three layers reuse the slice
  })

  test('lods are written as distinct decreasing-detail layers parseMesh can select', () => {
    const blob = serializeMesh(triMesh(3), {lods: [triMesh(2), triMesh(1)]})
    expect(parseMeshLayers(blob).map((l) => l.faces.length)).toEqual([3, 2, 1])
    expect(parseMesh(blob).faces).toHaveLength(3) // high
    expect(parseMesh(blob, {lod: 'medium'}).faces).toHaveLength(2)
    expect(parseMesh(blob, {lod: 'low'}).faces).toHaveLength(1)
  })

  test('rejects more than three render layers', () => {
    expect(() => serializeMesh(mesh, {lods: [mesh, mesh, mesh]})).toThrow(/at most/)
  })

  test('generates an edge table with face-share counts (a shared edge is deduped)', () => {
    const twoQuads: Mesh = {
      vertices: [
        {x: 0, y: 0, z: 0},
        {x: 1, y: 0, z: 0},
        {x: 1, y: 1, z: 0},
        {x: 0, y: 1, z: 0},
        {x: 2, y: 0, z: 0},
        {x: 2, y: 1, z: 0},
      ],
      faces: [
        {
          vertices: [0, 1, 2, 3],
          color: {r: 0, g: 0, b: 0},
          alpha: 255,
          flags: 0,
          texId: null,
          uv: null,
        },
        {
          vertices: [1, 4, 5, 2],
          color: {r: 0, g: 0, b: 0},
          alpha: 255,
          flags: 0,
          texId: null,
          uv: null,
        },
      ],
    }
    const blob = serializeMesh(twoQuads)
    const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
    // 8 face-edges, sharing edge 1-2 once → 7 unique edges
    expect(dv.getUint32(4 + 6 * 12, true)).toBe(7)
  })
})

describe('objToMesh (OBJ importer)', () => {
  test('round-trips with meshToObj (default Y-up is self-inverse)', () => {
    const mesh: Mesh = {
      vertices: [
        {x: 0, y: 1, z: 2},
        {x: 3, y: 4, z: 5},
        {x: 6, y: 7, z: 8},
      ],
      faces: [
        {
          vertices: [0, 1, 2],
          color: {r: 255, g: 255, b: 255},
          alpha: 255,
          flags: 4,
          texId: 5,
          uv: [
            [0, 0],
            [1, 0],
            [0.5, 1],
          ],
        },
      ],
    }
    const back = objToMesh(meshToObj(mesh, {material: (face) => `tex${face.texId}`}))
    expect(back.vertices).toEqual(mesh.vertices)
    expect(back.faces).toEqual(mesh.faces)
  })

  test('untextured faces import without a texId or UVs', () => {
    const m = objToMesh('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n', {up: 'raw'})
    expect(m.faces[0]!.vertices).toEqual([0, 1, 2])
    expect(m.faces[0]!.texId).toBeNull()
    expect(m.faces[0]!.uv).toBeNull()
  })

  test('full pipeline: OBJ text → objToMesh → serializeMesh → parseMesh', () => {
    const rt = parseMesh(
      serializeMesh(objToMesh('v 0 0 0\nv 2 0 0\nv 2 2 0\nv 0 2 0\nf 1 2 3 4\n', {up: 'raw'})),
    )
    expect(rt.vertices).toHaveLength(4)
    expect(rt.faces[0]!.vertices).toEqual([0, 1, 2, 3])
  })
})

describe('parseMesh lod selection', () => {
  const blob = lodProject([3, 2, 1]) // high=3 faces, medium=2, low=1

  test('defaults to the highest-detail layer', () => {
    expect(parseMesh(blob).faces).toHaveLength(3)
  })

  test("'medium'/'low' pick the middle/last layers", () => {
    expect(parseMesh(blob, {lod: 'medium'}).faces).toHaveLength(2)
    expect(parseMesh(blob, {lod: 'low'}).faces).toHaveLength(1)
  })

  test('a numeric index selects that layer and clamps out-of-range', () => {
    expect(parseMesh(blob, {lod: 1}).faces).toHaveLength(2)
    expect(parseMesh(blob, {lod: 99}).faces).toHaveLength(1)
  })
})

describe('orientMesh (up-axis)', () => {
  const mesh: Mesh = {
    vertices: [{x: 1, y: 2, z: 3}],
    faces: [
      {
        vertices: [0, 1, 2],
        color: {r: 0, g: 0, b: 0},
        alpha: 255,
        flags: 0,
        texId: null,
        uv: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
      },
    ],
  }

  test("'raw' leaves the data untouched (game-native -Y-up)", () => {
    expect(orientMesh(mesh, 'raw')).toEqual(mesh)
  })

  test("'y' (default) rotates -Y-up to upright Y-up (180° about X), keeping winding", () => {
    const m = orientMesh(mesh, 'y')
    expect(m.vertices[0]).toEqual({x: 1, y: -2, z: -3})
    // a rotation preserves chirality, so winding (and UVs) stay as stored -
    // a plain Y negation would mirror the world (map flipped, lettering reversed)
    expect(m.faces[0]!.vertices).toEqual([0, 1, 2])
    expect(m.faces[0]!.uv).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
    ])
  })

  test("'z' orients to Z-up and keeps winding (rotation)", () => {
    const m = orientMesh(mesh, 'z')
    expect(m.vertices[0]).toEqual({x: 1, y: 3, z: -2})
    expect(m.faces[0]!.vertices).toEqual([0, 1, 2])
  })

  test('meshToObj flips by default; up:raw leaves it', () => {
    expect(meshToObj(mesh)).toContain('v 1 -2 -3') // default 'y' rotation
    expect(meshToObj(mesh, {up: 'raw'})).toContain('v 1 2 3')
    expect(meshToObj(mesh, {up: 'z'})).toContain('v 1 3 -2')
  })
})

describe('buildMtl', () => {
  test('builds newmtl blocks with optional map_Kd', () => {
    const mtl = buildMtl([{name: 'MULT15', map: 'MULT15.tga'}, {name: 'plain'}])
    expect(mtl).toContain('newmtl MULT15')
    expect(mtl).toContain('map_Kd MULT15.tga')
    expect(mtl).toContain('newmtl plain')
    expect(mtl).not.toMatch(/newmtl plain[\s\S]*map_Kd/)
  })

  test('writes Kd from colour (defaults white) and d from sub-255 alpha', () => {
    const mtl = buildMtl([{name: 'red', color: {r: 255, g: 0, b: 0}, alpha: 128}, {name: 'plain'}])
    expect(mtl).toMatch(/newmtl red\nKd 1 0 0\nd 0\.50/)
    expect(mtl).toContain('newmtl plain\nKd 1 1 1') // default white, no `d`
    expect(mtl).not.toMatch(/newmtl plain[\s\S]*\nd /)
  })
})

describe('objToMesh - .mtl Kd colour parsing', () => {
  test('faces take colour and opacity from each usemtl material', () => {
    const obj = 'usemtl wall\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'
    const mtl = 'newmtl wall\nKd 0.2 0.4 0.6\nd 0.5\n'
    const face = objToMesh(obj, {up: 'raw', mtl}).faces[0]!
    expect(face.color).toEqual({r: 51, g: 102, b: 153}) // round(0.2*255)=51, etc.
    expect(face.alpha).toBe(128) // round(0.5*255)
    expect(face.texId).toBeNull() // 'wall' isn't a texN material
  })

  test('round-trips colour through buildMtl → objToMesh', () => {
    const color = {r: 10, g: 128, b: 250}
    const mtl = buildMtl([{name: 'tex3', color, alpha: 200}])
    const face = objToMesh(
      'usemtl tex3\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nf 1/1 2/2 3/3\n',
      {up: 'raw', mtl},
    ).faces[0]!
    expect(face.color).toEqual(color) // exact 0-255 round-trip via Kd
    expect(face.alpha).toBe(200)
    expect(face.texId).toBe(3) // 'tex3' → texId 3
  })

  test('without mtl, faces stay white (unchanged behaviour)', () => {
    const face = objToMesh('usemtl wall\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n', {up: 'raw'})
      .faces[0]!
    expect(face.color).toEqual({r: 255, g: 255, b: 255})
  })
})
