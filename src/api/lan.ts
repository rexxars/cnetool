import dgram from 'node:dgram'

import {
  GAME_PORT,
  GAMESPY_QUERY_PORT,
  LAN_BEACON_MAXPLAYERS_OFFSET,
  LAN_BEACON_NAME_OFFSET,
  LAN_BEACON_PLAYERS_OFFSET,
  LAN_BEACON_PORT,
  LAN_BEACON_TYPE,
} from './constants.ts'
import {fetchIpList} from './iplist.ts'
import {queryServer} from './gamespy.ts'
import type {GameServerStatus, LanBeacon, LanServer} from './types.ts'

/**
 * Parse a Codename Eagle LAN beacon - the 24-byte `'D'` datagram a host
 * broadcasts to UDP `:210` about once a second.
 *
 * Layout (see `docs/network.md` §3): byte 0 is `0x44` (`'D'`), byte 12 is
 * `numPlayers + 1`, byte 13 is `maxPlayers + 1`, and the server name is
 * NUL-terminated from byte 14 (falling back to the packet end if unterminated).
 * The beacon carries no IP - callers supply the datagram's source address.
 *
 * @param datagram - The received beacon bytes.
 * @returns The parsed beacon, or `null` if it is not a `'D'` beacon.
 */
export function parseBeacon(datagram: Uint8Array): LanBeacon | null {
  if (datagram.length < LAN_BEACON_NAME_OFFSET || datagram[0] !== LAN_BEACON_TYPE) {
    return null
  }
  const numPlayers = Math.max(0, datagram[LAN_BEACON_PLAYERS_OFFSET]! - 1)
  const maxPlayers = Math.max(0, datagram[LAN_BEACON_MAXPLAYERS_OFFSET]! - 1)
  const tail = datagram.subarray(LAN_BEACON_NAME_OFFSET)
  let end = tail.indexOf(0)
  if (end === -1) {
    end = tail.length
  }
  // CE uses a single-byte codepage; latin1 keeps every byte round-trippable.
  const name = new TextDecoder('latin1').decode(tail.subarray(0, end)).trim()
  return {name, numPlayers, maxPlayers}
}

/** Options for {@link discoverLanServers}. */
export interface DiscoverLanOptions {
  /** How long to listen for beacons, in milliseconds (default `1500`). */
  timeout?: number
  /**
   * UDP port to bind and listen on. Defaults to {@link LAN_BEACON_PORT} (210),
   * the port CE hosts broadcast to - note binding it is privileged on Unix.
   * Override only to listen behind a relay/forwarder (or in tests).
   */
  port?: number
  /** Abort signal to stop listening early. */
  signal?: AbortSignal
}

/**
 * Listen for CE LAN beacons and return the hosts that announced themselves.
 *
 * Binds UDP port {@link LAN_BEACON_PORT} and collects `'D'` beacons for the
 * listen window, deduplicating by source IP. LAN discovery is push-based: the
 * host broadcasts, we only listen - no probe is sent.
 *
 * @param options - Optional {@link DiscoverLanOptions}.
 * @returns Distinct `{ip, beacon}` entries, in first-seen order.
 */
export function discoverLanServers(options: DiscoverLanOptions = {}): Promise<LanServer[]> {
  const timeout = options.timeout ?? 1500
  return new Promise((resolve, reject) => {
    const found = new Map<string, LanServer>()
    const socket = dgram.createSocket({type: 'udp4', reuseAddr: true})
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = () => {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', finish)
      socket.close()
      resolve([...found.values()])
    }

    if (options.signal?.aborted) {
      resolve([])
      return
    }
    options.signal?.addEventListener('abort', finish, {once: true})

    socket.on('error', (error) => {
      if (timer) clearTimeout(timer)
      socket.close()
      reject(error)
    })

    socket.on('message', (message, remote) => {
      if (found.has(remote.address)) {
        return
      }
      const beacon = parseBeacon(message)
      if (beacon) {
        found.set(remote.address, {ip: remote.address, beacon})
      }
    })

    socket.bind(options.port ?? LAN_BEACON_PORT, () => {
      timer = setTimeout(finish, timeout)
    })
  })
}

/** Options for {@link findServers}. */
export interface FindServersOptions {
  /** Include LAN beacon discovery (default `true`). */
  lan?: boolean
  /** Master list URL to fetch; defaults to the community list (see {@link fetchIpList}). */
  url?: string
  /** LAN listen window in milliseconds (default `1500`). */
  lanTimeout?: number
  /** Per-server query timeout in milliseconds (default `5000`). */
  queryTimeout?: number
  /** Abort signal to cancel discovery. */
  signal?: AbortSignal
}

/**
 * Discover Codename Eagle servers and resolve each to a status row.
 *
 * Fetches the community master list and (unless `lan` is `false`) scans the LAN
 * for beacons, merges and deduplicates the two, then queries each host's
 * GameSpy `\status\` concurrently. Mirrors the in-game server browser:
 *
 * - Internet hosts appear only if they answer `\status\`.
 * - LAN hosts that beacon but don't answer still get a row built from the
 *   beacon (name + player counts, blank map).
 * - Fetching the list is best-effort: a network failure yields no internet
 *   rows rather than rejecting, so LAN servers still surface.
 *
 * Player rosters are not fetched (counts only); use {@link queryServer} on a
 * single address for the full player list.
 *
 * @param options - Optional {@link FindServersOptions}.
 * @returns The resolved servers, LAN entries first.
 */
export async function findServers(options: FindServersOptions = {}): Promise<GameServerStatus[]> {
  const includeLan = options.lan !== false
  const queryTimeout = options.queryTimeout ?? 5000

  const [lanServers, internetIps] = await Promise.all([
    includeLan
      ? discoverLanServers({timeout: options.lanTimeout, signal: options.signal})
      : Promise.resolve<LanServer[]>([]),
    fetchIpList(options.url, {signal: options.signal}).catch(() => [] as string[]),
  ])

  const lanByIp = new Map(lanServers.map((server) => [server.ip, server.beacon]))

  const lanResults = lanServers.map(({ip, beacon}) =>
    queryServer(ip, GAMESPY_QUERY_PORT, {includePlayers: false, timeout: queryTimeout})
      .then((status) => ({...status, source: 'lan' as const}))
      .catch(() => beaconToStatus(ip, beacon)),
  )

  const internetResults = internetIps
    .filter((ip) => !lanByIp.has(ip))
    .map((ip) =>
      queryServer(ip, GAMESPY_QUERY_PORT, {includePlayers: false, timeout: queryTimeout}).catch(
        () => null,
      ),
    )

  const settled = await Promise.all([...lanResults, ...internetResults])
  return settled.filter((server): server is GameServerStatus => server !== null)
}

/** Build a status row from a LAN beacon when the host doesn't answer `\status\`. */
function beaconToStatus(ip: string, beacon: LanBeacon): GameServerStatus {
  return {
    ip,
    queryPort: GAMESPY_QUERY_PORT,
    gamePort: GAME_PORT,
    name: beacon.name,
    version: '',
    map: '',
    gameType: '',
    numPlayers: beacon.numPlayers,
    maxPlayers: beacon.maxPlayers,
    timeLimit: 0,
    fragLimit: 0,
    scoreLimit: 0,
    teamplay: false,
    source: 'lan',
  }
}
