import {mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename, join, relative, sep} from 'node:path'
import {afterEach, describe, expect, test} from 'vitest'

import {
  buildArchive,
  buildTextureArchive,
  encodeMenuInfo,
  encodePng,
  formatServerInfo,
  pngToTga,
  serializeMesh,
  serializeUnitTable,
  serializeWeaponTable,
} from '../src/index.ts'
import type {Mesh, RawImage, Unit, WeaponTable} from '../src/index.ts'
import {buildProject} from '../src/project/build.ts'
import {initProject} from '../src/project/init.ts'
import {isIgnoredFile} from '../src/project/layout.ts'

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

// A small textured quad mesh referencing texId 0 (the objects.dat texture table).
function quadMesh(): Mesh {
  return {
    vertices: [
      {x: 0, y: 0, z: 0},
      {x: 2, y: 0, z: 0},
      {x: 2, y: 2, z: 0},
      {x: 0, y: 2, z: 0},
    ],
    faces: [
      {
        vertices: [0, 1, 2, 3],
        color: {r: 128, g: 128, b: 128},
        alpha: 255,
        flags: 4,
        texId: 0,
        uv: [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      },
    ],
  }
}

// A small objects.dat: one mesh project (referencing one texture) + a non-mesh
// raw stub, with the texId → filename table so the mesh's face resolves.
function objectsDat(): Uint8Array {
  return buildArchive(
    [
      {name: 'Ramp', data: serializeMesh(quadMesh())},
      {name: 'Stub', data: new Uint8Array([0, 0, 0, 0, 1, 2, 3])}, // vc=0 → not a mesh
    ],
    {textures: ['ROAD.TGA']},
  )
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

  // Stat tables in CANONICAL serialized form, so init (decode) -> build
  // (re-serialize) reproduces them byte-identically. One unit has armor, one
  // does not; the weapon table carries all three ammoDamage rows and two weapons.
  await write('data3.bin', serializeUnitTable(canonicalUnits))
  await write('data4.bin', serializeWeaponTable(canonicalWeapons))

  await write('objects.dat', objectsDat())

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

  // OS filesystem cruft (SMB shares expose it as `.ds_store`) — must never enter
  // the source tree or a build, at any depth.
  await write('.DS_Store', new Uint8Array([0, 0, 0, 1]))
  await write('level128/.DS_Store', new Uint8Array([0, 0, 0, 2]))
}

// Canonical typed stat fixtures: serialized to data3/data4.bin, these round-trip
// byte-identically through init (decode -> JSON) and build (JSON -> re-serialize).
const canonicalUnits: Unit[] = [
  {name: 'Soldier', armor: 'light', health: 100, fireDelay: 0.5},
  {name: 'Crate', health: 40, fireDelay: 0},
]

const canonicalWeapons: WeaponTable = {
  ammoDamage: {
    gas: {heavy: 0, light: 50, none: 100},
    bullet: {heavy: 11, light: 21, none: 100},
    shell: {heavy: 100, light: 100, none: 100},
  },
  weapons: [
    {
      index: 0,
      name: 'Rifle',
      damage: 25,
      ammoType: 'bullet',
      ammoSpeed: 800,
      fireDelay: 0.2,
      weaponLength: 1.5,
      sound: 'sounds/fx/shot.wav',
    },
    {
      index: 1,
      name: 'Cannon',
      damage: 120,
      ammoType: 'shell',
      ammoSpeed: 400,
      fireDelay: 1.5,
      weaponLength: 3,
      sound: 'sounds/fx/boom.wav',
    },
  ],
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

    const units = JSON.parse(await readFile(src('stats/units.json'), 'utf8'))
    expect(units.$schema).toContain('units.schema.json')
    expect(units.fields).toBeUndefined()
    expect(units.units).toEqual(canonicalUnits)

    const weapons = JSON.parse(await readFile(src('stats/weapons.json'), 'utf8'))
    expect(weapons.$schema).toContain('weapons.schema.json')
    expect(weapons.fields).toBeUndefined()
    expect(weapons.ammoDamage).toEqual(canonicalWeapons.ammoDamage)
    expect(weapons.weapons).toEqual(canonicalWeapons.weapons)

    const menu = JSON.parse(await readFile(src('settings/menuinfo.json'), 'utf8'))
    expect(menu.$schema).toContain('menuinfo.schema.json')
    const serv = JSON.parse(await readFile(src('settings/servinfo.json'), 'utf8'))
    expect(serv.$schema).toContain('servinfo.schema.json')

    // Only menuinfo is captured as a pristine base (it is patched over on build);
    // stat tables are re-serialized from their typed JSON, so no base is kept.
    expect(await exists(join(project, '.cnetool', 'base', 'menuinfo.dat'))).toBe(true)
    expect(await exists(join(project, '.cnetool', 'base', 'data3.bin'))).toBe(false)
    expect(await exists(join(project, '.cnetool', 'base', 'data4.bin'))).toBe(false)

    // Object archive: exploded into a per-project dir + a raw stub + sidecars.
    const objBase = 'objects/objects.dat'
    expect(await exists(src(`${objBase}/ramp/high.obj`))).toBe(true)
    expect(await exists(src(`${objBase}/ramp/project.json`))).toBe(true)
    expect(await exists(src(`${objBase}/ramp/model.mtl`))).toBe(true)
    expect(await exists(src(`${objBase}/raw/stub.bin`))).toBe(true)
    const textures = JSON.parse(await readFile(src(`${objBase}/textures.json`), 'utf8'))
    expect(textures.textures).toEqual(['ROAD.TGA'])
    const objEntries = JSON.parse(await readFile(src(`${objBase}/entries.json`), 'utf8'))
    expect(objEntries.entries.map((e: {name: string; kind: string}) => [e.name, e.kind])).toEqual([
      ['Ramp', 'mesh'],
      ['Stub', 'raw'],
    ])
    const rampProject = JSON.parse(await readFile(src(`${objBase}/ramp/project.json`), 'utf8'))
    expect(rampProject.name).toBe('Ramp')
    expect(rampProject.materials.m0.texture).toBe('ROAD.TGA')

    expect(await exists(src('config/keyconf.txt'))).toBe(true)
    expect(await exists(src('sounds/fx/shot.wav'))).toBe(true)
    expect(await exists(src('animations/mc.anm'))).toBe(true)
    // Nested anm/ subdirs are preserved, not flattened to the basename.
    expect(await exists(src('animations/sub/deep.anm'))).toBe(true)
    expect(await exists(src('raw/ce.exe'))).toBe(true)
    expect(await exists(src('raw/levels.nfo'))).toBe(true)
    expect(await exists(src('raw/level128/data1.bin'))).toBe(true)

    // No engine-generated file or OS cruft leaked into source/, at any depth.
    const sourceFiles = await listFiles(join(project, 'source'))
    expect(sourceFiles.some((f) => basename(f) === 'wcache.bin')).toBe(false)
    expect(sourceFiles.some((f) => basename(f).toLowerCase() === '.ds_store')).toBe(false)

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
    const expected = (await listFiles(install)).filter((f) => !isIgnoredFile(basename(f)))
    const actual = await listFiles(output)
    expect(actual).toEqual(expected)

    expect(actual.some((f) => basename(f) === 'wcache.bin')).toBe(false)
    expect(actual.some((f) => basename(f).toLowerCase() === '.ds_store')).toBe(false)

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

  test('a stat table round-trips byte-identically from its canonical form', async () => {
    const install = await tmp()
    const project = await tmp()
    await makeInstall(install)

    await initProject(install, project)
    await buildProject(project)

    for (const file of ['data3.bin', 'data4.bin']) {
      const original = await readFile(join(install, file))
      const rebuilt = await readFile(join(project, 'output', file))
      expect(Buffer.compare(original, rebuilt), `bytes differ for ${file}`).toBe(0)
    }
  })

  test('build fails with a clear error on a fractional unit health', async () => {
    const install = await tmp()
    const project = await tmp()
    await makeInstall(install)

    await initProject(install, project)
    // Hand-edit units.json to a fractional health the engine's %d read can't hold.
    const unitsPath = join(project, 'source', 'stats', 'units.json')
    const doc = JSON.parse(await readFile(unitsPath, 'utf8'))
    doc.units[0].health = 100.5
    await writeFile(unitsPath, JSON.stringify(doc, null, 2))

    await expect(buildProject(project)).rejects.toThrow(/health.*integer|integer.*health/i)
  })

  test('.cnetool/base/ is committed (not matched by the generated .gitignore)', async () => {
    const install = await tmp()
    const project = await tmp()
    await makeInstall(install)

    await initProject(install, project)
    const gitignore = await readFile(join(project, '.gitignore'), 'utf8')
    expect(gitignore).toBe('output/\n.cnetool/cache.json\n.DS_Store\n')
    expect(gitignore).not.toContain('base')
  })

  test('a failed init leaves no cnetool.json, so re-init works', async () => {
    const bad = await tmp()
    const project = await tmp()
    await makeInstall(bad)
    // Corrupt a texture archive so extraction throws partway through init.
    await writeFile(join(bad, '24bits', 'textures.dat'), new Uint8Array(8).fill(0xff))

    await expect(initProject(bad, project)).rejects.toThrow()
    // Manifest must NOT exist — otherwise re-running init is blocked.
    expect(await exists(join(project, 'cnetool.json'))).toBe(false)

    // Re-init into the SAME (now manifest-less) dir from a good install succeeds.
    const good = await tmp()
    await makeInstall(good)
    await initProject(good, project)
    expect(await exists(join(project, 'cnetool.json'))).toBe(true)
  })

  test('build prunes stale/orphaned files from output/', async () => {
    const install = await tmp()
    const project = await tmp()
    await makeInstall(install)

    await initProject(install, project)
    await buildProject(project)

    // Drop files whose source no longer exists (deleted/renamed sources).
    const orphanTop = join(project, 'output', 'oldtexture.dat')
    const orphanNested = join(project, 'output', 'raw', 'gone.bin')
    await writeFile(orphanTop, new Uint8Array([1, 2, 3]))
    await mkdir(join(orphanNested, '..'), {recursive: true})
    await writeFile(orphanNested, new Uint8Array([4, 5, 6]))

    await buildProject(project)

    expect(await exists(orphanTop)).toBe(false)
    expect(await exists(orphanNested)).toBe(false)
    // Legitimate outputs remain.
    const output = join(project, 'output')
    expect(await exists(join(output, 'data4.bin'))).toBe(true)
    expect(await exists(join(output, 'menuinfo.dat'))).toBe(true)
    expect(await exists(join(output, 'sounds', 'fx', 'shot.wav'))).toBe(true)
  })
})
