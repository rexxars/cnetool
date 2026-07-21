// @env node
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {basename, isAbsolute, join} from 'node:path'

import {
  buildArchive,
  extractFile,
  parseArchive,
  parseMeshLayers,
  parseObjectTextures,
} from '../api/index.ts'
import type {ArchiveInputEntry} from '../api/index.ts'
import {slugify} from './layout.ts'
import {buildMeshDir, extractMeshDir} from './mesh-dir.ts'

/** Subdirectory holding raw (non-mesh) entry blobs within an object archive dir. */
const RAW_SUBDIR = 'raw'

/** One record in an object archive's `entries.json`, in original TOC order. */
interface ObjectEntryRecord {
  /** The original archive entry name, preserving casing and order. */
  name: string
  /** How the entry is stored on disk. */
  kind: 'mesh' | 'raw'
  /** Project subdirectory (relative to the archive dir) when `kind` is `mesh`. */
  dir?: string
  /** Raw blob file (relative to the archive dir) when `kind` is `raw`. */
  file?: string
}

/**
 * Explode an object archive (`objects.dat` / `objects2.dat`) into an editable
 * directory: a `textures.json` listing the texId → filename table, one editable
 * project subdirectory per mesh entry (see {@link extractMeshDir}), a `raw/` blob
 * per non-mesh entry, and an `entries.json` recording every entry's original name,
 * order and on-disk location for a faithful rebuild.
 *
 * @param data - Raw object-archive bytes.
 * @param dir - Output directory (created if missing).
 */
export async function extractObjectsArchive(data: Uint8Array, dir: string): Promise<void> {
  await mkdir(dir, {recursive: true})
  const {entries} = parseArchive(data)
  const textureNames = parseObjectTextures(data)
  // Material references are by texture NAME, resolved back to a texId via this
  // table's index on rebuild - which is only unambiguous if names are unique.
  assertUniqueTextureNames(textureNames)

  await writeFile(
    join(dir, 'textures.json'),
    `${JSON.stringify({textures: textureNames}, null, 2)}\n`,
  )

  const used = new Set<string>()
  const records: ObjectEntryRecord[] = []
  for (const entry of entries) {
    const blob = extractFile(data, entry)
    const slug = uniqueSlug(entry.name, used)
    // Classify explicitly: a blob with no render geometry is a raw entry; anything
    // else is a mesh, and any error from extractMeshDir is a real bug we let surface
    // (rather than silently degrading an editable model to an opaque blob).
    if (parseMeshLayers(blob, 1).length === 0) {
      const file = join(RAW_SUBDIR, `${slug}.bin`)
      await mkdir(join(dir, RAW_SUBDIR), {recursive: true})
      await writeFile(join(dir, file), blob)
      records.push({name: entry.name, kind: 'raw', file: toPosix(file)})
    } else {
      await extractMeshDir(blob, join(dir, slug), textureNames, entry.name)
      records.push({name: entry.name, kind: 'mesh', dir: slug})
    }
  }

  await writeFile(join(dir, 'entries.json'), `${JSON.stringify({entries: records}, null, 2)}\n`)
}

/**
 * Repack an object archive directory produced by {@link extractObjectsArchive}
 * into a loadable `objects.dat` / `objects2.dat`, the inverse operation. Entries
 * are assembled in `entries.json` order under their original names, with the
 * texture table from `textures.json`.
 *
 * @param dir - The object archive directory to pack.
 */
export async function buildObjectsArchive(dir: string): Promise<Uint8Array> {
  const textureNames = await readTextures(dir)
  const records = await readEntries(dir)

  const entries: ArchiveInputEntry[] = []
  for (const record of records) {
    if (record.kind === 'mesh') {
      if (record.dir === undefined) throw new Error(`${dir} entry "${record.name}": missing "dir"`)
      entries.push({
        name: record.name,
        data: await buildMeshDir(join(dir, record.dir), textureNames),
      })
    } else {
      if (record.file === undefined) {
        throw new Error(`${dir} entry "${record.name}": missing "file"`)
      }
      entries.push({name: record.name, data: await readFile(join(dir, record.file))})
    }
  }

  return buildArchive(entries, {textures: textureNames})
}

/**
 * Reject a texture-name table with duplicate (non-empty) names: material
 * references resolve name → texId by table index, so a duplicate would silently
 * collapse two distinct texIds on rebuild. Empty slots are ignored (an untextured
 * face carries `texture: null`, not an empty-string name).
 */
function assertUniqueTextureNames(names: string[]): void {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const name of names) {
    if (name.length === 0) continue
    if (seen.has(name)) duplicates.add(name)
    else seen.add(name)
  }
  if (duplicates.size > 0) {
    throw new Error(
      `texture-name table has duplicate names (${[...duplicates].join(', ')}); ` +
        `material references resolve by name and would be ambiguous`,
    )
  }
}

/** Convert an entry name to a unique lowercase directory slug within `used`. */
function uniqueSlug(name: string, used: Set<string>): string {
  const base = slugify(name) || 'entry'
  let candidate = base
  let n = 1
  while (used.has(candidate)) {
    n++
    candidate = `${base}-${n}`
  }
  used.add(candidate)
  return candidate
}

function toPosix(path: string): string {
  return path.split('\\').join('/')
}

async function readTextures(dir: string): Promise<string[]> {
  const raw = await readFile(join(dir, 'textures.json'), 'utf8')
  const parsed = parseJson(raw, `${dir}/textures.json`)
  if (typeof parsed !== 'object' || parsed === null || !('textures' in parsed)) {
    throw new Error(`Invalid textures.json in ${dir}: expected an object with a "textures" array.`)
  }
  const {textures} = parsed
  if (!Array.isArray(textures) || !textures.every((t): t is string => typeof t === 'string')) {
    throw new Error(`Invalid textures.json in ${dir}: "textures" must be an array of strings.`)
  }
  assertUniqueTextureNames(textures)
  return textures
}

async function readEntries(dir: string): Promise<ObjectEntryRecord[]> {
  const raw = await readFile(join(dir, 'entries.json'), 'utf8')
  const parsed = parseJson(raw, `${dir}/entries.json`)
  if (typeof parsed !== 'object' || parsed === null || !('entries' in parsed)) {
    throw new Error(`Invalid entries.json in ${dir}: expected an object with an "entries" array.`)
  }
  const {entries} = parsed
  if (!Array.isArray(entries)) {
    throw new Error(`Invalid entries.json in ${dir}: "entries" must be an array.`)
  }
  return entries.map((entry, index) => coerceEntry(entry, dir, index))
}

function coerceEntry(value: unknown, dir: string, index: number): ObjectEntryRecord {
  const label = `entries.json in ${dir}: entry ${index}`
  if (typeof value !== 'object' || value === null) throw new Error(`${label}: expected an object`)
  const name = 'name' in value ? value.name : undefined
  const kind = 'kind' in value ? value.kind : undefined
  if (typeof name !== 'string') throw new Error(`${label}: "name" must be a string`)
  if (kind !== 'mesh' && kind !== 'raw') throw new Error(`${label}: "kind" must be "mesh" or "raw"`)
  const location =
    kind === 'mesh' ? locationField(value, 'dir', label) : locationField(value, 'file', label)
  return kind === 'mesh' ? {name, kind, dir: location} : {name, kind, file: location}
}

// A "dir"/"file" reference must stay within the archive directory: reject
// absolute paths and any ".."-style segment that would escape it.
function locationField(value: object, key: string, label: string): string {
  const field = key in value ? Reflect.get(value, key) : undefined
  if (typeof field !== 'string' || field.length === 0) {
    throw new Error(`${label}: "${key}" must be a non-empty string`)
  }
  const segments = field.split('/')
  if (isAbsolute(field) || segments.includes('..') || segments.some((s) => basename(s) !== s)) {
    throw new Error(
      `${label}: "${key}" must be a relative path within the archive dir, got "${field}"`,
    )
  }
  return field
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`Invalid JSON in ${label}.`, {cause: error})
  }
}
