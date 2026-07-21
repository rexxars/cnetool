// @env node
import {dirname, join, resolve} from 'node:path'
import {parseArgs} from 'node:util'

import {buildProject} from '../project/build.ts'
import {pathExists} from '../project/fsutil.ts'

const usage = `Usage: cnetool build [project-dir] [options]

Re-encode a project's source tree into a loadable game install under output/.
The inverse of "cnetool init": texture directories are repacked into archives,
stat/settings JSON is re-serialized to binary, config texts are re-encoded,
object directories are repacked, and sounds/animations/raw files are copied
through (unchanged files skip via the build cache).

<project-dir> defaults to the nearest ancestor of the current directory that
contains a cnetool.json.

Options:
  --no-cache          Ignore the build cache; re-copy every file.
  -h, --help          Show this help.
`

/**
 * Walk up from `startDir` to the nearest ancestor containing a `cnetool.json`,
 * returning that directory. Throws (mentioning `cnetool init`) if none is found
 * before the filesystem root.
 *
 * @param startDir - Directory to start the upward search from.
 */
export async function findProjectRoot(startDir: string): Promise<string> {
  let dir = resolve(startDir)
  for (;;) {
    if (await pathExists(join(dir, 'cnetool.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(
    `No cnetool.json found in ${resolve(startDir)} or any parent directory — run "cnetool init <game-dir>" first.`,
  )
}

/**
 * Run the `build` CLI command.
 *
 * @param argv - Arguments following the `build` command.
 */
export async function runBuild(argv: string[]): Promise<void> {
  const {values, positionals} = parseArgs({
    args: argv,
    options: {
      'no-cache': {type: 'boolean'},
      watch: {type: 'boolean'},
      help: {type: 'boolean', short: 'h'},
    },
    allowPositionals: true,
  })

  if (values.help) {
    process.stdout.write(usage)
    return
  }

  if (values.watch) {
    process.stderr.write('--watch is not implemented yet\n')
    process.exitCode = 1
    return
  }

  const projectRoot =
    positionals.length > 0 ? positionals[0]! : await findProjectRoot(process.cwd())

  await buildProject(projectRoot, {noCache: values['no-cache']})

  process.stdout.write(`Built ${join(projectRoot, 'output')}\n`)
}
