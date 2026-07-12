import type {ArchiveEntry} from './types.ts'

/**
 * Return an entry's raw stored blob as an independent copy, without
 * interpreting its contents.
 */
export function extractFile(data: Uint8Array, entry: ArchiveEntry): Uint8Array {
  return data.slice(entry.dataOffset, entry.dataOffset + entry.blobLength)
}
