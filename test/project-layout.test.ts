import {describe, expect, test} from 'vitest'
import {isEngineGenerated, slugify, STAT_TABLES, TEXTURE_ARCHIVES} from '../src/project/layout.ts'

describe('slugify', () => {
  test('lowercases and hyphenates level names', () => {
    expect(slugify('No mans land')).toBe('no-mans-land')
    expect(slugify("Doom's Day Device")).toBe('dooms-day-device')
    expect(slugify('  The  Assasin ')).toBe('the-assasin')
  })
})

describe('isEngineGenerated', () => {
  test('matches engine-dropped cache files case-insensitively', () => {
    for (const name of [
      'wcache.bin',
      'SCACHE.BIN',
      'diacache.dat',
      'hiscores.dat',
      'error.log',
      'somelevelcache.bin',
    ]) {
      expect(isEngineGenerated(name)).toBe(true)
    }
  })
  test('does not match build products', () => {
    for (const name of ['data1.bin', 'textures.dat', 'world.dat', 'cache.json']) {
      expect(isEngineGenerated(name)).toBe(false)
    }
  })
})

describe('domain tables', () => {
  test('stat tables map binaries to friendly names', () => {
    expect(STAT_TABLES).toEqual([
      {file: 'data3.bin', source: 'units.json'},
      {file: 'data4.bin', source: 'weapons.json'},
      {file: 'mdata3.bin', source: 'units-mp.json'},
      {file: 'mdata4.bin', source: 'weapons-mp.json'},
    ])
  })
  test('texture archives carry install path and source dir', () => {
    expect(TEXTURE_ARCHIVES).toEqual([
      {installPath: '24bits/textures.dat', sourceDir: 'textures.dat'},
      {installPath: '24bits/texsec.dat', sourceDir: 'texsec.dat'},
      {installPath: 'menu/menupics.dat', sourceDir: 'menupics.dat'},
    ])
  })
})
