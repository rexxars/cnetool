// @env node
import {readFile, writeFile} from 'node:fs/promises'
import {parseArgs} from 'node:util'

import {formatServerInfo, parseLevelIndex, parseServerInfo} from '../api/index.ts'
import type {LevelIndexEntry, ServerInfo} from '../api/index.ts'

const usage = `Usage: cnetool servinfo <servinfo.dat> [options]

Read or edit the host multiplayer match settings persisted in servinfo.dat
(fraglimit, scorelimit, timelimit in minutes, and the map-rotation "nextmap").
The game host loads these on session start and saves them on session end, so
they survive restarts - set them once for a dedicated server.

With no write options, the current settings are printed. Passing any of the
write options edits the file in place (unspecified fields are preserved); use
-o to write elsewhere.

Options:
  --frag <n>            Kill limit that ends the round (0 = no limit).
  --score <n>           Score limit that ends the round (0 = no limit).
  --time <minutes>      Time limit in minutes (0 = no limit).
  --nextmap <n|name|off>  Map to rotate to when a round ends. A number is used
                        as-is; a name is resolved against LEVELS.NFO; "off"
                        (or 0) disables rotation.
  --levels <file>       LEVELS.NFO to resolve a --nextmap name (default ./levels.nfo).
  -o, --output <file>   Write here instead of editing the input in place.
  -h, --help            Show this help.
`

/** The write-option keys; presence of any switches the command into write mode. */
const WRITE_OPTIONS = ['frag', 'score', 'time', 'nextmap'] as const

/**
 * Resolve a `--nextmap` argument to a level number: a numeric value is used
 * directly, `off` means 0 (rotation disabled), and anything else is matched
 * case-insensitively by name against a parsed `LEVELS.NFO` index.
 *
 * @param value - The raw `--nextmap` argument.
 * @param index - The parsed level index (from {@link parseLevelIndex}).
 */
export function resolveNextMap(value: string, index: LevelIndexEntry[]): number {
  const trimmed = value.trim()
  if (trimmed.toLowerCase() === 'off') return 0
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10)

  const match = index.find((entry) => entry.name.toLowerCase() === trimmed.toLowerCase())
  if (!match) {
    throw new Error(`nextmap: no level named "${trimmed}" in LEVELS.NFO`)
  }
  return match.number
}

/** Show a limit field as "off" when 0, else the number. */
function limitText(n: number): string {
  return n === 0 ? 'off' : String(n)
}

/** Render server settings for display, showing disabled (0) fields as "off". */
export function formatServerInfoText(info: ServerInfo): string {
  return [
    `Frag limit:  ${limitText(info.fragLimit)}`,
    `Score limit: ${limitText(info.scoreLimit)}`,
    `Time limit:  ${info.timeLimit === 0 ? 'off' : `${info.timeLimit} min`}`,
    `Next map:    ${info.nextMap === 0 ? 'off (no rotation)' : info.nextMap}`,
    '',
  ].join('\n')
}

/**
 * Run the `servinfo` CLI command.
 *
 * @param argv - Arguments following the `servinfo` command.
 */
export async function runServinfo(argv: string[]): Promise<void> {
  const {values, positionals} = parseArgs({
    args: argv,
    options: {
      frag: {type: 'string'},
      score: {type: 'string'},
      time: {type: 'string'},
      nextmap: {type: 'string'},
      levels: {type: 'string'},
      output: {type: 'string', short: 'o'},
      help: {type: 'boolean', short: 'h'},
    },
    allowPositionals: true,
  })

  if (values.help || positionals.length === 0) {
    process.stdout.write(usage)
    if (positionals.length === 0 && !values.help) process.exitCode = 1
    return
  }

  const input = positionals[0]!
  const writing = WRITE_OPTIONS.some((key) => values[key] !== undefined)

  // Start from the existing file (so unspecified fields are preserved); fall
  // back to all-zero defaults if it doesn't exist yet.
  let info: ServerInfo
  try {
    info = parseServerInfo(await readFile(input))
  } catch (error) {
    if (writing && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      info = {fragLimit: 0, scoreLimit: 0, timeLimit: 0, nextMap: 0}
    } else {
      throw error
    }
  }

  if (!writing) {
    process.stdout.write(formatServerInfoText(info))
    return
  }

  if (values.frag !== undefined) info.fragLimit = Number.parseInt(values.frag, 10)
  if (values.score !== undefined) info.scoreLimit = Number.parseInt(values.score, 10)
  if (values.time !== undefined) info.timeLimit = Number.parseInt(values.time, 10)
  if (values.nextmap !== undefined) {
    const needsIndex = !/^(-?\d+|off)$/i.test(values.nextmap.trim())
    const index = needsIndex ? parseLevelIndex(await readFile(values.levels ?? 'levels.nfo')) : []
    info.nextMap = resolveNextMap(values.nextmap, index)
  }

  const output = values.output ?? input
  await writeFile(output, formatServerInfo(info))
  process.stderr.write(`Wrote ${output}\n`)
}
