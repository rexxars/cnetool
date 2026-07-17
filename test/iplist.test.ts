import {describe, expect, test} from 'vitest'

import {parseIpList} from '../src/index.ts'

describe('parseIpList', () => {
  test('returns one address per non-comment line', () => {
    expect(parseIpList('89.38.98.12\n192.168.1.50\n')).toEqual(['89.38.98.12', '192.168.1.50'])
  })

  test('strips # comment lines and blank lines', () => {
    const text =
      '# List of TCP/IP-servers for CodeName:Eagle\n\n89.38.98.12\n\n# another\n10.0.0.5\n'
    expect(parseIpList(text)).toEqual(['89.38.98.12', '10.0.0.5'])
  })

  test('trims surrounding whitespace and handles CRLF', () => {
    expect(parseIpList('  89.38.98.12  \r\n10.0.0.5\r\n')).toEqual(['89.38.98.12', '10.0.0.5'])
  })

  test('deduplicates while preserving first-seen order', () => {
    expect(parseIpList('89.38.98.12\n10.0.0.5\n89.38.98.12\n')).toEqual(['89.38.98.12', '10.0.0.5'])
  })

  test('returns an empty list for an empty or comment-only file', () => {
    expect(parseIpList('')).toEqual([])
    expect(parseIpList('# only comments\n#\n')).toEqual([])
  })
})
