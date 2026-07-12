import {
  BLOB_DEPTH_OFFSET,
  BLOB_DESCRIPTOR_OFFSET,
  BLOB_HEADER_LENGTH,
  BLOB_HEIGHT_OFFSET,
  BLOB_WIDTH_OFFSET,
  SUPPORTED_DEPTHS,
  TGA_EXTENSION,
  TGA_HEADER_PREFIX,
} from './constants.ts'
import type {ArchiveEntry, TextureInfo} from './types.ts'

/**
 * Inspect an entry and return its image geometry if (and only if) it is a
 * supported texture: a `.tga` name whose blob is a partial-header TGA of the
 * exact size implied by its dimensions and depth.
 *
 * @returns The texture geometry, or `null` if the entry is not a texture this
 *   library can rebuild.
 */
export function getTextureInfo(data: Uint8Array, entry: ArchiveEntry): TextureInfo | null {
  if (!entry.name.toLowerCase().endsWith(TGA_EXTENSION)) return null
  if (entry.blobLength < BLOB_HEADER_LENGTH) return null
  if (entry.dataOffset + BLOB_HEADER_LENGTH > data.byteLength) return null

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const width = view.getUint16(entry.dataOffset + BLOB_WIDTH_OFFSET, true)
  const height = view.getUint16(entry.dataOffset + BLOB_HEIGHT_OFFSET, true)
  const depth = view.getUint8(entry.dataOffset + BLOB_DEPTH_OFFSET)
  const descriptor = view.getUint8(entry.dataOffset + BLOB_DESCRIPTOR_OFFSET)

  if (!SUPPORTED_DEPTHS.includes(depth)) return null
  if (entry.blobLength !== BLOB_HEADER_LENGTH + width * height * (depth / 8)) return null

  return {width, height, depth, descriptor}
}

/**
 * Rebuild a standalone TGA file for a texture entry.
 *
 * The stored blob is a TGA missing its constant first 8 header bytes, so we
 * prepend {@link TGA_HEADER_PREFIX} to produce a valid file.
 *
 * @throws If the entry is not a supported texture (see {@link getTextureInfo}).
 */
export function extractTexture(data: Uint8Array, entry: ArchiveEntry): Uint8Array {
  if (!getTextureInfo(data, entry)) {
    throw new Error(`Entry ${entry.name} is not a supported texture`)
  }

  const blob = data.subarray(entry.dataOffset, entry.dataOffset + entry.blobLength)
  const tga = new Uint8Array(TGA_HEADER_PREFIX.length + blob.length)
  tga.set(TGA_HEADER_PREFIX, 0)
  tga.set(blob, TGA_HEADER_PREFIX.length)
  return tga
}
