import {mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, test} from 'vitest'

import {
  buildArchive,
  buildTextureArchive,
  decodeTga,
  encodePng,
  extractTexture,
  parseArchive,
  pngToTga,
} from '../src/index.ts'
import type {RawImage} from '../src/index.ts'
import {
  buildArchiveDirTexture,
  extractArchiveDir,
  readArchiveDirEntries,
} from '../src/project/archive-dir.ts'

let tmpDirs: string[] = []

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cnetool-'))
  tmpDirs.push(dir)
  return dir
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// A small square power-of-two RGB image with a deterministic, position-dependent
// pattern so two of them are distinguishable pixel-for-pixel.
function makeImage(size: number, seed: number): RawImage {
  const data = new Uint8Array(size * size * 3)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3
      data[i] = (x * 16 + seed) & 0xff
      data[i + 1] = (y * 16 + seed * 3) & 0xff
      data[i + 2] = (x * y + seed * 7) & 0xff
    }
  }
  return {width: size, height: size, channels: 3, data}
}

// A non-square, non-power-of-two RGB image (like a real menupics.dat/HUD texture).
function makeRectImage(width: number, height: number, seed: number): RawImage {
  const data = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3
      data[i] = (x * 3 + seed) & 0xff
      data[i + 1] = (y * 5 + seed * 3) & 0xff
      data[i + 2] = (x + y + seed * 7) & 0xff
    }
  }
  return {width, height, channels: 3, data}
}

// A game-faithful archive texture blob: rows stored top-down behind a bottom-origin
// descriptor (the layout the engine reads verbatim), which is exactly `topDown: true`.
function tgaFor(image: RawImage): Uint8Array {
  return pngToTga(encodePng(image), {topDown: true})
}

// Same, but skipping CE validation - for non-square/non-pow2 fixtures that mirror
// real archive contents (the encode path only validates for authoring mistakes).
function tgaForRaw(image: RawImage): Uint8Array {
  return pngToTga(encodePng(image), {topDown: true, validate: false})
}

function pixelsEqual(a: Uint8Array, b: Uint8Array): boolean {
  const ia = decodeTga(a)
  const ib = decodeTga(b)
  if (ia.width !== ib.width || ia.height !== ib.height || ia.channels !== ib.channels) return false
  if (ia.data.length !== ib.data.length) return false
  for (let i = 0; i < ia.data.length; i++) if (ia.data[i] !== ib.data[i]) return false
  return true
}

afterEach(async () => {
  await Promise.all(tmpDirs.map((dir) => rm(dir, {recursive: true, force: true})))
  tmpDirs = []
})

describe('extractArchiveDir / buildArchiveDirTexture', () => {
  test('round-trips a texture archive byte-identically', async () => {
    const img1 = makeImage(16, 1)
    const img2 = makeImage(16, 2)
    const bytes = buildTextureArchive([
      {name: 'A_TEX.tga', data: tgaFor(img1)},
      {name: 'btex.tga', data: tgaFor(img2)},
    ])

    const dir = await tmp()
    await extractArchiveDir(bytes, dir)

    expect(await exists(join(dir, 'a_tex.png'))).toBe(true)
    expect(await exists(join(dir, 'btex.png'))).toBe(true)
    expect(await exists(join(dir, 'entries.json'))).toBe(true)

    const sidecar = JSON.parse(await readFile(join(dir, 'entries.json'), 'utf8'))
    expect(sidecar.$schema).toBe('../../../.cnetool/schemas/entries.schema.json')
    expect(sidecar.entries).toEqual([
      {file: 'a_tex.png', name: 'A_TEX.tga'},
      {file: 'btex.png', name: 'btex.tga'},
    ])

    const rebuilt = await buildArchiveDirTexture(dir)
    expect(rebuilt).toEqual(bytes)
  })

  test('round-trips a NON-square / non-pow2 texture byte-identically', async () => {
    // Real menupics.dat / HUD textures are legitimately non-square. Init extracts
    // them fine; build must re-encode them without the square+pow2 validation
    // throwing (regression: a faithful round-trip of real data used to be impossible).
    const bytes = buildTextureArchive([
      {name: 'HUD.tga', data: tgaForRaw(makeRectImage(80, 144, 1))},
      {name: 'wide.tga', data: tgaForRaw(makeRectImage(100, 12, 2))},
    ])

    const dir = await tmp()
    await extractArchiveDir(bytes, dir)

    const rebuilt = await buildArchiveDirTexture(dir)
    expect(rebuilt).toEqual(bytes)
  })

  test('de-duplicates filename collisions and maps them back to distinct names', async () => {
    const img1 = makeImage(16, 3)
    const img2 = makeImage(16, 4)
    // Names differing only by case sanitize to the same "abc.png" segment.
    const bytes = buildTextureArchive([
      {name: 'ABC.tga', data: tgaFor(img1)},
      {name: 'abc.tga', data: tgaFor(img2)},
    ])

    const dir = await tmp()
    await extractArchiveDir(bytes, dir)

    expect(await exists(join(dir, 'abc.png'))).toBe(true)
    expect(await exists(join(dir, 'abc-2.png'))).toBe(true)

    const sidecar = JSON.parse(await readFile(join(dir, 'entries.json'), 'utf8'))
    expect(sidecar.entries).toEqual([
      {file: 'abc.png', name: 'ABC.tga'},
      {file: 'abc-2.png', name: 'abc.tga'},
    ])

    const rebuilt = await buildArchiveDirTexture(dir)
    const parsed = parseArchive(rebuilt)
    expect(parsed.entries.map((e) => e.name)).toEqual(['ABC.tga', 'abc.tga'])
    // Distinct pixel patterns are preserved per name.
    expect(pixelsEqual(extractTexture(rebuilt, parsed.entries[0]!), tgaFor(img1))).toBe(true)
    expect(pixelsEqual(extractTexture(rebuilt, parsed.entries[1]!), tgaFor(img2))).toBe(true)
  })

  test('appends new user-added PNGs not listed in the sidecar', async () => {
    const bytes = buildTextureArchive([{name: 'A_TEX.tga', data: tgaFor(makeImage(16, 5))}])

    const dir = await tmp()
    await extractArchiveDir(bytes, dir)

    // Author a brand-new texture by dropping a PNG into the dir.
    await writeFile(join(dir, 'newtex.png'), encodePng(makeImage(16, 9)))

    const rebuilt = await buildArchiveDirTexture(dir)
    const names = parseArchive(rebuilt).entries.map((e) => e.name)
    // A .png extra must be named "<stem>.tga" - the only form the engine treats
    // as a texture.
    expect(names).toEqual(['A_TEX.tga', 'newtex.tga'])
  })

  test('throws when an added file collides with a sidecar entry name', async () => {
    // A sidecar entry named "shared.tga" (stored in keep.png) plus a dropped
    // "shared.png" extra, which also computes to entry name "shared.tga".
    const dir = await tmp()
    await writeFile(join(dir, 'keep.png'), encodePng(makeImage(16, 1)))
    await writeFile(join(dir, 'shared.png'), encodePng(makeImage(16, 2)))
    await writeFile(
      join(dir, 'entries.json'),
      JSON.stringify({entries: [{file: 'keep.png', name: 'shared.tga'}]}),
    )
    await expect(readArchiveDirEntries(dir)).rejects.toThrow(/already used/)
  })

  test('throws a friendly error when a listed file is missing on disk', async () => {
    const bytes = buildTextureArchive([{name: 'A_TEX.tga', data: tgaFor(makeImage(16, 5))}])
    const dir = await tmp()
    await extractArchiveDir(bytes, dir)
    await rm(join(dir, 'a_tex.png'))
    await expect(readArchiveDirEntries(dir)).rejects.toThrow(/listed file a_tex\.png missing/)
  })

  test('round-trips raw (non-texture) entries as .bin files', async () => {
    const rawBytes = Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2, 1, 0])
    const archive = buildArchive([{name: 'DATA', data: rawBytes}])

    const dir = await tmp()
    await extractArchiveDir(archive, dir)

    expect(await exists(join(dir, 'data.bin'))).toBe(true)

    const entries = await readArchiveDirEntries(dir)
    expect(entries).toEqual([{name: 'DATA', data: rawBytes}])
  })

  test('reads extras in sorted filename order after sidecar entries', async () => {
    const bytes = buildTextureArchive([{name: 'A_TEX.tga', data: tgaFor(makeImage(16, 1))}])
    const dir = await tmp()
    await extractArchiveDir(bytes, dir)

    await writeFile(join(dir, 'zeta.png'), encodePng(makeImage(16, 2)))
    await writeFile(join(dir, 'alpha.png'), encodePng(makeImage(16, 3)))

    const entries = await readArchiveDirEntries(dir)
    expect(entries.map((e) => e.name)).toEqual(['A_TEX.tga', 'alpha.tga', 'zeta.tga'])
  })

  test('ignores subdirectories when collecting extras', async () => {
    const bytes = buildTextureArchive([{name: 'A_TEX.tga', data: tgaFor(makeImage(16, 1))}])
    const dir = await tmp()
    await extractArchiveDir(bytes, dir)

    const {mkdir} = await import('node:fs/promises')
    await mkdir(join(dir, 'sub'))

    const entries = await readArchiveDirEntries(dir)
    expect(entries.map((e) => e.name)).toEqual(['A_TEX.tga'])
    // sanity: the dir really does contain the subdir
    expect((await readdir(dir)).includes('sub')).toBe(true)
  })
})

async function writeSidecar(dir: string, contents: string): Promise<void> {
  await writeFile(join(dir, 'entries.json'), contents)
}

describe('readArchiveDirEntries sidecar validation', () => {
  test('rejects malformed JSON', async () => {
    const dir = await tmp()
    await writeSidecar(dir, '{not json')
    await expect(readArchiveDirEntries(dir)).rejects.toThrow(/not valid JSON/)
  })

  test('rejects a non-object root', async () => {
    const dir = await tmp()
    await writeSidecar(dir, '42')
    await expect(readArchiveDirEntries(dir)).rejects.toThrow(/expected an object/)
  })

  test('rejects a non-array "entries"', async () => {
    const dir = await tmp()
    await writeSidecar(dir, JSON.stringify({entries: 'nope'}))
    await expect(readArchiveDirEntries(dir)).rejects.toThrow(/"entries" must be an array/)
  })

  test('rejects a malformed record (missing name)', async () => {
    const dir = await tmp()
    await writeSidecar(dir, JSON.stringify({entries: [{file: 'a.png'}]}))
    await expect(readArchiveDirEntries(dir)).rejects.toThrow(/must have string "file" and "name"/)
  })

  test('rejects a path-traversal "file" value', async () => {
    const dir = await tmp()
    await writeSidecar(dir, JSON.stringify({entries: [{file: '../../secret', name: 'X.tga'}]}))
    await expect(readArchiveDirEntries(dir)).rejects.toThrow(/must be a bare filename/)
  })
})
