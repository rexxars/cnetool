import {unzlibSync, zlibSync} from 'fflate'

import type {RawImage, RgbColor} from './types.ts'

const TGA_HEADER_LENGTH = 18
const UNCOMPRESSED_TRUE_COLOR = 2
const TOP_ORIGIN_BIT = 0x20 // descriptor bit 5: 1 = top-left origin, 0 = bottom-left

/**
 * Decode an uncompressed true-color TGA (image type 2, 24- or 32-bit) into
 * top-down RGB(A) pixels. This covers the textures `cnetool` extracts and the
 * game's own `.tga` files. Converts the stored BGR(A) to RGB(A) and flips
 * bottom-origin images so the result is always top-down.
 *
 * @param tga - Raw TGA file bytes.
 */
export function decodeTga(tga: Uint8Array): RawImage {
  const view = new DataView(tga.buffer, tga.byteOffset, tga.byteLength)
  const idLength = view.getUint8(0)
  const colorMapType = view.getUint8(1)
  const imageType = view.getUint8(2)
  const width = view.getUint16(12, true)
  const height = view.getUint16(14, true)
  const depth = view.getUint8(16)
  const descriptor = view.getUint8(17)

  if (imageType !== UNCOMPRESSED_TRUE_COLOR) {
    throw new Error(`Unsupported TGA image type ${imageType} (only uncompressed true-color)`)
  }
  if (depth !== 24 && depth !== 32) {
    throw new Error(`Unsupported TGA pixel depth ${depth} (expected 24 or 32)`)
  }

  const channels = depth / 8
  let offset = TGA_HEADER_LENGTH + idLength
  if (colorMapType === 1) {
    offset += Math.ceil((view.getUint16(5, true) * view.getUint8(7)) / 8)
  }

  const topDown = (descriptor & TOP_ORIGIN_BIT) !== 0
  const stride = width * channels
  const data = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    let src = offset + (topDown ? y : height - 1 - y) * stride
    let dst = y * stride
    for (let x = 0; x < width; x++) {
      const b = tga[src++]!
      const g = tga[src++]!
      const r = tga[src++]!
      data[dst++] = r
      data[dst++] = g
      data[dst++] = b
      if (channels === 4) data[dst++] = tga[src++]!
    }
  }

  return {width, height, channels, data}
}

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/**
 * Encode raw RGB(A) pixels (as from {@link decodeTga}) into a PNG file. Uses
 * color type 2 (RGB) for 3 channels, 6 (RGBA) for 4 - lossless, matching the
 * source TGA's features.
 */
export function encodePng(image: RawImage): Uint8Array {
  const {width, height, channels, data} = image

  const ihdr = new Uint8Array(13)
  const ihdrView = new DataView(ihdr.buffer)
  ihdrView.setUint32(0, width)
  ihdrView.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = channels === 4 ? 6 : 2 // color type: RGBA / RGB
  // bytes 10..12 (compression, filter, interlace) stay 0

  // One "none" filter byte (0) per scanline, then the row.
  const stride = width * channels
  const filtered = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    filtered.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  const idat = zlibSync(filtered)

  const parts = [
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const png = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    png.set(part, offset)
    offset += part.length
  }
  return png
}

/**
 * Return an RGBA copy where black texels become fully transparent - CE's 24-bit
 * texture color-key. If no pixel matches, the image is returned unchanged (so opaque
 * textures stay RGB rather than gaining a useless all-opaque alpha channel).
 *
 * Matching is at **RGB565 resolution** (`R<8, G<4, B<8`): CE loads textures into 16-bit
 * 565 surfaces before keying, so a texel is keyed when it *quantizes* to black, not only
 * on exact `0,0,0` - near-black antialiased edges go transparent in-game too.
 */
function blackKeyToAlpha(image: RawImage): RawImage {
  const {width, height, channels, data} = image
  const out = new Uint8Array(width * height * 4)
  let matchedAny = false
  for (let p = 0, i = 0; p < width * height; p++, i += channels) {
    const r = data[i]!,
      g = data[i + 1]!,
      b = data[i + 2]!
    const black = r < 8 && g < 4 && b < 8
    if (black) matchedAny = true
    out[p * 4] = r
    out[p * 4 + 1] = g
    out[p * 4 + 2] = b
    out[p * 4 + 3] = black ? 0 : channels === 4 ? data[i + 3]! : 255
  }
  return matchedAny ? {width, height, channels: 4, data: out} : image
}

/** Options for {@link tgaToPng}. */
export interface TgaToPngOptions {
  /**
   * Map CE's 24-bit black color-key to transparent alpha (outputs RGBA). Off by default:
   * a texture has no inherent transparency - the engine keys black only on **draws** that
   * enable it (a mesh face's `0x02` flag), so the model exporters pass this per keyed face
   * while plain texture dumps leave it off. 32-bit textures keep their own alpha regardless
   * (the key only applies to alpha-less 24-bit images).
   */
  colorKey?: boolean
  /**
   * Treat the pixel rows as stored top-down regardless of the descriptor's origin bit.
   * CE's archive texture blobs (`textures.dat`, `texsec.dat`, `leveltex.bin`,
   * `menupics.dat`) store their rows top-down while their descriptor claims a
   * bottom-left origin - the engine reads rows verbatim and never consults the
   * descriptor - so an honest decode would flip them upside-down. Loose on-disk
   * `.tga` files (`Cutfont.tga`, the `SG_SG*` thumbnails) have truthful descriptors
   * and don't need this.
   */
  topOrigin?: boolean
}

/**
 * Decode an uncompressed true-color TGA and re-encode it as PNG. By default a 32-bit TGA
 * keeps its alpha (RGBA PNG) and a 24-bit TGA stays opaque RGB. With `{colorKey}`, a
 * 24-bit texture's black is mapped to transparent alpha (32-bit images are unaffected -
 * they already carry alpha); this reproduces CE's in-game color-key for a face that
 * enables it. With `{topOrigin}`, the descriptor's origin bit is ignored and rows are
 * taken as already top-down (see {@link TgaToPngOptions}).
 */
export function tgaToPng(tga: Uint8Array, options: TgaToPngOptions = {}): Uint8Array {
  let source = tga
  if (options.topOrigin && (tga[17]! & TOP_ORIGIN_BIT) === 0) {
    source = Uint8Array.from(tga)
    source[17] = source[17]! | TOP_ORIGIN_BIT
  }
  const image = decodeTga(source)
  return encodePng(options.colorKey && image.channels === 3 ? blackKeyToAlpha(image) : image)
}

/**
 * Average a decoded image down to a single representative {@link RgbColor} (the mean of
 * every pixel's RGB). Used to give a terrain face a flat color for the tab-map render, where
 * a texture (grass, rock, water) collapses to one recognizable tint. Alpha is ignored.
 *
 * @param image - The decoded image to average.
 */
export function averageColor(image: RawImage): RgbColor {
  const {width, height, channels, data} = image
  const pixels = width * height
  if (pixels === 0) return {r: 0, g: 0, b: 0}
  let r = 0
  let g = 0
  let b = 0
  for (let i = 0; i < pixels; i++) {
    const p = i * channels
    r += data[p]!
    g += data[p + 1]!
    b += data[p + 2]!
  }
  return {r: Math.round(r / pixels), g: Math.round(g / pixels), b: Math.round(b / pixels)}
}

const pow2 = (v: number): boolean => v > 0 && (v & (v - 1)) === 0

/**
 * Check an image against CE's texture rules - square, power-of-two dimensions, and
 * 24- or 32-bit (3/4 channels). Returns a list of human-readable violations (empty if
 * the image is CE-compatible).
 */
export function validateCeTexture(image: RawImage): string[] {
  const {width, height, channels} = image
  const issues: string[] = []
  if (width !== height) issues.push(`not square (${width}×${height})`)
  if (!pow2(width) || !pow2(height)) issues.push(`dimensions not power-of-two (${width}×${height})`)
  if (channels !== 3 && channels !== 4)
    issues.push(`unsupported channel count ${channels} (need 24- or 32-bit)`)
  return issues
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/**
 * Decode an 8-bit RGB (color type 2) or RGBA (color type 6) PNG into top-down
 * RGB(A) pixels. Reverses all five PNG scanline filters. Other PNG variants
 * (paletted, grayscale, 16-bit, interlaced) are not supported.
 *
 * @param png - Raw PNG file bytes.
 */
export function decodePng(png: Uint8Array): RawImage {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat: Uint8Array[] = []

  for (let p = 8; p + 8 <= png.byteLength; ) {
    const length = view.getUint32(p)
    const type = String.fromCharCode(png[p + 4]!, png[p + 5]!, png[p + 6]!, png[p + 7]!)
    const data = png.subarray(p + 8, p + 8 + length)
    if (type === 'IHDR') {
      const ihdr = new DataView(data.buffer, data.byteOffset)
      width = ihdr.getUint32(0)
      height = ihdr.getUint32(4)
      bitDepth = data[8]!
      colorType = data[9]!
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    p += 12 + length
  }

  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(
      `Unsupported PNG (bit depth ${bitDepth}, color type ${colorType}); want 8-bit RGB/RGBA`,
    )
  }

  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  const raw = unzlibSync(concat(idat))
  const data = new Uint8Array(height * stride)

  let src = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[src++]!
    const rowStart = y * stride
    const prevStart = rowStart - stride
    for (let i = 0; i < stride; i++) {
      const x = raw[src++]!
      const a = i >= channels ? data[rowStart + i - channels]! : 0
      const b = y > 0 ? data[prevStart + i]! : 0
      const c = y > 0 && i >= channels ? data[prevStart + i - channels]! : 0
      let value: number
      switch (filter) {
        case 0:
          value = x
          break
        case 1:
          value = x + a
          break
        case 2:
          value = x + b
          break
        case 3:
          value = x + ((a + b) >> 1)
          break
        case 4:
          value = x + paeth(a, b, c)
          break
        default:
          throw new Error(`Unsupported PNG filter ${filter}`)
      }
      data[rowStart + i] = value & 0xff
    }
  }

  return {width, height, channels, data}
}

/**
 * Encode top-down RGB(A) pixels into an uncompressed true-color TGA, matching
 * the game's convention (BGR(A), bottom-left origin). Round-trips with
 * {@link decodeTga}.
 */
export function encodeTga(image: RawImage): Uint8Array {
  const {width, height, channels, data} = image
  const out = new Uint8Array(TGA_HEADER_LENGTH + width * height * channels)
  const view = new DataView(out.buffer)
  out[2] = UNCOMPRESSED_TRUE_COLOR
  view.setUint16(12, width, true)
  view.setUint16(14, height, true)
  out[16] = channels * 8
  out[17] = channels === 4 ? 0x08 : 0x00 // alpha-channel bits; bottom-left origin

  const stride = width * channels
  let dst = TGA_HEADER_LENGTH
  for (let row = 0; row < height; row++) {
    let src = (height - 1 - row) * stride // bottom-origin: first stored row is the bottom
    for (let x = 0; x < width; x++) {
      const r = data[src++]!
      const g = data[src++]!
      const b = data[src++]!
      out[dst++] = b
      out[dst++] = g
      out[dst++] = r
      if (channels === 4) out[dst++] = data[src++]!
    }
  }
  return out
}

/** Options for {@link pngToTga}. */
export interface PngToTgaOptions {
  /**
   * Store the pixel rows top-down (the descriptor still claims bottom-left origin) -
   * the layout CE's archive texture blobs use, since the engine reads rows verbatim
   * and never consults the descriptor. Required when injecting a texture into an
   * archive (`buildTextureArchive`); an honest bottom-origin TGA renders upside-down
   * in-game. The inverse of {@link TgaToPngOptions.topOrigin} on the extract side.
   */
  topDown?: boolean

  /**
   * Validate the image against CE's texture rules (square, power-of-two,
   * 24/32-bit) and throw if it can't load in-game. Defaults to `true` - the
   * safety check for authoring. Set `false` when re-encoding an asset that
   * already shipped in an archive (a faithful round-trip must reproduce whatever
   * the original contained, including legitimately non-square menu/HUD textures),
   * where the check would reject valid existing data.
   */
  validate?: boolean
}

// Flip a raw image vertically (returns a copy; used to pre-compensate encodeTga's
// bottom-origin row order so the file ends up storing rows top-down).
function flipRows(image: RawImage): RawImage {
  const {width, height, channels, data} = image
  const out = new Uint8Array(data.length)
  const stride = width * channels
  for (let row = 0; row < height; row++) {
    out.set(data.subarray(row * stride, (row + 1) * stride), (height - 1 - row) * stride)
  }
  return {width, height, channels, data: out}
}

/**
 * Decode a PNG and re-encode it as a game-ready CE texture (TGA). An RGB PNG becomes a
 * 24-bit TGA; an RGBA PNG becomes a 32-bit TGA with its alpha preserved - this is how
 * you author a transparent texture (CE renders 32-bit alpha directly). By default the
 * result is validated against CE's texture rules (square, power-of-two, 24/32-bit) and
 * rejected if it can't load in-game; pass `{validate: false}` to skip that (see
 * {@link PngToTgaOptions.validate} - used by the round-trip build path).
 */
export function pngToTga(png: Uint8Array, options: PngToTgaOptions = {}): Uint8Array {
  const image = decodePng(png)
  if (options.validate !== false) {
    const issues = validateCeTexture(image)
    if (issues.length > 0) throw new Error(`Texture is not CE-compatible: ${issues.join('; ')}`)
  }
  // encodeTga writes rows bottom-up (honest bottom-origin); flipping first makes the
  // file store them top-down, which is what the engine reads from archive blobs.
  return encodeTga(options.topDown ? flipRows(image) : image)
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}
