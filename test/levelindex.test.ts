import {describe, expect, test} from 'vitest'

import {formatLevelIndex, parseLevelIndex} from '../src/index.ts'

describe('parseLevelIndex', () => {
  test('parses Name/Val lines into {name, number}, keeping spaces in names', () => {
    const text = 'Name:The village fool Val:1\r\nName:No mans land Val:128\r\n'
    expect(parseLevelIndex(text)).toEqual([
      {name: 'The village fool', number: 1},
      {name: 'No mans land', number: 128},
    ])
  })

  test('preserves file order, including out-of-order and gapped numbers', () => {
    const text =
      'Name:The airbase Val:132\r\nName:Fever valley Val:248\r\nName:Fortress Val:133\r\n'
    expect(parseLevelIndex(text).map((entry) => entry.number)).toEqual([132, 248, 133])
  })

  test('accepts raw bytes and skips blank or malformed lines', () => {
    const bytes = new TextEncoder().encode('Name:Breakpoint Val:129\r\n\r\ngarbage line\r\n')
    expect(parseLevelIndex(bytes)).toEqual([{name: 'Breakpoint', number: 129}])
  })
})

describe('formatLevelIndex', () => {
  test('emits CRLF-terminated Name/Val lines', () => {
    expect(
      formatLevelIndex([
        {name: 'No mans land', number: 128},
        {name: 'Breakpoint', number: 129},
      ]),
    ).toBe('Name:No mans land Val:128\r\nName:Breakpoint Val:129\r\n')
  })

  test('round-trips through parseLevelIndex', () => {
    const index = [
      {name: 'No mans land', number: 128},
      {name: 'The palace', number: 130},
    ]
    expect(parseLevelIndex(formatLevelIndex(index))).toEqual(index)
  })
})
