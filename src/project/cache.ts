// @env node
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {dirname} from 'node:path'
import {pipeline} from 'node:stream/promises'

export interface CacheEntry {
  mtimeMs: number
  size: number
  hash: string
}

export interface BuildCache {
  version: 1
  entries: Record<string, CacheEntry>
}

/** A fresh, empty cache. */
export function emptyCache(): BuildCache {
  return {version: 1, entries: {}}
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isBuildCache(value: unknown): value is BuildCache {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    value.version === 1 &&
    'entries' in value &&
    typeof value.entries === 'object' &&
    value.entries !== null
  )
}

/**
 * Read and parse the build cache. A missing file, malformed JSON, or a cache
 * with an unrecognized version all degrade to an empty cache (forcing a full
 * rebuild). Unexpected errors (e.g. permission denied) propagate.
 */
export async function loadCache(cachePath: string): Promise<BuildCache> {
  let raw: string
  try {
    raw = await readFile(cachePath, 'utf8')
  } catch (error) {
    if (isEnoent(error)) return emptyCache()
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyCache()
  }

  return isBuildCache(parsed) ? parsed : emptyCache()
}

/** Write the cache as pretty JSON (2-space indent) with a trailing newline. */
export async function saveCache(cachePath: string, cache: BuildCache): Promise<void> {
  await mkdir(dirname(cachePath), {recursive: true})
  await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`)
}

/** Streamed sha256 of a file, returned as lowercase hex. */
export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(filePath), hash)
  return hash.digest('hex')
}

/**
 * Cheap freshness check: true iff an entry exists for `key` and both its
 * `mtimeMs` and `size` match the given stat. Does not compare hashes — callers
 * fall back to hashing on a miss.
 */
export function isFresh(
  cache: BuildCache,
  key: string,
  stat: {mtimeMs: number; size: number},
): boolean {
  const entry = cache.entries[key]
  return entry !== undefined && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size
}

/** Record (or overwrite) an entry for `key`, mutating the cache in place. */
export function putEntry(
  cache: BuildCache,
  key: string,
  stat: {mtimeMs: number; size: number},
  hash: string,
): void {
  cache.entries[key] = {mtimeMs: stat.mtimeMs, size: stat.size, hash}
}
