// @env node
import {mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises'
import {basename, dirname, join} from 'node:path'

import {
  formatMenuInfo,
  formatServerInfo,
  formatStatTable,
  type MenuInfo,
  type ServerInfo,
  type StatField,
} from '../api/index.ts'
import {buildArchiveDirTexture} from './archive-dir.ts'
import {hashFile, isFresh, loadCache, putEntry, saveCache, type BuildCache} from './cache.ts'
import {copyThrough, pathExists, walkFiles} from './fsutil.ts'
import {CONFIG_FILES, STAT_TABLES, TEXTURE_ARCHIVES, isEngineGenerated} from './layout.ts'
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
 * blobs, config texts are re-encoded, and sounds/animations/raw files are copied
 * through. Engine-generated files are swept from `output/` first (they are never
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

  await buildTextures(sourceDir, outputDir)
  await buildStats(sourceDir, outputDir)
  await buildSettings(projectDir, sourceDir, outputDir)
  await buildConfig(sourceDir, outputDir)
  await buildCopyThrough(sourceDir, outputDir, cache)

  if (cache !== undefined) await saveCache(cachePath, cache)
}

async function buildTextures(sourceDir: string, outputDir: string): Promise<void> {
  for (const spec of TEXTURE_ARCHIVES) {
    const dir = join(sourceDir, 'textures', spec.sourceDir)
    if (!(await pathExists(dir))) continue
    const bytes = await buildArchiveDirTexture(dir)
    await writeOutput(join(outputDir, spec.installPath), bytes)
  }
}

async function buildStats(sourceDir: string, outputDir: string): Promise<void> {
  for (const spec of STAT_TABLES) {
    const path = join(sourceDir, 'stats', spec.source)
    if (!(await pathExists(path))) continue
    const fields = readStatFields(await readFile(path, 'utf8'), spec.source)
    await writeOutput(join(outputDir, spec.file), formatStatTable(fields))
  }
}

async function buildSettings(
  projectDir: string,
  sourceDir: string,
  outputDir: string,
): Promise<void> {
  const menuInfoPath = join(sourceDir, 'settings', 'menuinfo.json')
  if (await pathExists(menuInfoPath)) {
    const info = readMenuInfo(await readFile(menuInfoPath, 'utf8'))
    const base = await readFile(join(projectDir, '.cnetool', 'base', 'menuinfo.dat'))
    await writeOutput(join(outputDir, 'menuinfo.dat'), formatMenuInfo(base, menuInfoToPatch(info)))
  }

  const servInfoPath = join(sourceDir, 'settings', 'servinfo.json')
  if (await pathExists(servInfoPath)) {
    const info = readServerInfo(await readFile(servInfoPath, 'utf8'))
    await writeOutput(join(outputDir, 'servinfo.dat'), formatServerInfo(info))
  }
}

async function buildConfig(sourceDir: string, outputDir: string): Promise<void> {
  for (const spec of CONFIG_FILES) {
    const path = join(sourceDir, 'config', spec.source)
    if (!(await pathExists(path))) continue
    const text = latin1.decode(await readFile(path))
    await mkdir(join(outputDir, spec.file, '..'), {recursive: true})
    await writeFile(join(outputDir, spec.file), text, 'latin1')
  }
}

async function buildCopyThrough(
  sourceDir: string,
  outputDir: string,
  cache: BuildCache | undefined,
): Promise<void> {
  const soundsSrc = join(sourceDir, 'sounds')
  for (const rel of await walkFiles(soundsSrc)) {
    await copyCached(join(soundsSrc, rel), join(outputDir, 'sounds', rel), `sounds/${rel}`, cache)
  }

  const animSrc = join(sourceDir, 'animations')
  for (const rel of await walkFiles(animSrc)) {
    await copyCached(join(animSrc, rel), join(outputDir, 'anm', rel), `animations/${rel}`, cache)
  }

  const rawSrc = join(sourceDir, 'raw')
  for (const rel of await walkFiles(rawSrc)) {
    await copyCached(join(rawSrc, rel), join(outputDir, rel), `raw/${rel}`, cache)
  }
}

/**
 * Copy `src` to `dest`, skipping the copy when the cache marks the source fresh
 * and the destination already exists. On a copy, records the source's hash.
 * With no cache (`cache === undefined`) it always copies.
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
    putEntry(cache, key, {mtimeMs, size}, await hashFile(src))
    return
  }
  await copyThrough(src, dest)
}

async function writeOutput(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), {recursive: true})
  await writeFile(path, bytes)
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

function readStatFields(raw: string, source: string): StatField[] {
  const label = `stats source ${source}`
  const record = asRecord(parseJson(raw, label), label)
  const {fields} = record
  if (!Array.isArray(fields)) throw new Error(`${label}: "fields" must be an array`)
  return fields.map((entry, index) => {
    const fieldLabel = `${label} field ${index}`
    const field = asRecord(entry, fieldLabel)
    return {
      key: str(field, 'key', fieldLabel),
      value: str(field, 'value', fieldLabel),
      chunk: num(field, 'chunk', fieldLabel),
    }
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
