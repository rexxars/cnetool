import {
  ENTRY_COUNT_OFFSET,
  NAME_FIELD_LENGTH,
  RECORD_LENGTH,
  TGA_HEADER_PREFIX,
  TOC_START_OFFSET,
} from './constants.ts'
import type {ArchiveEntry, ParsedArchive} from './types.ts'

const decoder = new TextDecoder('latin1')

/** One entry to write into an archive: its name and its raw blob. */
export interface ArchiveInputEntry {
  name: string
  data: Uint8Array
}

/** Options for {@link buildArchive}. */
export interface BuildArchiveOptions {
  /**
   * `objects.dat` only: the texture-name list (each ≤ 12 chars) written as the `u32 count` +
   * 13-byte NUL-padded records the engine reads between the TOC and the blobs. A face's `texId`
   * indexes this list. Omit for plain archives (`textures.dat`, `menupics.dat`).
   */
  textures?: string[]
}

/** Length of one texture-name record in `objects.dat`'s texture list (NUL-padded). */
const TEXTURE_RECORD_LENGTH = 13

/**
 * Parse the table of contents of a Codename Eagle data archive.
 *
 * The format is a uint32 entry count followed
 * by fixed {@link RECORD_LENGTH}-byte records (a NUL-terminated name field plus
 * a 4-byte absolute data offset), followed by the data blobs. This describes
 * the container only; it does not interpret payloads, so it works for texture
 * archives (`textures.dat`, `menupics.dat`) and others (`objects.dat`) alike.
 *
 * @param data - Raw archive bytes.
 * @returns The declared entry count and one {@link ArchiveEntry} per entry.
 */
export function parseArchive(data: Uint8Array): ParsedArchive {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const declaredCount = view.getUint32(ENTRY_COUNT_OFFSET, true)

  const tocEnd = TOC_START_OFFSET + declaredCount * RECORD_LENGTH
  if (declaredCount === 0 || tocEnd > data.byteLength) {
    throw new Error(
      `Not a recognised archive: ${declaredCount} entries would need ${tocEnd} bytes, ` +
        `but the file is ${data.byteLength} bytes`,
    )
  }

  const names: string[] = []
  const offsets: number[] = []
  for (let i = 0; i < declaredCount; i++) {
    const base = TOC_START_OFFSET + i * RECORD_LENGTH
    const field = data.subarray(base, base + NAME_FIELD_LENGTH)
    const nul = field.indexOf(0)
    names.push(decoder.decode(nul === -1 ? field : field.subarray(0, nul)))
    offsets.push(view.getUint32(base + NAME_FIELD_LENGTH, true))
  }

  return {
    declaredCount,
    entries: names.map((name, index): ArchiveEntry => {
      const dataOffset = offsets[index]!
      // Blobs are stored contiguously in TOC order, so a blob runs to the next
      // entry's offset; the final entry runs to the end of the archive.
      const nextOffset = offsets[index + 1] ?? data.byteLength
      return {name, dataOffset, blobLength: nextOffset - dataOffset}
    }),
  }
}

/**
 * Build a Codename Eagle data archive from a list of named blobs - the inverse of
 * {@link parseArchive}. Writes the `uint32` entry count, the fixed-size TOC records
 * (name + absolute blob offset), then the blobs contiguously in the given order. Works
 * for any archive (`objects.dat`, `textures.dat`, …); combine with {@link extractEntries}
 * to add, replace, or remove whole entries:
 *
 * ```ts
 * const entries = extractEntries(objectsDat).map((e) => ({name: e.name, data: e.data}))
 * entries.push({name: 'MyTank', data: projectBlob}) // add (or splice/filter to replace/remove)
 * const out = buildArchive(entries)
 * ```
 *
 * Output is byte-identical to the original except the name field's trailing padding,
 * which the format leaves uninitialised (don't-care) - here it's zero-filled.
 *
 * **`objects.dat`** carries an extra block the engine reads between the TOC and the blobs: a
 * `uint32` count + that many 13-byte NUL-padded **texture names** (a face's `texId` indexes this
 * list). The name→project hash table is *not* on disk (the engine rebuilds it from the TOC names
 * at load), so this texture list is the only extra. Pass {@link BuildArchiveOptions.textures} to
 * write it (eg `parseObjectTextures(orig)` for a round-trip, or the textures your projects
 * reference, in `texId` order); omit it for plain archives (`textures.dat`, `menupics.dat`).
 *
 * @param entries - The entries to write, in the order they should appear.
 * @param options - See {@link BuildArchiveOptions}.
 */
export function buildArchive(
  entries: ArchiveInputEntry[],
  options: BuildArchiveOptions = {},
): Uint8Array {
  const count = entries.length
  const {textures} = options
  const tocEnd = TOC_START_OFFSET + count * RECORD_LENGTH
  // objects.dat texture-name block: u32 count + count × 13-byte NUL-padded names (between TOC & blobs).
  const textureBlock = textures ? 4 + textures.length * TEXTURE_RECORD_LENGTH : 0
  const blobStart = tocEnd + textureBlock
  const total = entries.reduce((n, e) => n + e.data.byteLength, blobStart)
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(ENTRY_COUNT_OFFSET, count, true)

  let blobOffset = blobStart
  for (let i = 0; i < count; i++) {
    const {name, data} = entries[i]!
    const nameBytes = Uint8Array.from(name, (c) => c.charCodeAt(0) & 0xff) // latin1, as parseArchive reads
    if (nameBytes.length > NAME_FIELD_LENGTH) {
      throw new Error(
        `archive entry name "${name}" is ${nameBytes.length} bytes; max is ${NAME_FIELD_LENGTH}`,
      )
    }
    const base = TOC_START_OFFSET + i * RECORD_LENGTH
    out.set(nameBytes, base) // the rest of the 13-byte field stays 0 (NUL terminator + padding)
    view.setUint32(base + NAME_FIELD_LENGTH, blobOffset, true)
    out.set(data, blobOffset)
    blobOffset += data.byteLength
  }

  if (textures) {
    view.setUint32(tocEnd, textures.length, true)
    for (let i = 0; i < textures.length; i++) {
      const nameBytes = Uint8Array.from(textures[i]!, (c) => c.charCodeAt(0) & 0xff)
      if (nameBytes.length >= TEXTURE_RECORD_LENGTH) {
        throw new Error(
          `texture name "${textures[i]}" is ${nameBytes.length} bytes; max is ${TEXTURE_RECORD_LENGTH - 1}`,
        )
      }
      out.set(nameBytes, tocEnd + 4 + i * TEXTURE_RECORD_LENGTH) // rest stays 0 (NUL + padding)
    }
  }
  return out
}

/** Texture archives (`textures.dat`, `leveltex.bin`) reserve a fixed TOC of this many slots. */
const TEXTURE_TOC_SLOTS = 2048
/** Byte the original tools (`CEADDTGA`) leave in unused TOC slots and name padding. */
const TEXTURE_FILL = 0xcc
/** First blob offset in a texture archive: `4 + 2048 × 17`. */
const TEXTURE_BLOB_START = TOC_START_OFFSET + TEXTURE_TOC_SLOTS * RECORD_LENGTH

/**
 * Build a Codename Eagle **texture archive** (`textures.dat`, `leveltex.bin`) - a different
 * container from {@link buildArchive}'s object/plain archives. Texture archives reserve a
 * **fixed {@link TEXTURE_TOC_SLOTS}-slot TOC** (so blobs always begin at byte
 * {@link TEXTURE_BLOB_START}; unused slots and name padding are filled `0xCC`), and each blob is
 * the engine's **internal texture format** - a standard 24/32-bit TGA with its constant first
 * 8 header bytes stripped (the inverse of {@link extractTexture}). The engine only loads this
 * layout for textures; {@link buildArchive}'s tight TOC won't load as a texture pack.
 *
 * Pass full standard TGAs as each entry's `data` (eg from {@link encodeTga} or
 * {@link extractTexture}); the 8-byte prefix is stripped here. Round-trips a shipped texture
 * archive byte-for-byte (modulo `0xCC` don't-care padding) from `extractEntries` output.
 *
 * @param entries - The textures to write, in order (data = full standard TGA bytes).
 * @throws If more than {@link TEXTURE_TOC_SLOTS} entries, a name exceeds the field, or a blob is
 *   too short to be a TGA.
 */
export function buildTextureArchive(entries: ArchiveInputEntry[]): Uint8Array {
  const count = entries.length
  if (count > TEXTURE_TOC_SLOTS) {
    throw new Error(`texture archive holds at most ${TEXTURE_TOC_SLOTS} entries, got ${count}`)
  }
  const prefix = TGA_HEADER_PREFIX.length
  const blobs = entries.map((e) => {
    if (e.data.byteLength <= prefix) {
      throw new Error(`texture "${e.name}" is ${e.data.byteLength} bytes; not a TGA`)
    }
    return e.data.subarray(prefix) // strip the constant 8-byte TGA header → internal blob
  })

  const total = blobs.reduce((n, b) => n + b.byteLength, TEXTURE_BLOB_START)
  const out = new Uint8Array(total).fill(TEXTURE_FILL)
  const view = new DataView(out.buffer)
  view.setUint32(ENTRY_COUNT_OFFSET, count, true)

  let blobOffset = TEXTURE_BLOB_START
  for (let i = 0; i < count; i++) {
    const {name} = entries[i]!
    const nameBytes = Uint8Array.from(name, (c) => c.charCodeAt(0) & 0xff)
    if (nameBytes.length >= NAME_FIELD_LENGTH) {
      throw new Error(
        `texture name "${name}" is ${nameBytes.length} bytes; max is ${NAME_FIELD_LENGTH - 1}`,
      )
    }
    const base = TOC_START_OFFSET + i * RECORD_LENGTH
    out.fill(0, base, base + NAME_FIELD_LENGTH) // clear the 0xCC fill under the name field
    out.set(nameBytes, base)
    out[base + nameBytes.length] = 0 // NUL terminator; trailing bytes stay 0xCC (don't-care)
    out.fill(TEXTURE_FILL, base + nameBytes.length + 1, base + NAME_FIELD_LENGTH)
    view.setUint32(base + NAME_FIELD_LENGTH, blobOffset, true)
    out.set(blobs[i]!, blobOffset)
    blobOffset += blobs[i]!.byteLength
  }
  return out
}
