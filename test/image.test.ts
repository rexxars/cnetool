import {unzlibSync} from 'fflate'
import {describe, expect, test} from 'vitest'

import {
  decodePng,
  decodeTga,
  encodePng,
  encodeTga,
  pngToTga,
  tgaToPng,
  validateCeTexture,
} from '../src/index.ts'

/** Build an uncompressed true-color TGA from top-down RGB(A) rows. */
function buildTga(
  width: number,
  height: number,
  channels: 3 | 4,
  rgba: number[],
  topDown = true,
): Uint8Array {
  const header = new Uint8Array(18)
  const view = new DataView(header.buffer)
  header[2] = 2 // uncompressed true-color
  view.setUint16(12, width, true)
  view.setUint16(14, height, true)
  header[16] = channels * 8
  if (topDown) header[17] = 0x20
  // store as BGR(A), row order per topDown
  const body = new Uint8Array(width * height * channels)
  for (let y = 0; y < height; y++) {
    const srcRow = topDown ? y : height - 1 - y
    for (let x = 0; x < width; x++) {
      const s = (srcRow * width + x) * channels
      const d = (y * width + x) * channels
      body[d] = rgba[s + 2]! // B
      body[d + 1] = rgba[s + 1]! // G
      body[d + 2] = rgba[s]! // R
      if (channels === 4) body[d + 3] = rgba[s + 3]!
    }
  }
  return Uint8Array.from([...header, ...body])
}

describe('decodeTga', () => {
  test('decodes BGR -> RGB for a top-down 24-bit image', () => {
    const tga = buildTga(2, 1, 3, [10, 20, 30, 40, 50, 60], true)
    const img = decodeTga(tga)
    expect(img).toMatchObject({width: 2, height: 1, channels: 3})
    expect(Array.from(img.data)).toEqual([10, 20, 30, 40, 50, 60])
  })

  test('flips a bottom-origin image to top-down', () => {
    const top = decodeTga(buildTga(1, 2, 3, [1, 2, 3, 4, 5, 6], true))
    const bottom = decodeTga(buildTga(1, 2, 3, [1, 2, 3, 4, 5, 6], false))
    expect(Array.from(bottom.data)).toEqual(Array.from(top.data))
  })

  test('keeps the alpha channel for 32-bit', () => {
    const img = decodeTga(buildTga(1, 1, 4, [10, 20, 30, 200], true))
    expect(Array.from(img.data)).toEqual([10, 20, 30, 200])
  })

  test('throws on unsupported (RLE) image types', () => {
    const tga = buildTga(1, 1, 3, [0, 0, 0], true)
    tga[2] = 10 // RLE true-color
    expect(() => decodeTga(tga)).toThrow(/unsupported tga image type/i)
  })
})

describe('encodePng / tgaToPng', () => {
  test('produces a valid PNG whose IDAT round-trips to the pixels', () => {
    const png = tgaToPng(buildTga(2, 2, 3, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], true))

    // signature
    expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    // IHDR: width/height/bitdepth/colortype
    const view = new DataView(png.buffer, png.byteOffset)
    expect(view.getUint32(16)).toBe(2) // width
    expect(view.getUint32(20)).toBe(2) // height
    expect(png[24]).toBe(8) // bit depth
    expect(png[25]).toBe(2) // color type RGB

    // find IDAT and inflate it -> filtered scanlines (each prefixed by a 0 filter byte)
    const idatStart = indexOfChunk(png, 'IDAT')
    const len = view.getUint32(idatStart)
    const idat = png.subarray(idatStart + 8, idatStart + 8 + len)
    const raw = unzlibSync(idat)
    // row 0: filter(0) + R G B R G B (2 pixels); row 1 starts with its own filter byte
    expect(Array.from(raw.subarray(0, 7))).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(Array.from(raw.subarray(7, 14))).toEqual([0, 7, 8, 9, 10, 11, 12])
  })

  test('uses color type 6 for RGBA', () => {
    const png = tgaToPng(buildTga(1, 1, 4, [9, 9, 9, 128], true))
    expect(png[25]).toBe(6) // color type RGBA
  })

  test('{topOrigin} overrides a lying bottom-origin descriptor (CE archive blobs)', () => {
    // CE archive texture blobs store rows top-down while their descriptor claims
    // bottom-left origin. Emulate one: top-down rows, descriptor byte cleared.
    const lying = buildTga(1, 2, 3, [1, 2, 3, 4, 5, 6], true)
    lying[17] = 0

    // honest decode trusts the descriptor and flips the rows
    const honest = decodePng(tgaToPng(lying))
    expect(Array.from(honest.data.subarray(0, 3))).toEqual([4, 5, 6])

    // topOrigin keeps the rows as stored
    const corrected = decodePng(tgaToPng(lying, {topOrigin: true}))
    expect(Array.from(corrected.data.subarray(0, 3))).toEqual([1, 2, 3])
    // a truthful top-origin TGA is unaffected by the option
    const truthful = decodePng(
      tgaToPng(buildTga(1, 2, 3, [1, 2, 3, 4, 5, 6], true), {topOrigin: true}),
    )
    expect(Array.from(truthful.data.subarray(0, 3))).toEqual([1, 2, 3])
  })
})

describe('decodePng / encodeTga / pngToTga', () => {
  test('pngToTga {topDown} stores rows top-down for CE archive injection', () => {
    // 2×2 RGBA PNG (CE textures must be square): red top row, blue bottom row.
    const png = encodePng({
      width: 2,
      height: 2,
      channels: 4,
      // top row red, bottom row blue (RGBA)
      data: Uint8Array.from([255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255]),
    })
    const honest = pngToTga(png)
    // honest TGA: bottom-origin, so the blue (bottom) row is stored first (BGRA)
    expect(Array.from(honest.subarray(18, 22))).toEqual([255, 0, 0, 255])
    const topDown = pngToTga(png, {topDown: true})
    // CE archive layout: rows stored top-down (red first), descriptor unchanged
    expect(Array.from(topDown.subarray(18, 22))).toEqual([0, 0, 255, 255])
    expect(topDown[17]).toBe(0x08)
    // round-trip: engine-order TGA + the extract-side {topOrigin} = the same image
    expect(Array.from(decodePng(tgaToPng(topDown, {topOrigin: true})).data)).toEqual(
      Array.from(decodePng(png).data),
    )
  })

  test('round-trips TGA -> PNG -> TGA pixel-for-pixel (RGB)', () => {
    const rgb = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] // 2×2
    const original = decodeTga(buildTga(2, 2, 3, rgb, true))
    const back = decodeTga(pngToTga(tgaToPng(buildTga(2, 2, 3, rgb, true))))
    expect(back).toEqual(original)
  })

  test('round-trips RGBA as a 32-bit texture with variable alpha preserved', () => {
    const rgba = [10, 20, 30, 200, 40, 50, 60, 100, 70, 80, 90, 50, 110, 120, 130, 255] // 2×2
    const original = decodeTga(buildTga(2, 2, 4, rgba, true))
    const back = decodeTga(pngToTga(tgaToPng(buildTga(2, 2, 4, rgba, true))))
    expect(back).toEqual(original)
    expect(back.channels).toBe(4) // stays 32-bit; CE renders the per-texel alpha
  })

  test('decodePng reverses the Sub filter', () => {
    // a horizontal gradient stresses filters under fflate's compressor
    const width = 16
    const rgb: number[] = []
    for (let x = 0; x < width; x++) rgb.push(x * 8, 255 - x * 8, x * 4)
    const img = decodeTga(buildTga(width, 1, 3, rgb, true))
    const decoded = decodePng(tgaToPng(buildTga(width, 1, 3, rgb, true)))
    expect(Array.from(decoded.data)).toEqual(Array.from(img.data))
  })

  test('encodeTga produces a bottom-origin BGR TGA decodeTga can read back', () => {
    const img = {width: 1, height: 1, channels: 3, data: Uint8Array.from([100, 150, 200])}
    const tga = encodeTga(img)
    expect(tga[2]).toBe(2) // uncompressed true-color
    expect(tga[17]! & 0x20).toBe(0) // bottom-left origin
    expect(Array.from(decodeTga(tga).data)).toEqual([100, 150, 200])
  })
})

const blank = (
  w: number,
  h: number,
  c: 3 | 4,
): {width: number; height: number; channels: 3 | 4; data: Uint8Array} => ({
  width: w,
  height: h,
  channels: c,
  data: new Uint8Array(w * h * c),
})

describe('validateCeTexture', () => {
  test('accepts square power-of-two 24/32-bit images', () => {
    expect(validateCeTexture(blank(64, 64, 3))).toEqual([])
    expect(validateCeTexture(blank(256, 256, 4))).toEqual([])
  })

  test('flags non-square, non-power-of-two, and bad depth', () => {
    expect(validateCeTexture(blank(64, 32, 3))[0]).toMatch(/not square/)
    expect(validateCeTexture(blank(48, 48, 3))[0]).toMatch(/power-of-two/)
    expect(
      validateCeTexture({width: 64, height: 64, channels: 1, data: new Uint8Array(64 * 64)})[0],
    ).toMatch(/channel count/)
  })

  test('pngToTga validates by default - rejects a non-square texture, accepts a valid one', () => {
    const bad = tgaToPng(buildTga(3, 1, 3, [0, 0, 0, 0, 0, 0, 0, 0, 0]))
    expect(() => pngToTga(bad)).toThrow(/not CE-compatible/)
    const ok = tgaToPng(
      buildTga(
        2,
        2,
        3,
        Array.from({length: 12}, () => 0),
      ),
    )
    expect(() => pngToTga(ok)).not.toThrow()
  })

  test('pngToTga {validate: false} accepts a non-square texture (round-trip build path)', () => {
    const bad = tgaToPng(buildTga(3, 1, 3, [0, 0, 0, 0, 0, 0, 0, 0, 0]))
    expect(() => pngToTga(bad)).toThrow(/not CE-compatible/)
    expect(() => pngToTga(bad, {validate: false})).not.toThrow()
    // The bytes are still a real 3×1 TGA (validation was the only thing skipped).
    const decoded = decodeTga(pngToTga(bad, {validate: false}))
    expect([decoded.width, decoded.height]).toEqual([3, 1])
  })
})

function indexOfChunk(png: Uint8Array, type: string): number {
  for (let i = 8; i < png.length - 8; ) {
    const len = new DataView(png.buffer, png.byteOffset + i).getUint32(0)
    const t = String.fromCharCode(png[i + 4]!, png[i + 5]!, png[i + 6]!, png[i + 7]!)
    if (t === type) return i
    i += 12 + len
  }
  throw new Error(`chunk ${type} not found`)
}
