import dgram from 'node:dgram'
import {afterEach, describe, expect, test} from 'vitest'

import {discoverLanServers, parseBeacon} from '../src/index.ts'

const senders: dgram.Socket[] = []

afterEach(async () => {
  await Promise.all(
    senders
      .splice(0)
      .map((socket) => new Promise<void>((resolve) => socket.close(() => resolve()))),
  )
})

describe('parseBeacon', () => {
  // Real beacon captured off the LAN: "CodenameEagle.net US West" (25 chars),
  // 0/8 players. The 25-char name separates offset 7 (name_len+7 = 32) from
  // offset 13 (maxplayers+1 = 9), which a 9-char name would leave ambiguous.
  test('parses a real in-game host beacon with a long name', () => {
    const buf = Uint8Array.from([
      0x44, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x20, 0x87, 0x60, 0xff, 0x01, 0x01, 0x09, 0x43,
      0x6f, 0x64, 0x65, 0x6e, 0x61, 0x6d, 0x65, 0x45, 0x61, 0x67, 0x6c, 0x65, 0x2e, 0x6e, 0x65,
      0x74, 0x20, 0x55, 0x53, 0x20, 0x57, 0x65, 0x73, 0x74, 0x00,
    ])
    expect(parseBeacon(buf)).toEqual({
      name: 'CodenameEagle.net US West',
      numPlayers: 0,
      maxPlayers: 8,
    })
  })

  // "LOCALDEV" with byte[13]=16 -> maxplayers 15. Reading byte[13] as the name
  // length would run past the packet end and drop this beacon.
  test('parses a short name with a large max-player count', () => {
    const buf = Uint8Array.from([
      0x44, 0x00, 0x00, 0x00, 0x00, 0x07, 0x00, 0x0f, 0x87, 0x60, 0xff, 0x01, 0x01, 0x10, 0x4c,
      0x4f, 0x43, 0x41, 0x4c, 0x44, 0x45, 0x56, 0x00,
    ])
    expect(parseBeacon(buf)).toEqual({name: 'LOCALDEV', numPlayers: 0, maxPlayers: 15})
  })

  test('falls back to the packet end when the name is not NUL-terminated', () => {
    const buf = Uint8Array.from([
      0x44, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x0b, 0x87, 0x60, 0xff, 0x01, 0x03, 0x05, 0x41,
      0x42, 0x43, 0x44,
    ])
    expect(parseBeacon(buf)).toEqual({name: 'ABCD', numPlayers: 2, maxPlayers: 4})
  })

  test('rejects non-beacon and too-short datagrams', () => {
    expect(parseBeacon(Uint8Array.from([0x03, 0, 0, 0]))).toBeNull()
    expect(parseBeacon(new Uint8Array(0))).toBeNull()
  })
})

describe('discoverLanServers', () => {
  test('collects beacons by source address, deduplicating', async () => {
    const port = 24399
    const listen = discoverLanServers({timeout: 400, port})
    await new Promise((resolve) => setTimeout(resolve, 50))

    const sender = dgram.createSocket('udp4')
    senders.push(sender)
    const beacon = Uint8Array.from([
      0x44, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x0d, 0x87, 0x60, 0xff, 0x01, 0x02, 0x09, 0x54,
      0x65, 0x73, 0x74, 0x00,
    ])
    sender.send(beacon, port, '127.0.0.1')
    sender.send(beacon, port, '127.0.0.1') // duplicate from same source -> one entry

    const found = await listen
    expect(found).toHaveLength(1)
    expect(found[0]!.ip).toBe('127.0.0.1')
    expect(found[0]!.beacon).toEqual({name: 'Test', numPlayers: 1, maxPlayers: 8})
  })
})
