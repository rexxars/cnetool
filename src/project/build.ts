// @env node
import {mkdir, readdir, readFile, rm, rmdir, stat, writeFile} from 'node:fs/promises'
import {basename, dirname, join, relative, sep} from 'node:path'

import {
  formatMenuInfo,
  formatServerInfo,
  formatStatTable,
  setStatField,
  type MenuInfo,
  type ServerInfo,
} from '../api/index.ts'
import {buildArchiveDirTexture} from './archive-dir.ts'
import {isFresh, loadCache, putEntry, saveCache, type BuildCache} from './cache.ts'
import {copyThrough, isEnoent, pathExists, walkFiles} from './fsutil.ts'
import {
  CONFIG_FILES,
  OBJECT_ARCHIVES,
  STAT_TABLES,
  TEXTURE_ARCHIVES,
  isEngineGenerated,
} from './layout.ts'
import {buildObjectsArchive} from './objects-dir.ts'
import {readManifest} from './scaffold.ts'
import {menuInfoToPatch} from './settings.ts'

const latin1 = new TextDecoder('latin1')

/** Build options for {@link buildProject}. */
export interface BuildOptions {
  /** Skip the build cache entirely (always re-copy, never read or write it). */
  noCache?: boolean
}

/**
 * Assemble a cetool project's `source/` tree into a loadable game install layout
 * under `output/`. The inverse of {@link initProject}: texture directories are
 * repacked into archives, stat/settings JSON is re-serialized to the binary
 * blobs, config texts are re-encoded, object directories are repacked into
 * `objects.dat`, and sounds/animations/raw files are copied through. Engine-generated files are swept from `output/` first (they are never
 * build products), and copy-through work is skipped for unchanged files via the
 * build cache.
 *
 * @param projectDir - The cetool project directory (must contain `cnetool.json`).
 * @param options - Build options; see {@link BuildOptions}.
 */
export async function buildProject(projectDir: string, options: BuildOptions = {}): Promise<void> {
  const {noCache = false} = options
  // Errors clearly if `projectDir` is not a cetool project.
  await readManifest(projectDir)

  const cachePath = join(projectDir, '.cnetool', 'cache.json')
  const cache = noCache ? undefined : await loadCache(cachePath)

  const sourceDir = join(projectDir, 'source')
  const outputDir = join(projectDir, 'output')

  // Sweep engine-generated files out of output/ — never build products.
  for (const rel of await walkFiles(outputDir)) {
    if (isEngineGenerated(basename(rel))) await rm(join(outputDir, rel))
  }

  // Every output relpath this run produces; used below to prune orphans.
  const produced = new Set<string>()

  await buildTextures(sourceDir, outputDir, produced)
  await buildStats(projectDir, sourceDir, outputDir, produced)
  await buildSettings(projectDir, sourceDir, outputDir, produced)
  await buildConfig(sourceDir, outputDir, produced)
  await buildObjects(sourceDir, outputDir, produced)
  await buildCopyThrough(sourceDir, outputDir, cache, produced)

  // Prune orphans: files whose source was deleted/renamed since the last build.
  // Without this, output/ drifts from source/ and the "complete install" would
  // accumulate phantom files. Independent of the cache-skip optimization above.
  for (const rel of await walkFiles(outputDir)) {
    if (!produced.has(rel)) await rm(join(outputDir, rel))
  }
  await removeEmptyDirs(outputDir)

  if (cache !== undefined) await saveCache(cachePath, cache)
}

async function buildTextures(
  sourceDir: string,
  outputDir: string,
  produced: Set<string>,
): Promise<void> {
  for (const spec of TEXTURE_ARCHIVES) {
    const dir = join(sourceDir, 'textures', spec.sourceDir)
    if (!(await pathExists(dir))) continue
    const bytes = await buildArchiveDirTexture(dir)
    await writeOutput(outputDir, join(outputDir, spec.installPath), bytes, produced)
  }
}

async function buildStats(
  projectDir: string,
  sourceDir: string,
  outputDir: string,
  produced: Set<string>,
): Promise<void> {
  const baseDir = join(projectDir, '.cnetool', 'base')
  for (const spec of STAT_TABLES) {
    const path = join(sourceDir, 'stats', spec.source)
    if (!(await pathExists(path))) continue
    const fields = readStatFields(await readFile(path, 'utf8'), spec.source)
    const base = await readFileOrNull(join(baseDir, spec.file))
    await writeOutput(
      outputDir,
      join(outputDir, spec.file),
      rebuildStatTable(fields, base),
      produced,
    )
  }
}

/**
 * Rebuild a stat-table blob. When a pristine base exists (`.cnetool/base/<file>`,
 * captured at init), overlay each field's text onto it with {@link setStatField},
 * preserving the binary ballistics/damage tables the chunks carry past the
 * `Key:Value` line — byte-identical for an unmodified project. Only when no base
 * is present (e.g. a hand-authored stat file with no original) does it fall back
 * to {@link formatStatTable}, which zero-fills the chunk tails; that path is
 * best-effort and can't preserve binary payload it never saw.
 */
function rebuildStatTable(fields: StatFieldInput[], base: Uint8Array | null): Uint8Array {
  if (base === null) return formatStatTable(fields)
  let data = base
  for (const field of fields) {
    if (field.chunk === undefined) {
      throw new Error(
        `stat field "${field.key}" has no "chunk" index; cannot overlay onto the base — re-run "cnetool init" or add a numeric "chunk".`,
      )
    }
    data = setStatField(data, field.chunk, field.key, field.value)
  }
  return data
}

async function buildSettings(
  projectDir: string,
  sourceDir: string,
  outputDir: string,
  produced: Set<string>,
): Promise<void> {
  const menuInfoPath = join(sourceDir, 'settings', 'menuinfo.json')
  if (await pathExists(menuInfoPath)) {
    const info = readMenuInfo(await readFile(menuInfoPath, 'utf8'))
    const base = await readFile(join(projectDir, '.cnetool', 'base', 'menuinfo.dat'))
    await writeOutput(
      outputDir,
      join(outputDir, 'menuinfo.dat'),
      formatMenuInfo(base, menuInfoToPatch(info)),
      produced,
    )
  }

  const servInfoPath = join(sourceDir, 'settings', 'servinfo.json')
  if (await pathExists(servInfoPath)) {
    const info = readServerInfo(await readFile(servInfoPath, 'utf8'))
    await writeOutput(outputDir, join(outputDir, 'servinfo.dat'), formatServerInfo(info), produced)
  }
}

async function buildObjects(
  sourceDir: string,
  outputDir: string,
  produced: Set<string>,
): Promise<void> {
  for (const archive of OBJECT_ARCHIVES) {
    const dir = join(sourceDir, 'objects', archive.toLowerCase())
    if (!(await pathExists(dir))) continue
    await writeOutput(
      outputDir,
      join(outputDir, archive.toLowerCase()),
      await buildObjectsArchive(dir),
      produced,
    )
  }
}

async function buildConfig(
  sourceDir: string,
  outputDir: string,
  produced: Set<string>,
): Promise<void> {
  for (const spec of CONFIG_FILES) {
    const path = join(sourceDir, 'config', spec.source)
    if (!(await pathExists(path))) continue
    const text = latin1.decode(await readFile(path))
    const dest = join(outputDir, spec.file)
    await mkdir(dirname(dest), {recursive: true})
    await writeFile(dest, text, 'latin1')
    produced.add(toRel(outputDir, dest))
  }
}

async function buildCopyThrough(
  sourceDir: string,
  outputDir: string,
  cache: BuildCache | undefined,
  produced: Set<string>,
): Promise<void> {
  const soundsSrc = join(sourceDir, 'sounds')
  for (const rel of await walkFiles(soundsSrc)) {
    const dest = join(outputDir, 'sounds', rel)
    await copyCached(join(soundsSrc, rel), dest, `sounds/${rel}`, cache)
    produced.add(toRel(outputDir, dest))
  }

  const animSrc = join(sourceDir, 'animations')
  for (const rel of await walkFiles(animSrc)) {
    const dest = join(outputDir, 'anm', rel)
    await copyCached(join(animSrc, rel), dest, `animations/${rel}`, cache)
    produced.add(toRel(outputDir, dest))
  }

  const rawSrc = join(sourceDir, 'raw')
  for (const rel of await walkFiles(rawSrc)) {
    const dest = join(outputDir, rel)
    await copyCached(join(rawSrc, rel), dest, `raw/${rel}`, cache)
    produced.add(toRel(outputDir, dest))
  }
}

/**
 * Copy `src` to `dest`, skipping the copy when the cache marks the source fresh
 * (`mtimeMs`+`size`) and the destination already exists. On a copy, records the
 * source's stat only — no hashing, so large files are not re-read to hash and
 * discard. With no cache (`cache === undefined`) it always copies.
 */
async function copyCached(
  src: string,
  dest: string,
  key: string,
  cache: BuildCache | undefined,
): Promise<void> {
  if (cache !== undefined) {
    const {mtimeMs, size} = await stat(src)
    if (isFresh(cache, key, {mtimeMs, size}) && (await pathExists(dest))) return
    await copyThrough(src, dest)
    putEntry(cache, key, {mtimeMs, size})
    return
  }
  await copyThrough(src, dest)
}

async function writeOutput(
  outputDir: string,
  path: string,
  bytes: Uint8Array,
  produced: Set<string>,
): Promise<void> {
  await mkdir(dirname(path), {recursive: true})
  await writeFile(path, bytes)
  produced.add(toRel(outputDir, path))
}

/** An output path relative to `outputDir`, as a stable forward-slash relpath. */
function toRel(outputDir: string, path: string): string {
  return relative(outputDir, path).split(sep).join('/')
}

/** Read a file's bytes, or `null` when it does not exist. */
async function readFileOrNull(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path)
  } catch (error) {
    if (isEnoent(error)) return null
    throw error
  }
}

/**
 * Recursively remove now-empty directories under `root` (bottom-up), leaving
 * `root` itself in place. Run after pruning orphaned files so directories whose
 * last file was deleted don't linger in the output tree.
 */
async function removeEmptyDirs(root: string): Promise<void> {
  let entries
  try {
    entries = await readdir(root, {withFileTypes: true})
  } catch (error) {
    if (isEnoent(error)) return
    throw error
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = join(root, entry.name)
    await removeEmptyDirs(full)
    if ((await readdir(full)).length === 0) await rmdir(full)
  }
}

// --- JSON coercion (type-safe: narrow via guards, never assert) ---

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label}: expected a JSON object`)
  }
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) out[key] = Reflect.get(value, key)
  return out
}

function num(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key]
  if (typeof value !== 'number') throw new Error(`${label}: "${key}" must be a number`)
  return value
}

function str(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key]
  if (typeof value !== 'string') throw new Error(`${label}: "${key}" must be a string`)
  return value
}

function bool(record: Record<string, unknown>, key: string, label: string): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') throw new Error(`${label}: "${key}" must be a boolean`)
  return value
}

/** A stat field read from source JSON: `key`/`value`, plus the `chunk` index the
 * base-overlay rebuild needs to place it (optional — only the no-base fallback,
 * {@link formatStatTable}, can proceed without it). */
interface StatFieldInput {
  key: string
  value: string
  chunk?: number
}

// The `chunk` index (written by init) is required to overlay onto the pristine
// base; it stays optional here so a hand-authored stat file without a base can
// still fall back to `formatStatTable`. `rebuildStatTable` enforces its presence
// when a base exists.
function readStatFields(raw: string, source: string): StatFieldInput[] {
  const label = `stats source ${source}`
  const record = asRecord(parseJson(raw, label), label)
  const {fields} = record
  if (!Array.isArray(fields)) throw new Error(`${label}: "fields" must be an array`)
  return fields.map((entry, index) => {
    const fieldLabel = `${label} field ${index}`
    const field = asRecord(entry, fieldLabel)
    const result: StatFieldInput = {
      key: str(field, 'key', fieldLabel),
      value: str(field, 'value', fieldLabel),
    }
    if ('chunk' in field && field.chunk !== undefined) {
      result.chunk = num(field, 'chunk', fieldLabel)
    }
    return result
  })
}

function readMenuInfo(raw: string): MenuInfo {
  const label = 'settings/menuinfo.json'
  const record = asRecord(parseJson(raw, label), label)
  const resolution = asRecord(record.resolution, `${label} resolution`)
  return {
    lastLevel: num(record, 'lastLevel', label),
    multiplayer: bool(record, 'multiplayer', label),
    maxPlayers: num(record, 'maxPlayers', label),
    networkProtocol: num(record, 'networkProtocol', label),
    serverIp: str(record, 'serverIp', label),
    hostName: str(record, 'hostName', label),
    playerName: str(record, 'playerName', label),
    gameMode: num(record, 'gameMode', label),
    saveSlot: num(record, 'saveSlot', label),
    team: num(record, 'team', label),
    soundVolume: num(record, 'soundVolume', label),
    musicVolume: num(record, 'musicVolume', label),
    soundChannels: num(record, 'soundChannels', label),
    detail: num(record, 'detail', label),
    graphicFx: num(record, 'graphicFx', label),
    renderer: num(record, 'renderer', label),
    resolution: {
      width: num(resolution, 'width', label),
      height: num(resolution, 'height', label),
      depth: num(resolution, 'depth', label),
    },
    language: num(record, 'language', label),
    subtitles: bool(record, 'subtitles', label),
  }
}

function readServerInfo(raw: string): ServerInfo {
  const label = 'settings/servinfo.json'
  const record = asRecord(parseJson(raw, label), label)
  return {
    fragLimit: num(record, 'fragLimit', label),
    scoreLimit: num(record, 'scoreLimit', label),
    timeLimit: num(record, 'timeLimit', label),
    nextMap: num(record, 'nextMap', label),
  }
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`${label}: malformed JSON`, {cause: error})
  }
}
