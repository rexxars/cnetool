import {describe, expect, test} from 'vitest'

import {formatServerTable, formatStatus, parseAddress} from '../src/cli/server.ts'
import type {GameServer, GameServerStatus} from '../src/index.ts'

const base: GameServerStatus = {
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
}

describe('parseAddress', () => {
  test('defaults to the GameSpy query port when no port is given', () => {
    expect(parseAddress('89.38.98.12')).toEqual({ip: '89.38.98.12', port: 4711})
  })

  test('parses an explicit ip:port', () => {
    expect(parseAddress('89.38.98.12:24711')).toEqual({ip: '89.38.98.12', port: 24711})
  })

  test('throws on a non-numeric port', () => {
    expect(() => parseAddress('89.38.98.12:abc')).toThrow(/Invalid port/)
  })
})

describe('formatServerTable', () => {
  test('renders a header + aligned rows, LAN and internet', () => {
    const lan: GameServerStatus = {
      ...base,
      ip: '192.168.1.5',
      name: 'LOCALDEV',
      map: '',
      ping: undefined,
      source: 'lan',
    }
    const table = formatServerTable([lan, base])
    const lines = table.trimEnd().split('\n')
    expect(lines[0]).toMatch(/^SRC\s+PING\s+PLAYERS\s+MAP\s+NAME\s+ADDRESS$/)
    expect(lines[1]).toContain('LAN')
    expect(lines[1]).toContain('192.168.1.5:4711')
    expect(lines[1]).toContain('-') // blank map + unpinged shown as '-'
    expect(lines[2]).toContain('NET')
    expect(lines[2]).toContain('42ms')
  })

  test('reports when the list is empty', () => {
    expect(formatServerTable([])).toBe('No servers found.\n')
  })
})

describe('formatStatus', () => {
  test('renders a player table when players are present', () => {
    const server: GameServer = {
      ...base,
      players: [{nickname: 'Rexxie', frags: 7, deaths: 2, skill: 0, ping: 34, team: 'red'}],
    }
    const text = formatStatus(server)
    expect(text).toContain('Name:      CE Nation')
    expect(text).toContain('Game type: ctf (teamplay)')
    expect(text).toMatch(/PLAYER\s+TEAM\s+FRAGS\s+DEATHS\s+PING/)
    expect(text).toContain('Rexxie')
  })

  test('omits the player table for a status-only result', () => {
    const text = formatStatus(base)
    expect(text).not.toContain('PLAYER')
    expect(text).toContain('Ping:      42ms')
  })
})
