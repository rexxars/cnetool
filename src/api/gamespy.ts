import dgram from 'node:dgram'

import {GAME_PORT, GAMESPY_QUERY_PORT} from './constants.ts'
import type {GamePlayer, GameServer, GameServerStatus} from './types.ts'

const SLASH = '\\'

/**
 * Parse a GameSpy-1 reply datagram (`\key\value\key\value\...`) into a flat
 * key→value map. The stream starts with an empty leading token; framing keys
 * like `final` and `queryid` fall out into the map harmlessly. Values never
 * contain a backslash, so splitting on `\` is unambiguous. First value for a
 * repeated key wins.
 *
 * @param datagram - One reply packet's bytes.
 */
export function parseQueryPacket(datagram: Uint8Array): Record<string, string> {
  const text = new TextDecoder('latin1').decode(datagram)
  const parts = text.split(SLASH)
  const result: Record<string, string> = {}
  // Skip the empty leading token; keys are at odd indices, values follow.
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const key = parts[i]!
    if (key !== '' && !(key in result)) {
      result[key] = parts[i + 1]!
    }
  }
  return result
}

/**
 * Reassembles a multi-packet GameSpy reply for one or more concurrent queries.
 *
 * CE tags every reply packet with `\queryid\<id>.<segment>`; the packet that
 * carries `\final\` has a `<segment>` equal to the total packet count for that
 * `<id>`. Packets can arrive out of order (UDP), so completion is detected by
 * counting packets per id until the count reaches that total - never by
 * sequence. Fields from all of an id's packets are merged (first value wins).
 *
 * @param expectedQueries - How many distinct query ids must complete before the
 *   whole response is considered done.
 */
export function createReassembler(expectedQueries: number): {
  /** Feed a received datagram. Returns `true` once all queries have completed. */
  push: (datagram: Uint8Array) => boolean
  /** The merged fields collected so far, across every query id. */
  fields: () => Record<string, string>
} {
  const queries = new Map<
    string,
    {total: number; received: number; fields: Record<string, string>}
  >()
  let completed = 0

  function push(datagram: Uint8Array): boolean {
    const {queryid, ...content} = parseQueryPacket(datagram)
    if (!queryid) {
      return completed >= expectedQueries
    }

    const [id, segment] = queryid.split('.', 2)
    const query = queries.get(id!) ?? {total: Number.POSITIVE_INFINITY, received: 0, fields: {}}
    if (!queries.has(id!)) {
      queries.set(id!, query)
    }

    if ('final' in content) {
      query.total = Number.parseInt(segment ?? '1', 10)
    }
    query.received++
    query.fields = {...content, ...query.fields}

    if (query.received === query.total) {
      completed++
    }
    return completed >= expectedQueries
  }

  function fields(): Record<string, string> {
    let merged: Record<string, string> = {}
    for (const query of queries.values()) {
      merged = {...query.fields, ...merged}
    }
    return merged
  }

  return {push, fields}
}

// Player rows arrive as `<field>_<index>` keys, either in the dedicated
// `\players\` reply or bundled into `\status\` (1.43), so we harvest them from
// the fully merged field set regardless of which reply carried them.
const PLAYER_INDEX = /^player_(\d+)$/

/** Map merged reply fields to the connected-player roster. */
export function parsePlayers(fields: Record<string, string>): GamePlayer[] {
  const indices: number[] = []
  for (const key of Object.keys(fields)) {
    const match = PLAYER_INDEX.exec(key)
    if (match) {
      indices.push(Number.parseInt(match[1]!, 10))
    }
  }
  indices.sort((a, b) => a - b)
  return indices.map((n) => ({
    nickname: fields[`player_${n}`] ?? '',
    frags: toInt(fields[`frags_${n}`]),
    deaths: toInt(fields[`deaths_${n}`]),
    skill: toInt(fields[`skill_${n}`]),
    ping: toInt(fields[`ping_${n}`]),
    team: fields[`team_${n}`] ?? '',
  }))
}

/**
 * Assemble a {@link GameServerStatus} from merged GameSpy reply fields. Throws
 * if the reply lacks a `hostname` (ie it was not a real status reply).
 *
 * @param fields - Merged `\status\` (+ optional `\players\`) fields.
 * @param ip - The address that was queried.
 * @param queryPort - The query port that answered.
 * @param ping - Measured round-trip in ms, if timed.
 */
export function parseServerStatus(
  fields: Record<string, string>,
  ip: string,
  queryPort: number,
  ping?: number,
): GameServerStatus {
  if (!('hostname' in fields)) {
    throw new Error(`No status reply (missing \`hostname\`) from ${ip}:${queryPort}`)
  }
  return {
    ip,
    queryPort,
    gamePort: fields.hostport ? toInt(fields.hostport) : GAME_PORT,
    name: fields.hostname ?? '',
    version: (fields.gamever ?? '').replace(/^cneagle/, ''),
    map: fields.mapname ?? '',
    gameType: (fields.gametype ?? '') as GameServerStatus['gameType'],
    numPlayers: toInt(fields.numplayers),
    maxPlayers: toInt(fields.maxplayers),
    timeLimit: toInt(fields.timelimit),
    fragLimit: toInt(fields.fraglimit),
    scoreLimit: toInt(fields.scorelimit),
    teamplay: fields.teamplay === '1',
    ...(ping === undefined ? {} : {ping}),
    source: 'internet',
  }
}

/** Options for {@link queryServer}. */
export interface QueryServerOptions {
  /**
   * Whether to also fetch the player roster with a `\players\` query. When
   * `false`, only `\status\` is sent and no `players` field is returned.
   * Defaults to `true`.
   */
  includePlayers?: boolean
  /** Overall query timeout in milliseconds (default `5000`). */
  timeout?: number
  /** Abort signal to cancel the query. */
  signal?: AbortSignal
}

/**
 * Query a Codename Eagle server's status over its GameSpy query port (UDP).
 *
 * Sends `\status\` (and, unless `includePlayers` is `false`, `\players\`),
 * reassembles the multi-packet reply (see {@link createReassembler}), and
 * returns the parsed status. The returned `ping` is the measured round-trip to
 * the first reply packet.
 *
 * @param ip - Server IPv4 address.
 * @param port - Query port (default {@link GAMESPY_QUERY_PORT}).
 */
export function queryServer(ip: string, port?: number): Promise<GameServer>
export function queryServer(
  ip: string,
  port: number | undefined,
  options: QueryServerOptions & {includePlayers: false},
): Promise<GameServerStatus>
export function queryServer(
  ip: string,
  port: number | undefined,
  options: QueryServerOptions & {includePlayers?: true},
): Promise<GameServer>
export function queryServer(
  ip: string,
  port: number = GAMESPY_QUERY_PORT,
  options: QueryServerOptions = {},
): Promise<GameServer | GameServerStatus> {
  const includePlayers = options.includePlayers !== false
  const timeout = options.timeout ?? 5000
  const expectedQueries = includePlayers ? 2 : 1
  const reassembler = createReassembler(expectedQueries)

  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4')
    let start = 0
    let ping: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      socket.close()
    }
    const fail = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onAbort = () => fail(new Error(`Query to ${ip}:${port} aborted`))

    if (options.signal?.aborted) {
      onAbort()
      return
    }
    options.signal?.addEventListener('abort', onAbort, {once: true})

    timer = setTimeout(() => fail(new Error(`Timeout querying ${ip}:${port}`)), timeout)

    socket.on('error', fail)

    socket.on('message', (message) => {
      if (message[0] !== 0x5c /* '\' */) {
        return
      }
      if (ping === undefined) {
        ping = Math.round(performance.now() - start)
      }
      if (reassembler.push(message)) {
        cleanup()
        const fields = reassembler.fields()
        try {
          const status = parseServerStatus(fields, ip, port, ping)
          resolve(includePlayers ? {...status, players: parsePlayers(fields)} : status)
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      }
    })

    socket.connect(port, ip, () => {
      start = performance.now()
      socket.send(Buffer.from('\\status\\'))
      if (includePlayers) {
        socket.send(Buffer.from('\\players\\'))
      }
    })
  })
}

function toInt(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isNaN(parsed) ? 0 : parsed
}
