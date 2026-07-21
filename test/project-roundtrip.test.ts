import {mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename, join, relative, sep} from 'node:path'
import {afterEach, describe, expect, test} from 'vitest'

import {
  buildTextureArchive,
  encodeMenuInfo,
  encodePng,
  formatServerInfo,
  formatStatTable,
  pngToTga,
} from '../src/index.ts'
import type {RawImage} from '../src/index.ts'
import {buildProject} from '../src/project/build.ts'
import {initProject} from '../src/project/init.ts'
import {isEngineGenerated} from '../src/project/layout.ts'

const BLOCK_SIZE = 272
const PAYLOAD_SIZE = 816

let tmpDirs: string[] = []

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cnetool-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tmpDirs.map((dir) => rm(dir, {recursive: true, force: true})))
  tmpDirs = []
})

// A small square power-of-two RGB image with a position-dependent pattern.
function makeImage(size: number, seed: number): RawImage {
  const data = new Uint8Array(size * size * 3)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3
      data[i] = (x * 16 + seed) & 0xff
      data[i + 1] = (y * 16 + seed * 3) & 0xff
      data[i + 2] = (x * y + seed * 7) & 0xff
    }
  }
  return {width: size, height: size, channels: 3, data}
}

// A game-faithful archive texture blob (rows top-down behind a bottom-origin descriptor).
function tgaFor(image: RawImage): Uint8Array {
  return pngToTga(encodePng(image), {topDown: true})
}

function writeAscii(data: Uint8Array, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) data[offset + i] = value.charCodeAt(i)
}

function writeU16(data: Uint8Array, offset: number, value: number): void {
  data[offset] = value & 0xff
  data[offset + 1] = (value >> 8) & 0xff
}

// A valid 816-byte menuinfo payload (mirrors test/menuinfo.test.ts).
function menuInfoBytes(): Uint8Array {
  const p = new Uint8Array(PAYLOAD_SIZE)
  writeAscii(p, 0, 'PlayInfo')
  writeAscii(p, BLOCK_SIZE, 'LevelsDone')
  writeAscii(p, BLOCK_SIZE * 2, 'OptionsMenu')
  p[0x10] = 128
  p[0x11] = 1
  p[0x13] = 16
  p[0x15] = 1
  p.set([62, 212, 89, 142], 0x16)
  writeAscii(p, 0x1a, 'MyServer')
  writeAscii(p, 0x42, 'Rexxie')
  p[0x57] = 1
  writeU16(p, 0x58, 2)
  writeU16(p, 0x5a, 1)
  const om = BLOCK_SIZE * 2
  p[om + 0x10] = 190
  p[om + 0x11] = 51
  p[om + 0x12] = 16
  p[om + 0x13] = 255
  p[om + 0x14] = 128
  p[om + 0x15] = 1
  writeU16(p, om + 0x16, 1400)
  writeU16(p, om + 0x18, 1050)
  p[om + 0x1a] = 32
  p[om + 0x1d] = 3
  p[om + 0x21] = 1
  return encodeMenuInfo(p)
}

// Write a synthetic mini-install, built with the real API so every blob is valid.
async function makeInstall(dir: string): Promise<void> {
  const write = async (rel: string, bytes: Uint8Array): Promise<void> => {
    const path = join(dir, rel)
    await mkdir(join(path, '..'), {recursive: true})
    await writeFile(path, bytes)
  }

  await write(
    '24bits/textures.dat',
    buildTextureArchive([
      {name: 'A_TEX.tga', data: tgaFor(makeImage(16, 1))},
      {name: 'btex.tga', data: tgaFor(makeImage(16, 2))},
    ]),
  )

  await write(
    'data3.bin',
    formatStatTable([
      {key: 'Name', value: 'Soldier'},
      {key: 'Health', value: '100'},
    ]),
  )
  await write(
    'data4.bin',
    formatStatTable([
      {key: 'Name', value: 'Rifle'},
      {key: 'Damage', value: '25'},
    ]),
  )

  await write('menuinfo.dat', menuInfoBytes())
  await write(
    'servinfo.dat',
    formatServerInfo({fragLimit: 20, scoreLimit: 5, timeLimit: 15, nextMap: 0}),
  )

  await write('keyconf.dat', latin1Bytes('Forward:W\r\nBack:S\r\n'))

  await write('sounds/fx/shot.wav', new Uint8Array([1, 2, 3, 4, 5]))
  await write('anm/mc.anm', new Uint8Array([9, 8, 7, 6]))
  await write('anm/sub/deep.anm', new Uint8Array([11, 22, 33]))

  await write('ce.exe', new Uint8Array([0x4d, 0x5a, 0x90, 0x00]))
  await write('levels.nfo', latin1Bytes('Name:No mans land\r\nVal:128\r\n'))
  await write('level128/data1.bin', new Uint8Array([10, 20, 30, 40, 50]))

  await write('wcache.bin', new Uint8Array([0xde, 0xad, 0xbe, 0xef]))
}

function latin1Bytes(value: string): Uint8Array {
  const out = new Uint8Array(value.length)
  for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff
  return out
}

// Recursively list every file under `root`, relative posix paths.
async function listFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const recurse = async (current: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(current, {withFileTypes: true})
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) await recurse(full)
      else if (entry.isFile()) out.push(relative(root, full).split(sep).join('/'))
    }
  }
  await recurse(root)
  return out.toSorted()
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe('project init/build round-trip', () => {
  test('init extracts every global domain into source/', async () => {
    const install = await tmp()
    const project = await tmp()
    await makeInstall(install)

    await initProject(install, project)

    const src = (rel: string): string => join(project, 'source', rel)
    expect(await exists(src('textures/textures.dat/a_tex.png'))).toBe(true)
    expect(await exists(src('textures/textures.dat/btex.png'))).toBe(true)
    expect(await exists(src('textures/textures.dat/entries.json'))).toBe(true)

    for (const name of ['units.json', 'weapons.json']) {
      const parsed = JSON.parse(await readFile(src(`stats/${name}`), 'utf8'))
      expect(parsed.$schema).toContain('stats.schema.json')
      expect(Array.isArray(parsed.fields) && parsed.fields.length > 0).toBe(true)
    }

    const menu = JSON.parse(await readFile(src('settings/menuinfo.json'), 'utf8'))
    expect(menu.$schema).toContain('menuinfo.schema.json')
    const serv = JSON.parse(await readFile(src('settings/servinfo.json'), 'utf8'))
    expect(serv.$schema).toContain('servinfo.schema.json')
    expect(await exists(join(project, '.cnetool', 'base', 'menuinfo.dat'))).toBe(true)

    expect(await exists(src('config/keyconf.txt'))).toBe(true)
    expect(await exists(src('sounds/fx/shot.wav'))).toBe(true)
    expect(await exists(src('animations/mc.anm'))).toBe(true)
    // Nested anm/ subdirs are preserved, not flattened to the basename.
    expect(await exists(src('animations/sub/deep.anm'))).toBe(true)
    expect(await exists(src('raw/ce.exe'))).toBe(true)
    expect(await exists(src('raw/levels.nfo'))).toBe(true)
    expect(await exists(src('raw/level128/data1.bin'))).toBe(true)

    // No engine-generated file leaked into source/.
    const sourceFiles = await listFiles(join(project, 'source'))
    expect(sourceFiles.some((f) => basename(f) === 'wcache.bin')).toBe(false)

    expect(await exists(join(project, 'cnetool.json'))).toBe(true)
    expect(await exists(join(project, '.gitignore'))).toBe(true)
    expect((await readdir(join(project, '.cnetool', 'schemas'))).length).toBeGreaterThan(0)
  })

  test('build reproduces the install byte-for-byte (minus engine-generated files)', async () => {
    const install = await tmp()
    const project = await tmp()
    await makeInstall(install)

    await initProject(install, project)
    await buildProject(project)

    const output = join(project, 'output')
    const expected = (await listFiles(install)).filter((f) => !isEngineGenerated(basename(f)))
    const actual = await listFiles(output)
    expect(actual).toEqual(expected)

    expect(actual.some((f) => basename(f) === 'wcache.bin')).toBe(false)

    for (const rel of expected) {
      const a = await readFile(join(install, rel))
      const b = await readFile(join(output, rel))
      expect(Buffer.compare(a, b), `bytes differ for ${rel}`).toBe(0)
    }
  })

  test('building twice is idempotent (cache-skip path produces identical output)', async () => {
    const install = await tmp()
    const project = await tmp()
    await makeInstall(install)

    await initProject(install, project)
    await buildProject(project)

    const output = join(project, 'output')
    const files = await listFiles(output)
    const first = await Promise.all(files.map((rel) => readFile(join(output, rel))))

    // Second build: copy-through domains hit the fresh cache and are skipped.
    await buildProject(project)

    const filesAgain = await listFiles(output)
    expect(filesAgain).toEqual(files)
    for (let i = 0; i < files.length; i++) {
      expect(Buffer.compare(first[i]!, await readFile(join(output, files[i]!))), files[i]).toBe(0)
    }
  })

  test('build sweeps a pre-seeded engine-generated file out of output/', async () => {
    const install = await tmp()
    const project = await tmp()
    await makeInstall(install)

    await initProject(install, project)
    const stale = join(project, 'output', 'wcache.bin')
    await mkdir(join(stale, '..'), {recursive: true})
    await writeFile(stale, new Uint8Array([1, 2, 3]))

    await buildProject(project)

    expect(await exists(stale)).toBe(false)
  })
})
