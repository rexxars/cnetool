// @env node
import {readFile, writeFile} from 'node:fs/promises'
import {parseArgs} from 'node:util'

import {formatMenuInfo, parseMenuInfo} from '../api/index.ts'
import type {MenuInfo, MenuInfoPatch} from '../api/index.ts'

const usage = `Usage: cnetool menuinfo <menuinfo.dat> [options]

Read or edit the persisted menu profile/options in menuinfo.dat (the encrypted,
zlib-compressed profile file: player/host name, team, game mode, network,
resolution, renderer, language, audio, ...).

With no write options, the current settings are printed. Passing any write
option edits the file in place (unspecified fields are preserved); use -o to
write elsewhere. The file must already exist.

Enum options accept a name or a raw number.

Options:
  --name <s>            Player name (<= 19 chars; the host truncates to 10 online).
  --host <s>            Host/server name (<= 39 chars).
  --server-ip <a.b.c.d> Last-connected server IP (what "4711 4" reconnects to).
  --netproto <tcp|ipx>  Network protocol.
  --team <red|blue|auto> Team (auto is normalised to a concrete team on host).
  --mode <deathmatch|ctf|teamplay>  Game mode.
  --maxplayers <n>      Max players for a hosted game.
  --renderer <3dfx|direct3d|software>  Renderer.
  --width <n> --height <n> --depth <n>  Display mode.
  --detail <low|medium|max>   Geometry/detail level.
  --gfx <none|medium|max>     Graphic FX level.
  --sound <0-255> --music <0-255>  Volumes.
  --channels <4|8|16>   Sound channels.
  --language <english|spanish|italian|french|german>  Menu/subtitle language.
  --subtitles <on|off>  In-game subtitles.
  -o, --output <file>   Write here instead of editing the input in place.
  -h, --help            Show this help.
`

/** The write-option keys; presence of any switches the command into write mode. */
const WRITE_OPTIONS = [
  'name',
  'host',
  'server-ip',
  'netproto',
  'team',
  'mode',
  'maxplayers',
  'renderer',
  'width',
  'height',
  'depth',
  'detail',
  'gfx',
  'sound',
  'music',
  'channels',
  'language',
  'subtitles',
] as const

const TEAM_ALIASES: Record<string, number> = {red: 0, blue: 1, auto: 2}
const MODE_ALIASES: Record<string, number> = {deathmatch: 0, dm: 0, ctf: 1, teamplay: 2, team: 2}
const PROTO_ALIASES: Record<string, number> = {ipx: 0, tcp: 1, 'tcp/ip': 1, tcpip: 1}
const RENDERER_ALIASES: Record<string, number> = {
  '3dfx': 0,
  glide: 0,
  direct3d: 1,
  d3d: 1,
  software: 2,
  soft: 2,
}
const LANGUAGE_ALIASES: Record<string, number> = {
  english: 1,
  en: 1,
  spanish: 2,
  es: 2,
  italian: 3,
  it: 3,
  french: 4,
  fr: 4,
  german: 5,
  de: 5,
}
const LEVEL3_ALIASES: Record<string, number> = {low: 0, none: 0, medium: 128, med: 128, max: 255}

const TEAM_NAMES: Record<number, string> = {0: 'red', 1: 'blue', 2: 'auto'}
const MODE_NAMES: Record<number, string> = {0: 'deathmatch', 1: 'ctf', 2: 'teamplay'}
const PROTO_NAMES: Record<number, string> = {0: 'ipx', 1: 'tcp/ip'}
const RENDERER_NAMES: Record<number, string> = {0: '3dfx', 1: 'direct3d', 2: 'software'}
const LANGUAGE_NAMES: Record<number, string> = {
  1: 'english',
  2: 'spanish',
  3: 'italian',
  4: 'french',
  5: 'german',
}
const LEVEL3_NAMES: Record<number, string> = {0: 'low/none', 128: 'medium', 255: 'max'}

/** Resolve an enum flag value: a bare number is used as-is, else matched by alias. */
export function parseChoice(value: string, aliases: Record<string, number>, field: string): number {
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10)
  const resolved = aliases[trimmed.toLowerCase()]
  if (resolved === undefined) {
    throw new Error(
      `${field}: expected one of ${Object.keys(aliases).join(', ')} (or a number), got "${value}"`,
    )
  }
  return resolved
}

/** Parse an on/off boolean flag. */
export function parseBool(value: string, field: string): boolean {
  const v = value.trim().toLowerCase()
  if (v === 'on' || v === 'true' || v === '1' || v === 'yes') return true
  if (v === 'off' || v === 'false' || v === '0' || v === 'no') return false
  throw new Error(`${field}: expected on/off, got "${value}"`)
}

/** Render `name (n)` for a numeric enum field, or just `n` if unknown. */
function labelled(value: number, names: Record<number, string>): string {
  const name = names[value]
  return name === undefined ? String(value) : `${name} (${value})`
}

/** Render menuinfo settings for display. */
export function formatMenuInfoText(info: MenuInfo): string {
  const slot =
    info.saveSlot === 0xffff
      ? 'none'
      : info.saveSlot === 0xfffe
        ? 'temp.dat'
        : `sg${info.saveSlot}.dat`
  const {width, height, depth} = info.resolution
  return [
    `Player name:  ${info.playerName}`,
    `Host name:    ${info.hostName}`,
    `Team:         ${labelled(info.team, TEAM_NAMES)}`,
    `Game mode:    ${labelled(info.gameMode, MODE_NAMES)}`,
    `Network:      ${labelled(info.networkProtocol, PROTO_NAMES)}`,
    `Last server:  ${info.serverIp}`,
    `Max players:  ${info.maxPlayers}`,
    `Last level:   ${info.lastLevel}${info.multiplayer ? ' (multiplayer)' : ' (single-player)'}`,
    `Save slot:    ${slot}`,
    `Renderer:     ${labelled(info.renderer, RENDERER_NAMES)}`,
    `Resolution:   ${width}x${height}x${depth}`,
    `Detail:       ${labelled(info.detail, LEVEL3_NAMES)}`,
    `Graphic FX:   ${labelled(info.graphicFx, LEVEL3_NAMES)}`,
    `Sound:        ${info.soundVolume}/255`,
    `Music:        ${info.musicVolume}/255`,
    `Channels:     ${info.soundChannels}`,
    `Language:     ${labelled(info.language, LANGUAGE_NAMES)}`,
    `Subtitles:    ${info.subtitles ? 'on' : 'off'}`,
    '',
  ].join('\n')
}

/**
 * Run the `menuinfo` CLI command.
 *
 * @param argv - Arguments following the `menuinfo` command.
 */
export async function runMenuInfo(argv: string[]): Promise<void> {
  const {values, positionals} = parseArgs({
    args: argv,
    options: {
      name: {type: 'string'},
      host: {type: 'string'},
      'server-ip': {type: 'string'},
      netproto: {type: 'string'},
      team: {type: 'string'},
      mode: {type: 'string'},
      maxplayers: {type: 'string'},
      renderer: {type: 'string'},
      width: {type: 'string'},
      height: {type: 'string'},
      depth: {type: 'string'},
      detail: {type: 'string'},
      gfx: {type: 'string'},
      sound: {type: 'string'},
      music: {type: 'string'},
      channels: {type: 'string'},
      language: {type: 'string'},
      subtitles: {type: 'string'},
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
  const data = await readFile(input)
  const writing = WRITE_OPTIONS.some((key) => values[key] !== undefined)

  if (!writing) {
    process.stdout.write(formatMenuInfoText(parseMenuInfo(data)))
    return
  }

  const patch: MenuInfoPatch = {}
  if (values.name !== undefined) {
    patch.playerName = values.name
    if (values.name.length > 10) {
      process.stderr.write(
        `Warning: player name "${values.name}" is ${values.name.length} chars; the host truncates it to 10 online.\n`,
      )
    }
  }
  if (values.host !== undefined) patch.hostName = values.host
  if (values['server-ip'] !== undefined) patch.serverIp = values['server-ip']
  if (values.netproto !== undefined)
    patch.networkProtocol = parseChoice(values.netproto, PROTO_ALIASES, 'netproto')
  if (values.team !== undefined) patch.team = parseChoice(values.team, TEAM_ALIASES, 'team')
  if (values.mode !== undefined) patch.gameMode = parseChoice(values.mode, MODE_ALIASES, 'mode')
  if (values.maxplayers !== undefined) patch.maxPlayers = Number.parseInt(values.maxplayers, 10)
  if (values.renderer !== undefined)
    patch.renderer = parseChoice(values.renderer, RENDERER_ALIASES, 'renderer')
  if (values.detail !== undefined)
    patch.detail = parseChoice(values.detail, LEVEL3_ALIASES, 'detail')
  if (values.gfx !== undefined) patch.graphicFx = parseChoice(values.gfx, LEVEL3_ALIASES, 'gfx')
  if (values.sound !== undefined) patch.soundVolume = Number.parseInt(values.sound, 10)
  if (values.music !== undefined) patch.musicVolume = Number.parseInt(values.music, 10)
  if (values.channels !== undefined) patch.soundChannels = Number.parseInt(values.channels, 10)
  if (values.language !== undefined)
    patch.language = parseChoice(values.language, LANGUAGE_ALIASES, 'language')
  if (values.subtitles !== undefined) patch.subtitles = parseBool(values.subtitles, 'subtitles')

  const resolution: {width?: number; height?: number; depth?: number} = {}
  if (values.width !== undefined) resolution.width = Number.parseInt(values.width, 10)
  if (values.height !== undefined) resolution.height = Number.parseInt(values.height, 10)
  if (values.depth !== undefined) resolution.depth = Number.parseInt(values.depth, 10)
  if (Object.keys(resolution).length > 0) patch.resolution = resolution

  const output = values.output ?? input
  await writeFile(output, formatMenuInfo(data, patch))
  process.stderr.write(`Wrote ${output}\n`)
}
