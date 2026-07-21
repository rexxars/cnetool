import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, test} from 'vitest'

import {
  emptyCache,
  hashFile,
  isFresh,
  loadCache,
  putEntry,
  saveCache,
} from '../src/project/cache.ts'

let tmpDirs: string[] = []

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cetool-cache-'))
  tmpDirs.push(dir)
  return dir
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

afterEach(async () => {
  await Promise.all(tmpDirs.map((dir) => rm(dir, {recursive: true, force: true})))
  tmpDirs = []
})

describe('emptyCache', () => {
  test('returns a fresh empty cache', () => {
    expect(emptyCache()).toEqual({version: 1, entries: {}})
  })
})

describe('loadCache', () => {
  test('returns empty cache when file is missing', async () => {
    const dir = await tmp()
    expect(await loadCache(join(dir, 'nope.json'))).toEqual({version: 1, entries: {}})
  })

  test('returns empty cache on malformed JSON', async () => {
    const dir = await tmp()
    const path = join(dir, 'cache.json')
    await writeFile(path, 'not json')
    expect(await loadCache(path)).toEqual({version: 1, entries: {}})
  })

  test('returns empty cache on wrong version', async () => {
    const dir = await tmp()
    const path = join(dir, 'cache.json')
    await writeFile(path, JSON.stringify({version: 99, entries: {}}))
    expect(await loadCache(path)).toEqual({version: 1, entries: {}})
  })

  test('returns empty cache when entries is an array', async () => {
    const dir = await tmp()
    const path = join(dir, 'cache.json')
    await writeFile(path, JSON.stringify({version: 1, entries: []}))
    expect(await loadCache(path)).toEqual({version: 1, entries: {}})
  })

  test('returns empty cache when an entry has a malformed shape', async () => {
    const dir = await tmp()
    const path = join(dir, 'cache.json')
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        entries: {
          good: {mtimeMs: 1, size: 2, hash: 'ok'},
          missingHash: {mtimeMs: 3, size: 4},
          stringSize: {mtimeMs: 5, size: '6', hash: 'bad'},
        },
      }),
    )
    expect(await loadCache(path)).toEqual({version: 1, entries: {}})
  })
})

describe('saveCache / loadCache round-trip', () => {
  test('persists a populated cache and creates parent dirs', async () => {
    const dir = await tmp()
    const path = join(dir, 'nested', 'deeper', 'cache.json')
    const cache = emptyCache()
    putEntry(cache, 'source/foo.txt', {mtimeMs: 123, size: 456}, 'abc123')

    await saveCache(path, cache)

    const raw = await readFile(path, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(raw).toContain('  ') // pretty-printed with 2-space indent

    const loaded = await loadCache(path)
    expect(loaded).toEqual(cache)
  })
})

describe('hashFile', () => {
  test('matches an independent sha256 of the bytes', async () => {
    const dir = await tmp()
    const path = join(dir, 'blob.bin')
    const bytes = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255, 42, 7])
    await writeFile(path, bytes)

    const expected = toHex(await crypto.subtle.digest('SHA-256', bytes))
    expect(await hashFile(path)).toBe(expected)
  })

  test('streams a payload larger than the read highWaterMark', async () => {
    const dir = await tmp()
    const path = join(dir, 'big.bin')
    // 200 KB of varied bytes (well past the 64 KB default highWaterMark),
    // so a single-buffer regression would still be caught but the point is
    // that multiple stream chunks feed the hash.
    const bytes = new Uint8Array(200 * 1024)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff
    await writeFile(path, bytes)

    const expected = toHex(await crypto.subtle.digest('SHA-256', bytes))
    expect(await hashFile(path)).toBe(expected)
  })
})

describe('isFresh', () => {
  test('true when mtimeMs and size both match', () => {
    const cache = emptyCache()
    putEntry(cache, 'k', {mtimeMs: 10, size: 20}, 'h')
    expect(isFresh(cache, 'k', {mtimeMs: 10, size: 20})).toBe(true)
  })

  test('false when size differs', () => {
    const cache = emptyCache()
    putEntry(cache, 'k', {mtimeMs: 10, size: 20}, 'h')
    expect(isFresh(cache, 'k', {mtimeMs: 10, size: 21})).toBe(false)
  })

  test('false when mtimeMs differs', () => {
    const cache = emptyCache()
    putEntry(cache, 'k', {mtimeMs: 10, size: 20}, 'h')
    expect(isFresh(cache, 'k', {mtimeMs: 11, size: 20})).toBe(false)
  })

  test('false when key absent', () => {
    const cache = emptyCache()
    expect(isFresh(cache, 'missing', {mtimeMs: 10, size: 20})).toBe(false)
  })
})

describe('putEntry', () => {
  test('adds and overwrites entries in place', () => {
    const cache = emptyCache()
    putEntry(cache, 'k', {mtimeMs: 1, size: 2}, 'first')
    expect(cache.entries.k).toEqual({mtimeMs: 1, size: 2, hash: 'first'})

    putEntry(cache, 'k', {mtimeMs: 3, size: 4}, 'second')
    expect(cache.entries.k).toEqual({mtimeMs: 3, size: 4, hash: 'second'})
  })
})
