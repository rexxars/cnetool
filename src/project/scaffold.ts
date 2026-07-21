// @env node
import {access, copyFile, mkdir, readdir, readFile, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import {isEnoent} from './fsutil.ts'

export interface ProjectManifest {
  game: string
  deploy?: string
}

const SOURCE_SUBDIRS = [
  'textures',
  'objects',
  'animations',
  'stats',
  'config',
  'settings',
  'sounds',
  'levels',
  'raw',
]

/** Whether a filesystem path is accessible (used to detect an existing manifest). */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function readManifest(projectDir: string): Promise<ProjectManifest> {
  const manifestPath = join(projectDir, 'cnetool.json')

  let raw: string
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch (error) {
    if (isEnoent(error)) {
      throw new Error(
        `No cnetool.json found in ${projectDir} — run "cnetool init <game-dir>" first.`,
        {cause: error},
      )
    }
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Invalid cnetool.json in ${projectDir}: not valid JSON.`, {cause: error})
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid cnetool.json in ${projectDir}: expected a JSON object.`)
  }

  const game = 'game' in parsed ? parsed.game : undefined
  if (typeof game !== 'string' || game.length === 0) {
    throw new Error(`Invalid cnetool.json in ${projectDir}: "game" must be a non-empty string.`)
  }

  const manifest: ProjectManifest = {game}

  const deploy = 'deploy' in parsed ? parsed.deploy : undefined
  if (deploy !== undefined) {
    if (typeof deploy !== 'string' || deploy.length === 0) {
      throw new Error(`Invalid cnetool.json in ${projectDir}: "deploy" must be a non-empty string.`)
    }
    manifest.deploy = deploy
  }

  return manifest
}

/**
 * Create a project's directory skeleton: the `source/` subdirs, `output/`,
 * `.cnetool/schemas/`, and the `.gitignore`. Everything except the manifest, so
 * that `initProject` can lay down the tree, run all extraction, and only then
 * commit the `cnetool.json` — a mid-init failure leaves no manifest to block a
 * re-run.
 */
export async function createSkeleton(projectDir: string): Promise<void> {
  for (const sub of SOURCE_SUBDIRS) {
    await mkdir(join(projectDir, 'source', sub), {recursive: true})
  }
  await mkdir(join(projectDir, 'output'), {recursive: true})
  await mkdir(join(projectDir, '.cnetool', 'schemas'), {recursive: true})
  await writeFile(join(projectDir, '.gitignore'), 'output/\n.cnetool/cache.json\n')
}

/** Write the `cnetool.json` manifest (`$schema`, `game`, optional `deploy`). */
export async function writeManifest(projectDir: string, manifest: ProjectManifest): Promise<void> {
  const contents: Record<string, string> = {
    $schema: './.cnetool/schemas/cnetool.schema.json',
    game: manifest.game,
  }
  if (manifest.deploy !== undefined) {
    contents.deploy = manifest.deploy
  }
  await writeFile(join(projectDir, 'cnetool.json'), `${JSON.stringify(contents, null, 2)}\n`)
}

export async function scaffoldProject(
  projectDir: string,
  manifest: ProjectManifest,
): Promise<void> {
  const manifestPath = join(projectDir, 'cnetool.json')
  if (await fileExists(manifestPath)) {
    throw new Error(`${projectDir} is already a cnetool project.`)
  }

  await createSkeleton(projectDir)
  await writeManifest(projectDir, manifest)
}

export async function copySchemas(projectDir: string): Promise<void> {
  const schemasDir = join(import.meta.dirname, '../../schemas')
  const destDir = join(projectDir, '.cnetool', 'schemas')
  await mkdir(destDir, {recursive: true})

  const names = await readdir(schemasDir)
  for (const name of names) {
    if (!name.endsWith('.schema.json')) continue
    await copyFile(join(schemasDir, name), join(destDir, name))
  }
}
