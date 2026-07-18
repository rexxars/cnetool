import {describe, expect, test} from 'vitest'

import {formatStatTableText} from '../src/cli/stattable.ts'
import type {ConfigEntry} from '../src/index.ts'

const RECORDS: ConfigEntry[][] = [
  [
    {key: 'Name', value: 'tank'},
    {key: 'Armor', value: 'Heavy'},
    {key: 'Health', value: '250'},
  ],
  [
    {key: 'Name', value: 'airplane'},
    {key: 'Armor', value: 'Light'},
    {key: 'Health', value: '75'},
  ],
]

describe('formatStatTableText', () => {
  test('renders a header, a separator, and one row per record', () => {
    const lines = formatStatTableText(RECORDS).trimEnd().split('\n')
    expect(lines).toHaveLength(4) // header + separator + 2 records
    expect(lines[0]).toMatch(/Name\s+Armor\s+Health/)
    expect(lines[1]).toMatch(/^-+\s+-+\s+-+$/)
    expect(lines[2]).toMatch(/tank\s+Heavy\s+250/)
  })

  test('unions columns across records in first-seen order, blank when missing', () => {
    const records: ConfigEntry[][] = [
      [
        {key: 'Name', value: 'a'},
        {key: 'Health', value: '1'},
      ],
      [
        {key: 'Name', value: 'b'},
        {key: 'Firedelay', value: '2'},
      ],
    ]
    const lines = formatStatTableText(records).trimEnd().split('\n')
    expect(lines[0]).toMatch(/Name.*Health.*Firedelay/)
    // Record "a" has no Firedelay, "b" no Health - both still render as rows.
    expect(lines).toHaveLength(4)
    expect(lines[2]).toMatch(/^a\s+1$/) // trailing blank Firedelay is trimmed
  })
})
