import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, test} from 'vitest'

import {buildArchive, serializeMesh} from '../src/index.ts'
import type {Mesh} from '../src/index.ts'
import {buildObjectsArchive, extractObjectsArchive} from '../src/project/objects-dir.ts'

let tmpDirs: string[] = []

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cnetool-obj-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tmpDirs.map((dir) => rm(dir, {recursive: true, force: true})))
  tmpDirs = []
})

function quad(): Mesh {
  return {
    vertices: [
      {x: 0, y: 0, z: 0},
      {x: 1, y: 0, z: 0},
      {x: 1, y: 1, z: 0},
    ],
    faces: [
      {
        vertices: [0, 1, 2],
        color: {r: 1, g: 2, b: 3},
        alpha: 255,
        flags: 4,
        texId: 0,
        uv: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
      },
    ],
  }
}

describe('extractObjectsArchive validation', () => {
  test('throws on a duplicate texture name in the table', async () => {
    const data = buildArchive([{name: 'Tri', data: serializeMesh(quad())}], {
      textures: ['DUP.TGA', 'DUP.TGA'],
    })
    await expect(extractObjectsArchive(data, join(await tmp(), 'objects.dat'))).rejects.toThrow(
      /duplicate names.*DUP\.TGA/,
    )
  })
})

async function seedObjectDir(dir: string, entriesJson: unknown): Promise<void> {
  await mkdir(dir, {recursive: true})
  await writeFile(join(dir, 'textures.json'), JSON.stringify({textures: ['ROAD.TGA']}))
  await writeFile(join(dir, 'entries.json'), JSON.stringify(entriesJson))
}

describe('buildObjectsArchive validation', () => {
  test('rejects a path-traversal "dir" in entries.json', async () => {
    const dir = join(await tmp(), 'objects.dat')
    await seedObjectDir(dir, {entries: [{name: 'Evil', kind: 'mesh', dir: '../escape'}]})
    await expect(buildObjectsArchive(dir)).rejects.toThrow(/within the archive dir/)
  })

  test('rejects a path-traversal "file" in entries.json', async () => {
    const dir = join(await tmp(), 'objects.dat')
    await seedObjectDir(dir, {entries: [{name: 'Evil', kind: 'raw', file: '/etc/passwd'}]})
    await expect(buildObjectsArchive(dir)).rejects.toThrow(/within the archive dir/)
  })
})
