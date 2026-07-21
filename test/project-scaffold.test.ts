import {mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, test} from 'vitest'

import {copySchemas, readManifest, scaffoldProject} from '../src/project/scaffold.ts'

let tmpDirs: string[] = []

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cnetool-'))
  tmpDirs.push(dir)
  return dir
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

afterEach(async () => {
  await Promise.all(tmpDirs.map((dir) => rm(dir, {recursive: true, force: true})))
  tmpDirs = []
})

describe('readManifest', () => {
  test('throws a helpful "run cnetool init" error when cnetool.json is missing', async () => {
    const dir = await tmp()
    await expect(readManifest(dir)).rejects.toThrow(/cnetool init/)
  })

  test('parses a valid manifest and returns {game}', async () => {
    const dir = await tmp()
    await writeFile(join(dir, 'cnetool.json'), JSON.stringify({game: '/games/ce'}))
    const manifest = await readManifest(dir)
    expect(manifest).toEqual({game: '/games/ce'})
  })

  test('returns {game, deploy} when deploy present', async () => {
    const dir = await tmp()
    await writeFile(
      join(dir, 'cnetool.json'),
      JSON.stringify({game: '/games/ce', deploy: '/deploy/ce'}),
    )
    const manifest = await readManifest(dir)
    expect(manifest).toEqual({game: '/games/ce', deploy: '/deploy/ce'})
  })

  test('drops $schema from the returned object', async () => {
    const dir = await tmp()
    await writeFile(
      join(dir, 'cnetool.json'),
      JSON.stringify({$schema: './.cnetool/schemas/cnetool.schema.json', game: '/games/ce'}),
    )
    const manifest = await readManifest(dir)
    expect(manifest).toEqual({game: '/games/ce'})
    expect('$schema' in manifest).toBe(false)
  })

  test('throws when game is missing', async () => {
    const dir = await tmp()
    await writeFile(join(dir, 'cnetool.json'), JSON.stringify({}))
    await expect(readManifest(dir)).rejects.toThrow(/game/)
  })

  test('throws when game is not a string', async () => {
    const dir = await tmp()
    await writeFile(join(dir, 'cnetool.json'), JSON.stringify({game: 123}))
    await expect(readManifest(dir)).rejects.toThrow(/game/)
  })
})

describe('scaffoldProject', () => {
  test('creates all expected dirs, cnetool.json and .gitignore', async () => {
    const dir = await tmp()
    await scaffoldProject(dir, {game: '/games/ce'})

    const expectedDirs = [
      'source',
      'source/textures',
      'source/objects',
      'source/animations',
      'source/stats',
      'source/config',
      'source/settings',
      'source/sounds',
      'source/levels',
      'source/raw',
      'output',
      '.cnetool/schemas',
    ]
    for (const rel of expectedDirs) {
      const st = await stat(join(dir, rel))
      expect(st.isDirectory()).toBe(true)
    }

    const raw = await readFile(join(dir, 'cnetool.json'), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(raw)
    expect(Object.keys(parsed)[0]).toBe('$schema')
    expect(parsed.$schema).toBe('./.cnetool/schemas/cnetool.schema.json')
    expect(parsed.game).toBe('/games/ce')
    expect('deploy' in parsed).toBe(false)

    const gitignore = await readFile(join(dir, '.gitignore'), 'utf8')
    expect(gitignore).toBe('output/\n.cnetool/cache.json\n')
  })

  test('writes deploy after game when provided', async () => {
    const dir = await tmp()
    await scaffoldProject(dir, {game: '/games/ce', deploy: '/deploy/ce'})
    const raw = await readFile(join(dir, 'cnetool.json'), 'utf8')
    const parsed = JSON.parse(raw)
    expect(Object.keys(parsed)).toEqual(['$schema', 'game', 'deploy'])
    expect(parsed.deploy).toBe('/deploy/ce')
  })

  test('throws if cnetool.json already exists', async () => {
    const dir = await tmp()
    await scaffoldProject(dir, {game: '/games/ce'})
    await expect(scaffoldProject(dir, {game: '/games/ce'})).rejects.toThrow(
      /already a cnetool project/,
    )
  })

  test('round-trips through readManifest', async () => {
    const dir = await tmp()
    await scaffoldProject(dir, {game: '/games/ce', deploy: '/deploy/ce'})
    const manifest = await readManifest(dir)
    expect(manifest).toEqual({game: '/games/ce', deploy: '/deploy/ce'})
  })
})

describe('copySchemas', () => {
  test('copies all five schema files, each valid JSON', async () => {
    const dir = await tmp()
    await copySchemas(dir)

    const names = [
      'cnetool.schema.json',
      'stats.schema.json',
      'menuinfo.schema.json',
      'servinfo.schema.json',
      'entries.schema.json',
    ]
    for (const name of names) {
      const path = join(dir, '.cnetool/schemas', name)
      expect(await exists(path)).toBe(true)
      const parsed = JSON.parse(await readFile(path, 'utf8'))
      expect(typeof parsed).toBe('object')
    }
  })
})
