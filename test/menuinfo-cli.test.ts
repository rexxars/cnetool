import {describe, expect, test} from 'vitest'

import {formatMenuInfoText, parseBool, parseChoice} from '../src/cli/menuinfo.ts'
import type {MenuInfo} from '../src/index.ts'

const INFO: MenuInfo = {
  lastLevel: 128,
  multiplayer: true,
  maxPlayers: 16,
  networkProtocol: 1,
  serverIp: '62.212.89.142',
  hostName: 'MyServer',
  playerName: 'Rexxie',
  gameMode: 1,
  saveSlot: 2,
  team: 1,
  soundVolume: 190,
  musicVolume: 51,
  soundChannels: 16,
  detail: 255,
  graphicFx: 128,
  renderer: 1,
  resolution: {width: 1400, height: 1050, depth: 32},
  language: 3,
  subtitles: true,
}

const TEAM_ALIASES = {red: 0, blue: 1, auto: 2}

describe('parseChoice', () => {
  test('matches an alias case-insensitively', () => {
    expect(parseChoice('BLUE', TEAM_ALIASES, 'team')).toBe(1)
  })

  test('passes a bare number through', () => {
    expect(parseChoice('2', TEAM_ALIASES, 'team')).toBe(2)
  })

  test('throws a listing the valid choices for an unknown value', () => {
    expect(() => parseChoice('green', TEAM_ALIASES, 'team')).toThrow(/red, blue, auto/)
  })
})

describe('parseBool', () => {
  test('accepts on/off and their synonyms', () => {
    expect(parseBool('on', 'subtitles')).toBe(true)
    expect(parseBool('OFF', 'subtitles')).toBe(false)
    expect(parseBool('1', 'subtitles')).toBe(true)
  })

  test('throws on anything else', () => {
    expect(() => parseBool('maybe', 'subtitles')).toThrow(/on\/off/)
  })
})

describe('formatMenuInfoText', () => {
  test('labels enum fields with both name and number', () => {
    const text = formatMenuInfoText(INFO)
    expect(text).toMatch(/Team:\s*blue \(1\)/)
    expect(text).toMatch(/Game mode:\s*ctf \(1\)/)
    expect(text).toMatch(/Renderer:\s*direct3d \(1\)/)
    expect(text).toMatch(/Language:\s*italian \(3\)/)
  })

  test('renders resolution, volumes and the multiplayer marker', () => {
    const text = formatMenuInfoText(INFO)
    expect(text).toMatch(/Resolution:\s*1400x1050x32/)
    expect(text).toMatch(/Sound:\s*190\/255/)
    expect(text).toMatch(/Last level:\s*128 \(multiplayer\)/)
  })

  test('renders the save slot as a filename, and its sentinels', () => {
    expect(formatMenuInfoText(INFO)).toMatch(/Save slot:\s*sg2\.dat/)
    expect(formatMenuInfoText({...INFO, saveSlot: 0xffff})).toMatch(/Save slot:\s*none/)
    expect(formatMenuInfoText({...INFO, saveSlot: 0xfffe})).toMatch(/Save slot:\s*temp\.dat/)
  })
})
