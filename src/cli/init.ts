// @env node
import {readdir, stat} from 'node:fs/promises'
import {resolve} from 'node:path'
import {parseArgs} from 'node:util'

import {initProject} from '../project/init.ts'
import {isEnoent} from '../project/fsutil.ts'

const usage = `Usage: cnetool init <game-dir> [project-dir]

Extract a Codename Eagle install into an editable project source tree. Texture
archives become PNGs, stat tables and settings blobs become JSON, object
archives explode into per-model OBJ directories, and everything else is copied
through - all under <project-dir>/source/. The manifest (cnetool.json) records
the game path so "cnetool build" can re-encode a loadable install into output/.

<project-dir> defaults to the current directory. It must be empty or a fresh
path (an existing cnetool project is rejected - init does not overwrite).

Options:
  -h, --help          Show this help.
`

/** List a directory's entries; a missing directory is treated as empty. */
async function readDirEntries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch (error) {
    if (isEnoent(error)) return []
    throw error
  }
}

/**
 * Run the `init` CLI command.
 *
 * @param argv - Arguments following the `init` command.
 */
export async function runInit(argv: string[]): Promise<void> {
  const {values, positionals} = parseArgs({
    args: argv,
    options: {
      help: {type: 'boolean', short: 'h'},
    },
    allowPositionals: true,
  })

  if (values.help || positionals.length === 0) {
    process.stdout.write(usage)
    if (positionals.length === 0 && !values.help) process.exitCode = 1
    return
  }

  const gameDir = positionals[0]!
  const projectDir = positionals[1] ?? '.'

  let gameStat
  try {
    gameStat = await stat(gameDir)
  } catch {
    process.stderr.write(`Game directory not found: ${gameDir}\n`)
    process.exitCode = 1
    return
  }
  if (!gameStat.isDirectory()) {
    process.stderr.write(`Game path is not a directory: ${gameDir}\n`)
    process.exitCode = 1
    return
  }

  // Refuse a non-empty directory that is not already a cnetool project, so init
  // never scatters a source tree into an unrelated directory. (An already-
  // scaffolded project is caught by initProject with a clear "already a project"
  // message.) An empty dir or a fresh path is fine.
  const entries = await readDirEntries(projectDir)
  if (entries.length > 0 && !entries.includes('cnetool.json')) {
    process.stderr.write(
      `${resolve(projectDir)} is not empty and is not a cnetool project - choose an empty directory or a new path.\n`,
    )
    process.exitCode = 1
    return
  }

  await initProject(gameDir, projectDir)

  process.stdout.write(`Initialized cnetool project in ${resolve(projectDir)}\n`)
  process.stdout.write(
    `Edit the tree under source/, then run "cnetool build" to produce output/.\n`,
  )
}
