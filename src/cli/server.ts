// @env node
import {parseArgs} from 'node:util'

import {fetchIpList, findServers, queryServer} from '../api/index.ts'
import {GAMESPY_QUERY_PORT} from '../api/constants.ts'
import type {GamePlayer, GameServer, GameServerStatus} from '../api/index.ts'

const usage = `Usage: cnetool server <subcommand> [options]

Discover and query Codename Eagle multiplayer servers.

Subcommands:
  list                 List servers from the community master list, merged with
                       LAN servers discovered via beacon (see --no-lan).
  query <ip[:port]>    Query one server's status (and players) over GameSpy.

Run "cnetool server <subcommand> --help" for subcommand-specific options.
`

const listUsage = `Usage: cnetool server list [options]

Fetch the community master server list (${'https://ceservers.net/iplist.txt'}) and,
by default, also scan the LAN for beaconing hosts, then query each for its live
status. The list is community-run and best-effort: only servers patched to
announce to ceservers.net (or running 1.50+) appear in it.

Options:
  --no-lan             Skip the LAN beacon scan (internet servers only).
  --url <url>          Master list URL to fetch (default the community list).
  --lan-timeout <ms>   LAN beacon listen window (default 1500).
  --timeout <ms>       Per-server query timeout (default 5000).
  --raw                Print the raw address list only (no querying, fast).
  --json               Emit the parsed servers as JSON.
  -h, --help           Show this help.
`

const queryUsage = `Usage: cnetool server query <ip[:port]> [options]

Query a single server's status over its GameSpy query port (default ${GAMESPY_QUERY_PORT}).

Options:
  --no-players         Fetch status only, skip the player roster.
  --timeout <ms>       Query timeout (default 5000).
  --json               Emit the parsed server as JSON.
  -h, --help           Show this help.
`

/**
 * Run the `server` CLI command: dispatches to the `list` / `query` subcommands.
 *
 * @param argv - Arguments following the `server` command.
 */
export async function runServer(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv
  switch (subcommand) {
    case 'list':
      await runList(rest)
      return
    case 'query':
      await runQuery(rest)
      return
    case undefined:
    case '-h':
    case '--help':
      process.stdout.write(usage)
      if (subcommand === undefined) process.exitCode = 1
      return
    default:
      process.stderr.write(`Unknown server subcommand: ${subcommand}\n\n${usage}`)
      process.exitCode = 1
  }
}

async function runList(argv: string[]): Promise<void> {
  const {values} = parseArgs({
    args: argv,
    options: {
      'no-lan': {type: 'boolean'},
      url: {type: 'string'},
      'lan-timeout': {type: 'string'},
      timeout: {type: 'string'},
      raw: {type: 'boolean'},
      json: {type: 'boolean'},
      help: {type: 'boolean', short: 'h'},
    },
    allowPositionals: false,
  })

  if (values.help) {
    process.stdout.write(listUsage)
    return
  }

  if (values.raw) {
    const addresses = await fetchIpList(values.url)
    process.stdout.write(addresses.length ? `${addresses.join('\n')}\n` : '')
    return
  }

  const servers = await findServers({
    lan: !values['no-lan'],
    url: values.url,
    lanTimeout: intOption(values['lan-timeout']),
    queryTimeout: intOption(values.timeout),
  })
  // LAN first, then by ping (unpinged last), then name.
  servers.sort(
    (a, b) =>
      Number(b.source === 'lan') - Number(a.source === 'lan') ||
      (a.ping ?? Infinity) - (b.ping ?? Infinity) ||
      a.name.localeCompare(b.name),
  )

  if (values.json) {
    process.stdout.write(`${JSON.stringify(servers, null, 2)}\n`)
    return
  }

  process.stdout.write(formatServerTable(servers))
}

async function runQuery(argv: string[]): Promise<void> {
  const {values, positionals} = parseArgs({
    args: argv,
    options: {
      'no-players': {type: 'boolean'},
      timeout: {type: 'string'},
      json: {type: 'boolean'},
      help: {type: 'boolean', short: 'h'},
    },
    allowPositionals: true,
  })

  if (values.help || positionals.length === 0) {
    process.stdout.write(queryUsage)
    if (positionals.length === 0 && !values.help) process.exitCode = 1
    return
  }

  const {ip, port} = parseAddress(positionals[0]!)
  const timeout = intOption(values.timeout)

  if (values['no-players']) {
    const status = await queryServer(ip, port, {includePlayers: false, timeout})
    process.stdout.write(values.json ? `${json(status)}\n` : formatStatus(status))
    return
  }

  const server = await queryServer(ip, port, {timeout})
  process.stdout.write(values.json ? `${json(server)}\n` : formatStatus(server))
}

/** Parse an `ip` or `ip:port` argument; defaults to the GameSpy query port. */
export function parseAddress(value: string): {ip: string; port: number} {
  const trimmed = value.trim()
  const colon = trimmed.lastIndexOf(':')
  if (colon === -1) {
    return {ip: trimmed, port: GAMESPY_QUERY_PORT}
  }
  const port = Number.parseInt(trimmed.slice(colon + 1), 10)
  if (Number.isNaN(port)) {
    throw new Error(`Invalid port in address "${value}"`)
  }
  return {ip: trimmed.slice(0, colon), port}
}

function intOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed)) {
    throw new Error(`Expected a number, got "${value}"`)
  }
  return parsed
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

/** Render the merged server list as an aligned table. */
export function formatServerTable(servers: GameServerStatus[]): string {
  if (servers.length === 0) {
    return 'No servers found.\n'
  }
  const rows = servers.map((server) => [
    server.source === 'lan' ? 'LAN' : 'NET',
    server.ping === undefined ? '-' : `${server.ping}ms`,
    `${server.numPlayers}/${server.maxPlayers}`,
    server.map || '-',
    server.name || '(unnamed)',
    `${server.ip}:${server.queryPort}`,
  ])
  const header = ['SRC', 'PING', 'PLAYERS', 'MAP', 'NAME', 'ADDRESS']
  const widths = header.map((label, column) =>
    Math.max(label.length, ...rows.map((row) => row[column]!.length)),
  )
  const line = (cells: string[]) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column]!))
      .join('  ')
      .trimEnd()
  return `${[header, ...rows].map(line).join('\n')}\n`
}

/** Render a single server's status (and player table, if present) for display. */
export function formatStatus(server: GameServerStatus | GameServer): string {
  const lines = [
    `Name:      ${server.name || '(unnamed)'}`,
    `Address:   ${server.ip}:${server.queryPort} (game port ${server.gamePort})`,
    `Version:   ${server.version ? `cneagle ${server.version}` : 'unknown'}`,
    `Map:       ${server.map || '-'}`,
    `Game type: ${server.gameType || '-'}${server.teamplay ? ' (teamplay)' : ''}`,
    `Players:   ${server.numPlayers}/${server.maxPlayers}`,
    `Limits:    frag ${limit(server.fragLimit)}, score ${limit(server.scoreLimit)}, time ${
      server.timeLimit === 0 ? 'off' : `${server.timeLimit} min`
    }`,
    ...(server.ping === undefined ? [] : [`Ping:      ${server.ping}ms`]),
  ]

  if ('players' in server && server.players.length > 0) {
    lines.push('', formatPlayerTable(server.players))
  }
  return `${lines.join('\n')}\n`
}

function limit(value: number): string {
  return value === 0 ? 'off' : String(value)
}

function formatPlayerTable(players: GamePlayer[]): string {
  const header = ['PLAYER', 'TEAM', 'FRAGS', 'DEATHS', 'PING']
  const rows = players.map((player) => [
    player.nickname || '(unnamed)',
    player.team || '-',
    String(player.frags),
    String(player.deaths),
    String(player.ping),
  ])
  const widths = header.map((label, column) =>
    Math.max(label.length, ...rows.map((row) => row[column]!.length)),
  )
  const line = (cells: string[]) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column]!))
      .join('  ')
      .trimEnd()
  return [header, ...rows].map(line).join('\n')
}
