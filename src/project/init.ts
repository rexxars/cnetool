// @env node
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {basename, join} from 'node:path'

import {parseMenuInfo, parseServerInfo, parseUnitTable, parseWeaponTable} from '../api/index.ts'
import {extractArchiveDir} from './archive-dir.ts'
import {copyThrough, pathExists, walkFiles} from './fsutil.ts'
import {
  CONFIG_FILES,
  OBJECT_ARCHIVES,
  STAT_TABLES,
  TEXTURE_ARCHIVES,
  isIgnoredFile,
} from './layout.ts'
import {extractObjectsArchive} from './objects-dir.ts'
import {copySchemas, createSkeleton, writeManifest} from './scaffold.ts'

const latin1 = new TextDecoder('latin1')

/**
 * Take a `key` out of the install map if present, returning its absolute path.
 * Claimed files are removed so later domains (and the final `raw/` fallback) do
 * not re-process them.
 */
function claim(map: Map<string, string>, key: string): string | undefined {
  const abs = map.get(key)
  if (abs !== undefined) map.delete(key)
  return abs
}

/** Write a JSON document with a leading `$schema` reference, 2-space indent + newline. */
async function writeJson(path: string, document: Record<string, unknown>): Promise<void> {
  await mkdir(join(path, '..'), {recursive: true})
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`)
}

/** Whether a lowercase relpath is a `.anm` file directly under the top-level `anm/` directory. */
function isAnimation(key: string): boolean {
  return key.startsWith('anm/') && key.endsWith('.anm')
}

/**
 * Turn a Codename Eagle game install into an editable cetool project source
 * tree. Scaffolds the project, then walks the install and routes every file to
 * the domain that owns it: texture archives are unpacked to editable PNGs, stat
 * tables and settings blobs are decoded to JSON, config texts are copied as
 * text, object archives are exploded into per-project OBJ directories,
 * sounds/animations are copied through, and everything else lands in
 * `source/raw/` (engine-generated files are skipped entirely).
 *
 * @param gameDir - The game install directory to import.
 * @param projectDir - The (new) project directory to create.
 */
export async function initProject(gameDir: string, projectDir: string): Promise<void> {
  // Refuse to clobber an existing project. The manifest is written LAST (below),
  // so a failure partway through extraction leaves no cnetool.json — a re-run of
  // `cnetool init` into the same directory is not blocked by a stale manifest.
  if (await pathExists(join(projectDir, 'cnetool.json'))) {
    throw new Error(`${projectDir} is already a cnetool project.`)
  }
  await createSkeleton(projectDir)
  await copySchemas(projectDir)

  // Map lowercase-relative-path -> real absolute path (installs mix case).
  const map = new Map<string, string>()
  for (const rel of await walkFiles(gameDir)) {
    map.set(rel.toLowerCase(), join(gameDir, rel))
  }

  // 1. Texture archives -> source/textures/<sourceDir>/
  const texturesRoot = join(projectDir, 'source', 'textures')
  for (const spec of TEXTURE_ARCHIVES) {
    const abs = claim(map, spec.installPath)
    if (abs === undefined) continue
    const bytes = await readFile(abs)
    await extractArchiveDir(bytes, join(texturesRoot, spec.sourceDir))
  }

  // 2. Stat tables -> source/stats/<source> (typed JSON). Build re-serializes
  // the typed shape from scratch (value-identical to stock), so no pristine base
  // is captured for stats — unlike menuinfo, which is patched over its base below.
  const statsRoot = join(projectDir, 'source', 'stats')
  for (const spec of STAT_TABLES) {
    const abs = claim(map, spec.file.toLowerCase())
    if (abs === undefined) continue
    const bytes = await readFile(abs)
    if (spec.kind === 'units') {
      await writeJson(join(statsRoot, spec.source), {
        $schema: '../../.cnetool/schemas/units.schema.json',
        units: parseUnitTable(bytes),
      })
    } else {
      const table = parseWeaponTable(bytes)
      await writeJson(join(statsRoot, spec.source), {
        $schema: '../../.cnetool/schemas/weapons.schema.json',
        ammoDamage: table.ammoDamage,
        weapons: table.weapons,
      })
    }
  }

  // 3. Settings -> source/settings/*.json (+ pristine menuinfo base)
  const settingsRoot = join(projectDir, 'source', 'settings')
  const baseDir = join(projectDir, '.cnetool', 'base')
  const menuInfoAbs = claim(map, 'menuinfo.dat')
  if (menuInfoAbs !== undefined) {
    const bytes = await readFile(menuInfoAbs)
    const info = parseMenuInfo(bytes)
    await writeJson(join(settingsRoot, 'menuinfo.json'), {
      $schema: '../../.cnetool/schemas/menuinfo.schema.json',
      ...info,
    })
    await mkdir(baseDir, {recursive: true})
    await writeFile(join(baseDir, 'menuinfo.dat'), bytes)
  }
  const servInfoAbs = claim(map, 'servinfo.dat')
  if (servInfoAbs !== undefined) {
    const info = parseServerInfo(await readFile(servInfoAbs))
    await writeJson(join(settingsRoot, 'servinfo.json'), {
      $schema: '../../.cnetool/schemas/servinfo.schema.json',
      ...info,
    })
  }

  // 4. Config texts -> source/config/<source> (latin1 text, byte-exact)
  const configRoot = join(projectDir, 'source', 'config')
  for (const spec of CONFIG_FILES) {
    const abs = claim(map, spec.file.toLowerCase())
    if (abs === undefined) continue
    const text = latin1.decode(await readFile(abs))
    await mkdir(configRoot, {recursive: true})
    await writeFile(join(configRoot, spec.source), text, 'latin1')
  }

  // 5. Object archives -> source/objects/<archive>/ (projects + textures.json)
  const objectsRoot = join(projectDir, 'source', 'objects')
  for (const archive of OBJECT_ARCHIVES) {
    const abs = claim(map, archive.toLowerCase())
    if (abs === undefined) continue
    await extractObjectsArchive(await readFile(abs), join(objectsRoot, archive.toLowerCase()))
  }

  // 6/7. Sounds, animations, then everything else -> raw (skipping engine files).
  const soundsRoot = join(projectDir, 'source', 'sounds')
  const animRoot = join(projectDir, 'source', 'animations')
  const rawRoot = join(projectDir, 'source', 'raw')
  for (const [key, abs] of map) {
    // Engine-generated files are never source, in any domain.
    if (isIgnoredFile(basename(key))) continue
    if (key.startsWith('sounds/')) {
      await copyThrough(abs, join(soundsRoot, key.slice('sounds/'.length)))
    } else if (isAnimation(key)) {
      // Preserve any subdirs under anm/ (mirrors how sounds are handled).
      await copyThrough(abs, join(animRoot, key.slice('anm/'.length)))
    } else {
      await copyThrough(abs, join(rawRoot, key))
    }
  }

  // Manifest last: only a fully-extracted project gets a cnetool.json, so a
  // mid-init failure never leaves a project that blocks re-running init.
  await writeManifest(projectDir, {game: gameDir})
}
