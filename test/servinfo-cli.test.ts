import {describe, expect, test} from 'vitest'

import {resolveNextMap, formatServerInfoText} from '../src/cli/servinfo.ts'

const INDEX = [
  {name: 'No mans land', number: 128},
  {name: 'Breakpoint', number: 129},
]

describe('resolveNextMap', () => {
  test('passes a numeric value through unchanged', () => {
    expect(resolveNextMap('129', INDEX)).toBe(129)
  })

  test('treats "off" (any case) as 0 = rotation disabled', () => {
    expect(resolveNextMap('off', INDEX)).toBe(0)
    expect(resolveNextMap('OFF', INDEX)).toBe(0)
  })

  test('resolves a map name to its number, case-insensitively, via the index', () => {
    expect(resolveNextMap('breakpoint', INDEX)).toBe(129)
  })

  test('throws a clear error for an unknown map name', () => {
    expect(() => resolveNextMap('Nonexistent', INDEX)).toThrow(/no level named "Nonexistent"/)
  })
})

describe('formatServerInfoText', () => {
  test('shows each field with minutes and the resolved nextmap number', () => {
    const text = formatServerInfoText({fragLimit: 10, scoreLimit: 0, timeLimit: 30, nextMap: 129})
    expect(text).toMatch(/frag limit:\s*10/i)
    expect(text).toMatch(/time limit:\s*30 min/i)
    expect(text).toMatch(/next map:\s*129/i)
  })

  test('renders disabled fields (0) as off/none rather than a bare 0', () => {
    const text = formatServerInfoText({fragLimit: 0, scoreLimit: 0, timeLimit: 0, nextMap: 0})
    expect(text).toMatch(/next map:\s*off/i)
    expect(text).not.toMatch(/next map:\s*0\b/i)
  })
})
