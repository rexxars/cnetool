import {describe, expect, test} from 'vitest'

import {formatConfig, groupRecords, parseConfig} from '../src/index.ts'

describe('parseConfig', () => {
  test('parses Key:Value lines, trimming whitespace and CR', () => {
    const text = 'Fire:DIK_SPACE MOUSE_LBUTTON\r\nUseItem:DIK_RETURN\r\n'
    expect(parseConfig(text)).toEqual([
      {key: 'Fire', value: 'DIK_SPACE MOUSE_LBUTTON'},
      {key: 'UseItem', value: 'DIK_RETURN'},
    ])
  })

  test('only splits on the first colon', () => {
    expect(parseConfig('Translation: 59.09,-1421.66,-2200.79')).toEqual([
      {key: 'Translation', value: '59.09,-1421.66,-2200.79'},
    ])
  })

  test('skips blank lines, comments and lines without a colon', () => {
    const text = '//Eng:----\n\nName:plane2.1\nbarewordwithnocolon\n'
    expect(parseConfig(text)).toEqual([{key: 'Name', value: 'plane2.1'}])
  })

  test('preserves order and duplicate keys', () => {
    const text = 'Name:a\nType:enemyplane\nName:b\nType:transport\n'
    expect(parseConfig(text).map((entry) => entry.key)).toEqual(['Name', 'Type', 'Name', 'Type'])
  })

  test('accepts raw bytes', () => {
    const bytes = new TextEncoder().encode('Dist:1500\r\n')
    expect(parseConfig(bytes)).toEqual([{key: 'Dist', value: '1500'}])
  })
})

describe('formatConfig', () => {
  test('emits CRLF-terminated Key:Value lines', () => {
    expect(
      formatConfig([
        {key: 'Name', value: 'truck.1'},
        {key: 'Type', value: 'transport'},
      ]),
    ).toBe('Name:truck.1\r\nType:transport\r\n')
  })

  test('round-trips through parseConfig (a MOBJS.DAT-style manifest)', () => {
    const entries = parseConfig('Name:plane2.1\nType:enemyplane\nName:truck.1\nType:transport\n')
    expect(parseConfig(formatConfig(entries))).toEqual(entries)
  })

  test('returns an empty string for no entries', () => {
    expect(formatConfig([])).toBe('')
  })
})

describe('groupRecords', () => {
  test('splits entries into records at each start key', () => {
    const entries = parseConfig('Name:plane2.1\nType:enemyplane\nName:truck.1\nType:transport\n')
    expect(groupRecords(entries, 'Name')).toEqual([
      [
        {key: 'Name', value: 'plane2.1'},
        {key: 'Type', value: 'enemyplane'},
      ],
      [
        {key: 'Name', value: 'truck.1'},
        {key: 'Type', value: 'transport'},
      ],
    ])
  })

  test('matches the start key case-insensitively and drops leading entries', () => {
    const entries = parseConfig('Languages:5\nName:a\nType:x\n')
    expect(groupRecords(entries, 'name')).toEqual([
      [
        {key: 'Name', value: 'a'},
        {key: 'Type', value: 'x'},
      ],
    ])
  })
})
