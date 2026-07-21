// @env node
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {basename, join} from 'node:path'

import {parseMenuInfo, parseServerInfo, parseStatTable} from '../api/index.ts'
import {extractArchiveDir} from './archive-dir.ts'
import {copyThrough, walkFiles} from './fsutil.ts'
import {CONFIG_FILES, STAT_TABLES, TEXTURE_ARCHIVES, isEngineGenerated} from './layout.ts'
import {copySchemas, scaffoldProject} from './scaffold.ts'

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

/** Whether a lowercase relpath names a `.anm` file living under an `anm/` directory. */
function isAnimation(key: string): boolean {
  return key.endsWith('.anm') && (key.startsWith('anm/') || key.includes('/anm/'))
}

/**
 * Turn a Codename Eagle game install into an editable cetool project source
 * tree. Scaffolds the project, then walks the install and routes every file to
 * the domain that owns it: texture archives are unpacked to editable PNGs, stat
 * tables and settings blobs are decoded to JSON, config texts are copied as
 * text, sounds/animations are copied through, and everything else lands in
 * `source/raw/` (engine-generated files are skipped entirely).
 *
 * @param gameDir - The game install directory to import.
 * @param projectDir - The (new) project directory to create.
 */
export async function initProject(gameDir: string, projectDir: string): Promise<void> {
  await scaffoldProject(projectDir, {game: gameDir})
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

  // 2. Stat tables -> source/stats/<source> (JSON)
  const statsRoot = join(projectDir, 'source', 'stats')
  for (const spec of STAT_TABLES) {
    const abs = claim(map, spec.file.toLowerCase())
    if (abs === undefined) continue
    const fields = parseStatTable(await readFile(abs))
    await writeJson(join(statsRoot, spec.source), {
      $schema: '../../.cnetool/schemas/stats.schema.json',
      fields,
    })
  }

  // 3. Settings -> source/settings/*.json (+ pristine menuinfo base)
  const settingsRoot = join(projectDir, 'source', 'settings')
  const menuInfoAbs = claim(map, 'menuinfo.dat')
  if (menuInfoAbs !== undefined) {
    const bytes = await readFile(menuInfoAbs)
    const info = parseMenuInfo(bytes)
    await writeJson(join(settingsRoot, 'menuinfo.json'), {
      $schema: '../../.cnetool/schemas/menuinfo.schema.json',
      ...info,
    })
    const baseDir = join(projectDir, '.cnetool', 'base')
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

  // 5/6. Sounds, animations, then everything else -> raw (skipping engine files).
  const soundsRoot = join(projectDir, 'source', 'sounds')
  const animRoot = join(projectDir, 'source', 'animations')
  const rawRoot = join(projectDir, 'source', 'raw')
  for (const [key, abs] of map) {
    if (key.startsWith('sounds/')) {
      await copyThrough(abs, join(soundsRoot, key.slice('sounds/'.length)))
    } else if (isAnimation(key)) {
      await copyThrough(abs, join(animRoot, basename(key)))
    } else if (!isEngineGenerated(basename(key))) {
      await copyThrough(abs, join(rawRoot, key))
    }
  }
}
