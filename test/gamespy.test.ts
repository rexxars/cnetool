import dgram from 'node:dgram'
import {afterEach, describe, expect, test} from 'vitest'

import {
  createReassembler,
  parsePlayers,
  parseQueryPacket,
  parseServerStatus,
  queryServer,
} from '../src/index.ts'

const servers: dgram.Socket[] = []

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((socket) => new Promise<void>((resolve) => socket.close(() => resolve()))),
  )
})

/**
 * Start a fake GameSpy responder on 127.0.0.1 that replies to `\status\` /
 * `\players\` with the given canned packets. Returns the bound port.
 */
function startFakeServer(replies: {status: string[]; players?: string[]}): Promise<number> {
  const socket = dgram.createSocket('udp4')
  servers.push(socket)
  socket.on('message', (message, remote) => {
    const request = message.toString('latin1')
    const packets = request.includes('players') ? (replies.players ?? []) : replies.status
    for (const packet of packets) {
      socket.send(Buffer.from(packet, 'latin1'), remote.port, remote.address)
    }
  })
  return new Promise((resolve) => {
    socket.bind(0, '127.0.0.1', () => resolve(socket.address().port))
  })
}

describe('parseQueryPacket', () => {
  test('parses backslash-delimited key/value pairs', () => {
    expect(
      parseQueryPacket(Buffer.from('\\hostname\\CE Nation\\hostport\\24711\\final\\')),
    ).toEqual({hostname: 'CE Nation', hostport: '24711', final: ''})
  })

  test('keeps the first value when a key repeats', () => {
    expect(parseQueryPacket(Buffer.from('\\mapname\\A\\mapname\\B'))).toEqual({mapname: 'A'})
  })
})

describe('createReassembler', () => {
  test('counts packets per query id until the final segment total, tolerating reorder', () => {
    const reassembler = createReassembler(2)

    // Status query id 13, one packet.
    expect(reassembler.push(Buffer.from('\\hostname\\CE Nation\\final\\\\queryid\\13.1'))).toBe(
      false,
    )
    // Players query id 14, two packets arriving out of order (final first).
    expect(reassembler.push(Buffer.from('\\player_1\\Bob\\final\\\\queryid\\14.2'))).toBe(false)
    expect(reassembler.push(Buffer.from('\\player_0\\Alice\\queryid\\14.1'))).toBe(true)

    const fields = reassembler.fields()
    expect(fields.hostname).toBe('CE Nation')
    expect(fields.player_0).toBe('Alice')
    expect(fields.player_1).toBe('Bob')
  })
})

describe('parsePlayers', () => {
  test('maps player_N rows sorted by index', () => {
    const players = parsePlayers({
      player_1: 'Bob',
      frags_1: '3',
      team_1: 'blue',
      player_0: 'Alice',
      frags_0: '5',
      deaths_0: '2',
      ping_0: '40',
      team_0: 'red',
    })
    expect(players).toEqual([
      {nickname: 'Alice', frags: 5, deaths: 2, skill: 0, ping: 40, team: 'red'},
      {nickname: 'Bob', frags: 3, deaths: 0, skill: 0, ping: 0, team: 'blue'},
    ])
  })

  test('returns an empty roster when there are no players', () => {
    expect(parsePlayers({hostname: 'x'})).toEqual([])
  })
})

describe('parseServerStatus', () => {
  test('maps status fields and strips the cneagle version prefix', () => {
    const status = parseServerStatus(
      {
        gamever: 'cneagle1.43',
        hostname: 'CE Nation',
        hostport: '24711',
        mapname: 'No mans land',
        gametype: 'ctf',
        numplayers: '1',
        maxplayers: '8',
        timelimit: '0',
        fraglimit: '0',
        scorelimit: '0',
        teamplay: '1',
      },
      '89.38.98.12',
      4711,
      42,
    )
    expect(status).toEqual({
      ip: '89.38.98.12',
      queryPort: 4711,
      gamePort: 24711,
      name: 'CE Nation',
      version: '1.43',
      map: 'No mans land',
      gameType: 'ctf',
      numPlayers: 1,
      maxPlayers: 8,
      timeLimit: 0,
      fragLimit: 0,
      scoreLimit: 0,
      teamplay: true,
      ping: 42,
      source: 'internet',
    })
  })

  test('throws when the reply has no hostname', () => {
    expect(() => parseServerStatus({gamename: 'cneagle'}, '1.2.3.4', 4711)).toThrow(/hostname/)
  })
})

describe('queryServer', () => {
  test('resolves status and players from a live socket', async () => {
    const port = await startFakeServer({
      status: ['\\hostname\\CE Nation\\hostport\\24711\\mapname\\NML\\final\\\\queryid\\1.1'],
      players: ['\\player_0\\Alice\\frags_0\\5\\team_0\\red\\final\\\\queryid\\2.1'],
    })

    const server = await queryServer('127.0.0.1', port, {timeout: 2000})
    expect(server.name).toBe('CE Nation')
    expect(server.map).toBe('NML')
    expect(server.gamePort).toBe(24711)
    expect(typeof server.ping).toBe('number')
    expect(server.players).toEqual([
      {nickname: 'Alice', frags: 5, deaths: 0, skill: 0, ping: 0, team: 'red'},
    ])
  })

  test('with includePlayers:false sends only status and omits players', async () => {
    const port = await startFakeServer({
      status: ['\\hostname\\CE Nation\\hostport\\24711\\final\\\\queryid\\1.1'],
      players: ['\\this-should-not-be-requested\\1\\final\\\\queryid\\2.1'],
    })

    const status = await queryServer('127.0.0.1', port, {includePlayers: false, timeout: 2000})
    expect(status.name).toBe('CE Nation')
    expect('players' in status).toBe(false)
  })

  test('rejects on timeout when the server never replies', async () => {
    // A server that receives the query but sends nothing back must time out
    // (rather than hang) - a dead port would instead ICMP-refuse the datagram.
    const port = await startFakeServer({status: []})
    await expect(queryServer('127.0.0.1', port, {timeout: 150})).rejects.toThrow(/Timeout/)
  })
})
