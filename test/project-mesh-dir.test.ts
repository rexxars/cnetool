import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, test} from 'vitest'

import {serializeMesh} from '../src/index.ts'
import type {Mesh, MeshFace, RgbColor} from '../src/index.ts'
import {buildMeshDir, extractMeshDir} from '../src/project/mesh-dir.ts'

let tmpDirs: string[] = []

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cnetool-mesh-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tmpDirs.map((dir) => rm(dir, {recursive: true, force: true})))
  tmpDirs = []
})

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// A face helper: distinct vertex indices, a texId (or null), flags/color/alpha,
// and UVs auto-generated for textured faces so the OBJ round-trip carries them.
function face(
  vertices: number[],
  texId: number | null,
  flags: number,
  color: RgbColor,
  alpha: number,
): MeshFace {
  const uv = texId === null ? null : vertices.map((_, i): [number, number] => [i * 0.1, i * 0.2])
  return {vertices, color, alpha, flags, texId, uv}
}

const TEXTURES = ['ROAD.TGA', 'METAL.TGA', 'GLASS.TGA']

describe('extractMeshDir / buildMeshDir', () => {
  test('single-LOD project (no medium/low, no detect) round-trips byte-identically', async () => {
    const mesh: Mesh = {
      vertices: [
        {x: 0, y: 0, z: 0},
        {x: 2, y: 0, z: 0},
        {x: 2, y: 2, z: 0},
        {x: 0, y: 2, z: 0},
      ],
      faces: [face([0, 1, 2, 3], 0, 4, {r: 10, g: 20, b: 30}, 200)],
    }
    const blob = serializeMesh(mesh)

    const dir = join(await tmp(), 'proj')
    await extractMeshDir(blob, dir, TEXTURES, 'Road')

    expect(await exists(join(dir, 'high.obj'))).toBe(true)
    expect(await exists(join(dir, 'medium.obj'))).toBe(false)
    expect(await exists(join(dir, 'low.obj'))).toBe(false)
    expect(await exists(join(dir, 'detect.obj'))).toBe(false)
    expect(await exists(join(dir, 'model.mtl'))).toBe(true)

    const project = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'))
    expect(project.name).toBe('Road')
    expect(project.$schema).toContain('project.schema.json')
    expect(project.materials.m0).toEqual({
      texture: 'ROAD.TGA',
      flags: 4,
      color: [10, 20, 30],
      alpha: 200,
    })

    const rebuilt = await buildMeshDir(dir, TEXTURES)
    expect(Buffer.compare(Buffer.from(blob), Buffer.from(rebuilt))).toBe(0)
  })

  test('two-LOD project + detect hull round-trips byte-identically', async () => {
    // High: a pyramid over its own 5 vertices, faces carry two distinct tuples
    // (one repeated → dedups to one material) plus an untextured face.
    const high: Mesh = {
      vertices: [
        {x: 0, y: 0, z: 0},
        {x: 1, y: 0, z: 0},
        {x: 1, y: 1, z: 0},
        {x: 0, y: 1, z: 0},
        {x: 0.5, y: 0.5, z: 1},
      ],
      faces: [
        face([0, 1, 2], 1, 4, {r: 200, g: 10, b: 10}, 255),
        face([0, 2, 3], 1, 4, {r: 200, g: 10, b: 10}, 255), // same tuple as above
        face([1, 2, 4], null, 2, {r: 5, g: 6, b: 7}, 128), // distinct, untextured
      ],
    }
    // Medium: a simpler triangle over its own vertices, reusing the first tuple.
    const medium: Mesh = {
      vertices: [
        {x: 0, y: 0, z: 0},
        {x: 1, y: 0, z: 0},
        {x: 0.5, y: 1, z: 0},
      ],
      faces: [face([0, 1, 2], 1, 4, {r: 200, g: 10, b: 10}, 255)],
    }
    // Detect hull: its own vertices, a new tuple (a third material).
    const detect: Mesh = {
      vertices: [
        {x: 0, y: 0, z: 0},
        {x: 2, y: 0, z: 0},
        {x: 1, y: 2, z: 0},
      ],
      faces: [face([0, 1, 2], 2, 0, {r: 0, g: 0, b: 0}, 255)],
    }
    const blob = serializeMesh(high, {lods: [medium], detect})

    const dir = join(await tmp(), 'proj')
    await extractMeshDir(blob, dir, TEXTURES, 'Ramp')

    expect(await exists(join(dir, 'high.obj'))).toBe(true)
    expect(await exists(join(dir, 'medium.obj'))).toBe(true)
    expect(await exists(join(dir, 'low.obj'))).toBe(false)
    expect(await exists(join(dir, 'detect.obj'))).toBe(true)

    const project = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'))
    // Three distinct tuples across high + detect → m0, m1, m2 (first-appearance order).
    expect(Object.keys(project.materials)).toEqual(['m0', 'm1', 'm2'])
    expect(project.materials.m0.texture).toBe('METAL.TGA') // texId 1
    expect(project.materials.m1.texture).toBeNull() // untextured
    expect(project.materials.m2.texture).toBe('GLASS.TGA') // texId 2, from detect

    const rebuilt = await buildMeshDir(dir, TEXTURES)
    expect(Buffer.compare(Buffer.from(blob), Buffer.from(rebuilt))).toBe(0)
  })

  test('material tuples dedup: same tuple → one material, different tuples → distinct', async () => {
    const mesh: Mesh = {
      vertices: [
        {x: 0, y: 0, z: 0},
        {x: 1, y: 0, z: 0},
        {x: 1, y: 1, z: 0},
        {x: 0, y: 1, z: 0},
        {x: 2, y: 0, z: 0},
        {x: 2, y: 1, z: 0},
      ],
      faces: [
        face([0, 1, 2], 0, 4, {r: 1, g: 2, b: 3}, 255), // tuple A
        face([0, 2, 3], 0, 4, {r: 1, g: 2, b: 3}, 255), // tuple A (same)
        face([1, 4, 5], 0, 4, {r: 9, g: 9, b: 9}, 255), // tuple B (different color)
      ],
    }
    const dir = join(await tmp(), 'proj')
    await extractMeshDir(serializeMesh(mesh), dir, TEXTURES, 'Dedup')

    const project = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'))
    expect(Object.keys(project.materials)).toEqual(['m0', 'm1'])
    expect(project.materials.m0.color).toEqual([1, 2, 3])
    expect(project.materials.m1.color).toEqual([9, 9, 9])
  })

  test('three identical render layers collapse to only high.obj and round-trip', async () => {
    const mesh: Mesh = {
      vertices: [
        {x: 0, y: 0, z: 0},
        {x: 1, y: 0, z: 0},
        {x: 0, y: 1, z: 0},
      ],
      faces: [face([0, 1, 2], 0, 4, {r: 7, g: 8, b: 9}, 255)],
    }
    // Force three explicit render layers, all the same mesh (the padding pattern).
    const blob = serializeMesh(mesh, {lods: [mesh, mesh]})

    const dir = join(await tmp(), 'proj')
    await extractMeshDir(blob, dir, TEXTURES, 'Flat')
    expect(await exists(join(dir, 'high.obj'))).toBe(true)
    expect(await exists(join(dir, 'medium.obj'))).toBe(false)
    expect(await exists(join(dir, 'low.obj'))).toBe(false)

    const rebuilt = await buildMeshDir(dir, TEXTURES)
    expect(Buffer.compare(Buffer.from(blob), Buffer.from(rebuilt))).toBe(0)
  })

  test('throws on a blob with no render geometry', async () => {
    const empty = serializeMesh({vertices: [], faces: []})
    const dir = join(await tmp(), 'proj')
    await expect(extractMeshDir(empty, dir, TEXTURES, 'Empty')).rejects.toThrow(
      /no render geometry/,
    )
  })

  test('buildMeshDir wraps malformed project.json in a clear Error (not a raw SyntaxError)', async () => {
    const dir = join(await tmp(), 'proj')
    await mkdir(dir, {recursive: true})
    await writeFile(join(dir, 'project.json'), '{ this is not json')
    await expect(buildMeshDir(dir, TEXTURES)).rejects.toThrow(/Invalid project\.json/)
  })
})
