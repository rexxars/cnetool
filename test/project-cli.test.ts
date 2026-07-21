import {mkdir, mkdtemp, rm, stat, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

import {formatStatTable} from '../src/index.ts'
import {findProjectRoot, runBuild} from '../src/cli/build.ts'
import {runInit} from '../src/cli/init.ts'

let tmpDirs: string[] = []

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cnetool-cli-'))
  tmpDirs.push(dir)
  return dir
}

beforeEach(() => {
  process.exitCode = 0
})

afterEach(async () => {
  await Promise.all(tmpDirs.map((dir) => rm(dir, {recursive: true, force: true})))
  tmpDirs = []
  vi.restoreAllMocks()
  process.exitCode = 0
})

function latin1Bytes(value: string): Uint8Array {
  const out = new Uint8Array(value.length)
  for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff
  return out
}

// A minimal but valid mini-install: one stat table + one raw config text.
async function makeInstall(dir: string): Promise<void> {
  await writeFile(
    join(dir, 'data3.bin'),
    formatStatTable([
      {key: 'Name', value: 'Soldier'},
      {key: 'Health', value: '100'},
    ]),
  )
  await writeFile(
    join(dir, 'levels.nfo'),
    latin1Bytes('Name:No mans land\r\nVal:128\r\n'),
    'latin1',
  )
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

interface Captured {
  stdout: () => string
  stderr: () => string
}

function capture(): Captured {
  const out: string[] = []
  const err: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
    out.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
    err.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
    return true
  })
  return {stdout: () => out.join(''), stderr: () => err.join('')}
}

describe('runInit', () => {
  test('extracts a valid install into a fresh project dir', async () => {
    const install = await tmp()
    const project = await tmp()
    await makeInstall(install)

    capture()
    await runInit([install, project])

    expect(process.exitCode).toBe(0)
    expect(await exists(join(project, 'cnetool.json'))).toBe(true)
    expect(await exists(join(project, 'source'))).toBe(true)
    expect(await exists(join(project, 'output'))).toBe(true)
    expect(await exists(join(project, 'source', 'stats', 'units.json'))).toBe(true)
    expect(await exists(join(project, 'source', 'raw', 'levels.nfo'))).toBe(true)
  })

  test('errors and sets exit code 1 when the game dir is missing', async () => {
    const project = await tmp()
    const cap = capture()

    await runInit([join(tmpdir(), 'cnetool-does-not-exist-xyz'), project])

    expect(process.exitCode).toBe(1)
    expect(cap.stderr()).toMatch(/not found|directory/i)
  })

  test('errors when the game path is a file, not a directory', async () => {
    const install = await tmp()
    const file = join(install, 'data3.bin')
    await makeInstall(install)
    const project = await tmp()
    const cap = capture()

    await runInit([file, project])

    expect(process.exitCode).toBe(1)
    expect(cap.stderr()).toMatch(/directory/i)
  })

  test('prints usage on --help and does not set a failure exit code', async () => {
    const cap = capture()
    await runInit(['--help'])
    expect(cap.stdout()).toMatch(/Usage: cnetool init/)
    expect(process.exitCode).toBe(0)
  })

  test('prints usage and exits 1 when no game dir is given', async () => {
    const cap = capture()
    await runInit([])
    expect(cap.stdout()).toMatch(/Usage: cnetool init/)
    expect(process.exitCode).toBe(1)
  })

  test('refuses a non-empty directory that is not a cnetool project', async () => {
    const install = await tmp()
    await makeInstall(install)
    const project = await tmp()
    await writeFile(join(project, 'unrelated.txt'), 'hello')
    const cap = capture()

    await runInit([install, project])

    expect(process.exitCode).toBe(1)
    expect(cap.stderr()).toMatch(/not empty|not a cnetool project/i)
    expect(await exists(join(project, 'cnetool.json'))).toBe(false)
  })
})

describe('runBuild', () => {
  test('builds output/ after an init', async () => {
    const install = await tmp()
    const project = await tmp()
    await makeInstall(install)

    capture()
    await runInit([install, project])
    expect(process.exitCode).toBe(0)

    await runBuild([project])

    expect(process.exitCode).toBe(0)
    expect(await exists(join(project, 'output', 'data3.bin'))).toBe(true)
    expect(await exists(join(project, 'output', 'levels.nfo'))).toBe(true)
  })

  test('rejects --watch as not implemented', async () => {
    const cap = capture()
    await runBuild(['--watch'])
    expect(process.exitCode).toBe(1)
    expect(cap.stderr()).toMatch(/--watch is not implemented yet/)
  })

  test('prints usage on --help', async () => {
    const cap = capture()
    await runBuild(['--help'])
    expect(cap.stdout()).toMatch(/Usage: cnetool build/)
    expect(process.exitCode).toBe(0)
  })

  test('errors mentioning cnetool init when the target is not a project', async () => {
    const notProject = await tmp()
    await expect(runBuild([notProject])).rejects.toThrow(/cnetool init/)
  })
})

describe('findProjectRoot', () => {
  test('walks up from a nested directory to the nearest cnetool.json', async () => {
    const install = await tmp()
    const project = await tmp()
    await makeInstall(install)

    capture()
    await runInit([install, project])

    const nested = join(project, 'source', 'stats')
    await mkdir(nested, {recursive: true})
    expect(await findProjectRoot(nested)).toBe(project)
  })

  test('returns the project root itself when it contains cnetool.json', async () => {
    const install = await tmp()
    const project = await tmp()
    await makeInstall(install)

    capture()
    await runInit([install, project])

    expect(await findProjectRoot(project)).toBe(project)
  })

  test('rejects, mentioning cnetool init, when no project is found', async () => {
    const dir = await tmp()
    await expect(findProjectRoot(dir)).rejects.toThrow(/cnetool init/)
  })
})
