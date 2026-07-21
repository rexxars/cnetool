// @env node
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises'
import {basename, extname, isAbsolute, join} from 'node:path'

import {buildTextureArchive, extractEntries, pngToTga, tgaToPng} from '../api/index.ts'
import type {ArchiveInputEntry} from '../api/index.ts'
import {isEnoent} from './fsutil.ts'

/**
 * The `$schema` reference written into each `entries.json`. The sidecar lives at
 * `source/textures/<archive>/entries.json` - three levels below the project root,
 * where `.cnetool/schemas/` sits - so the relative path climbs three directories.
 */
// Assumes the archive dir sits 3 levels under the project root (source/<domain>/<archive>/),
// which holds for both texture and object archive directories.
const ENTRIES_SCHEMA_REF = '../../../.cnetool/schemas/entries.schema.json'

/** One record of an archive directory's `entries.json` sidecar. */
interface EntrySidecarRecord {
  /** The on-disk filename in this directory (lowercase). */
  file: string
  /** The original archive entry name, preserving casing and order. */
  name: string
}

/**
 * Extract a Codename Eagle archive into a directory of editable assets plus an
 * `entries.json` sidecar that records the original entry names and order for a
 * faithful rebuild.
 *
 * Texture entries are decoded to upright PNGs (`<name>.png`); every other entry
 * is written as its raw stored blob (`<name>.bin`). Filenames are sanitized to a
 * single safe lowercase segment and de-duplicated with `-2`, `-3`, ... suffixes so
 * two entries never overwrite each other.
 *
 * @param data - Raw archive bytes.
 * @param dir - Output directory (created if missing).
 */
export async function extractArchiveDir(data: Uint8Array, dir: string): Promise<void> {
  await mkdir(dir, {recursive: true})

  const entries = extractEntries(data)
  const used = new Set<string>()
  const records: EntrySidecarRecord[] = []

  for (const entry of entries) {
    const isTexture = entry.kind === 'tga'
    const ext = isTexture ? '.png' : '.bin'
    const file = uniqueName(`${sanitizeStem(entry.name)}${ext}`, used)
    // Textures: archive blobs store rows top-down behind a bottom-origin descriptor
    // (the engine reads them verbatim), so `topOrigin` yields an upright PNG. No
    // colour-key here - extraction stays byte-faithful, keeping opaque textures RGB.
    const bytes = isTexture ? tgaToPng(entry.data, {topOrigin: true}) : entry.data
    await writeFile(join(dir, file), bytes)
    records.push({file, name: entry.name})
  }

  const sidecar = {$schema: ENTRIES_SCHEMA_REF, entries: records}
  await writeFile(join(dir, 'entries.json'), `${JSON.stringify(sidecar, null, 2)}\n`)
}

/**
 * Read an archive directory back into the named blobs to repack, the inverse of
 * {@link extractArchiveDir}. Entries listed in `entries.json` come first, in
 * sidecar order, under their recorded original names; any file present in the
 * directory but not listed (a user-added asset) is appended in sorted filename
 * order. Naming is keyed off the on-disk extension so both archive kinds stay
 * consistent: a `.png` extra becomes a game-ready TGA named `<stem>.tga` (the only
 * form the engine recognises as a texture); anything else is read as raw bytes and
 * named by its bare stem (objects.dat project entries are bare-named).
 *
 * Task 7 (objects) reuses this to gather an object archive's flat entries.
 *
 * @param dir - The archive directory to read.
 * @throws If a listed file is missing, or an extra's computed name collides with
 *   an already-included entry name.
 */
export async function readArchiveDirEntries(dir: string): Promise<ArchiveInputEntry[]> {
  const records = await readSidecar(dir)
  const listed = new Set(records.map((record) => record.file))
  const result: ArchiveInputEntry[] = []
  const takenNames = new Set<string>()

  for (const record of records) {
    const data = await loadEntryFile(dir, record.file)
    result.push({name: record.name, data})
    takenNames.add(record.name)
  }

  const dirents = await readdir(dir, {withFileTypes: true})
  const extras = dirents
    .filter((dirent) => dirent.isFile())
    .map((dirent) => dirent.name)
    .filter((name) => name !== 'entries.json' && !listed.has(name))
    .toSorted()

  for (const file of extras) {
    const data = await loadEntryFile(dir, file)
    const stem = basename(file, extname(file))
    // A .png extra is a texture, which the engine only recognises under a `.tga`
    // name; every other extra keeps a bare stem (objects.dat project entries).
    const name = file.toLowerCase().endsWith('.png') ? `${stem}.tga` : stem
    if (takenNames.has(name)) {
      throw new Error(
        `added file ${file} in ${dir} maps to entry name "${name}", which is already used`,
      )
    }
    takenNames.add(name)
    result.push({name, data})
  }

  return result
}

/**
 * Build a Codename Eagle texture archive (`textures.dat`, `texsec.dat`,
 * `menupics.dat`) from an archive directory produced by {@link extractArchiveDir}.
 *
 * @param dir - The archive directory to pack.
 */
export async function buildArchiveDirTexture(dir: string): Promise<Uint8Array> {
  return buildTextureArchive(await readArchiveDirEntries(dir))
}

// Convert one on-disk asset file back to its stored blob: PNGs become game-ready
// TGAs (rows stored top-down, matching the archive convention), everything else is raw.
async function loadEntryFile(dir: string, file: string): Promise<Uint8Array> {
  let bytes: Uint8Array
  try {
    bytes = await readFile(join(dir, file))
  } catch (error) {
    if (isEnoent(error)) throw new Error(`listed file ${file} missing from ${dir}`, {cause: error})
    throw error
  }
  if (file.toLowerCase().endsWith('.png')) return pngToTga(bytes, {topDown: true})
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

async function readSidecar(dir: string): Promise<EntrySidecarRecord[]> {
  const path = join(dir, 'entries.json')
  const raw = await readFile(path, 'utf8')

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Invalid entries.json in ${dir}: not valid JSON.`, {cause: error})
  }
  if (typeof parsed !== 'object' || parsed === null || !('entries' in parsed)) {
    throw new Error(`Invalid entries.json in ${dir}: expected an object with an "entries" array.`)
  }
  const {entries} = parsed
  if (!Array.isArray(entries)) {
    throw new Error(`Invalid entries.json in ${dir}: "entries" must be an array.`)
  }

  return entries.map((record, index): EntrySidecarRecord => {
    if (
      typeof record !== 'object' ||
      record === null ||
      !('file' in record) ||
      !('name' in record) ||
      typeof record.file !== 'string' ||
      typeof record.name !== 'string'
    ) {
      throw new Error(
        `Invalid entries.json in ${dir}: entry ${index} must have string "file" and "name".`,
      )
    }
    // Reject path traversal: "file" must be a bare filename within `dir`, never a
    // separator-bearing, absolute, or ".."-style path that escapes the directory.
    if (
      isAbsolute(record.file) ||
      /[/\\]/.test(record.file) ||
      basename(record.file) !== record.file
    ) {
      throw new Error(
        `Invalid entries.json in ${dir}: entry ${index} "file" must be a bare filename, got "${record.file}".`,
      )
    }
    return {file: record.file, name: record.name}
  })
}

// Reduce an entry name to a safe lowercase filename stem (no extension): drop any
// directory part, lowercase, and collapse anything outside [a-z0-9._-] to a hyphen.
function sanitizeStem(name: string): string {
  const base = basename(name.replace(/\\/g, '/'))
  const stem = base.slice(0, base.length - extname(base).length)
  const cleaned = stem
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return cleaned.length > 0 ? cleaned : 'unnamed'
}

// Return a filename not yet in `used`, appending -2, -3, ... before the extension
// on collision; records the chosen name so later calls stay distinct.
function uniqueName(name: string, used: Set<string>): string {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let candidate = name
  let n = 1
  while (used.has(candidate)) {
    n++
    candidate = `${stem}-${n}${ext}`
  }
  used.add(candidate)
  return candidate
}
