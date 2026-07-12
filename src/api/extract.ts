import {extractFile} from './file.ts'
import {parseArchive} from './parse.ts'
import {extractTexture, getTextureInfo} from './texture.ts'
import type {ExtractedEntry} from './types.ts'

/**
 * Parse an archive and extract every entry, choosing the best representation
 * per entry: texture entries are rebuilt into standalone TGA files, and all
 * other entries are returned as their raw stored blobs.
 *
 * This is the high-level entry point used by the CLI and works for any archive
 * in this format, regardless of payload.
 *
 * @param data - Raw archive bytes.
 * @returns One {@link ExtractedEntry} per entry, in archive order.
 */
export function extractEntries(data: Uint8Array): ExtractedEntry[] {
  return parseArchive(data).entries.map((entry): ExtractedEntry => {
    if (getTextureInfo(data, entry)) {
      return {name: entry.name, entry, data: extractTexture(data, entry), kind: 'tga'}
    }
    return {name: entry.name, entry, data: extractFile(data, entry), kind: 'raw'}
  })
}
