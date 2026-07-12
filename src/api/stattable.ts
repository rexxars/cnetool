import type {ConfigEntry} from './types.ts'
import {deobfuscate, obfuscate} from './obfuscation.ts'

/**
 * Size of one field record in the obfuscated fixed-chunk stat tables
 * (`data4.bin` weapon stats, `data3.bin`). The whole file is a run of these
 * chunks and its length is always a multiple of this.
 */
export const STAT_CHUNK_SIZE = 0x7f

const decoder = new TextDecoder('latin1')

/** A single field of a stat table, plus the index of the chunk it came from. */
export interface StatField extends ConfigEntry {
  /** 0-based chunk index in the file (needed to write the value back). */
  chunk: number
}

// Encode a string as Latin-1 bytes (the tables are Latin-1; `TextEncoder` is
// UTF-8 only, so do it by hand - every stat value is single-byte anyway).
function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff
  return out
}

// The leading `Key:Value` line of a deobfuscated chunk (up to the first newline;
// a trailing CR is dropped). Everything after the newline is ignored filler.
function chunkLine(plain: Uint8Array, chunk: number): string {
  const start = chunk * STAT_CHUNK_SIZE
  const text = decoder.decode(plain.subarray(start, start + STAT_CHUNK_SIZE))
  const nl = text.indexOf('\n')
  const line = nl === -1 ? text : text.slice(0, nl)
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/**
 * Parse an obfuscated fixed-chunk stat table (`data4.bin` / `mdata4.bin` /
 * `data3.bin`). The engine stores each field as its own {@link STAT_CHUNK_SIZE}
 * -byte chunk: an obfuscated `Key:Value` line followed by ignored filler, which
 * it deobfuscates and `sscanf`s as text. This returns one {@link StatField} per
 * chunk (in file order), carrying the chunk index so a value can be written back
 * with {@link setStatValue}.
 *
 * Use {@link groupRecords}(fields, 'Name') to split the weapon table into one
 * record per weapon (the leading `Armor`/`gas`/`bullet`/`shell` header chunks
 * sort before the first `Name` and are dropped by that grouping). The weapon's
 * class index equals its position in that grouped list.
 *
 * @param data - The raw (obfuscated) file bytes.
 */
export function parseStatTable(data: Uint8Array): StatField[] {
  const plain = deobfuscate(data)
  const chunks = Math.floor(plain.length / STAT_CHUNK_SIZE)
  const fields: StatField[] = []
  for (let chunk = 0; chunk < chunks; chunk++) {
    const line = chunkLine(plain, chunk)
    const sep = line.indexOf(':')
    if (sep === -1) continue // not a Key:Value chunk (shouldn't occur in these files)
    fields.push({key: line.slice(0, sep), value: line.slice(sep + 1), chunk})
  }
  return fields
}

/**
 * Return a copy of `data` with the chunk at `chunk` rewritten so its leading line
 * is `key:value` (newline-terminated), re-obfuscated. Only the line is overwritten;
 * the chunk's trailing filler (and every other chunk) is preserved byte-for-byte,
 * so a same-length change is a minimal diff. The engine reads the field by `sscanf`
 * on the deobfuscated chunk, so the value may be any length that fits in one chunk
 * (a shorter value simply leaves a harmless remnant of the old line after the new
 * newline, which the engine ignores).
 *
 * @throws RangeError if `chunk` is out of range or the `key:value` line does not
 *   fit in a chunk (including the newline).
 */
export function setStatField(
  data: Uint8Array,
  chunk: number,
  key: string,
  value: string,
): Uint8Array {
  const plain = deobfuscate(data)
  const chunks = Math.floor(plain.length / STAT_CHUNK_SIZE)
  if (!Number.isInteger(chunk) || chunk < 0 || chunk >= chunks) {
    throw new RangeError(`chunk ${chunk} out of range (0..${chunks - 1})`)
  }
  const bytes = latin1Bytes(`${key}:${value}\n`)
  if (bytes.length > STAT_CHUNK_SIZE) {
    throw new RangeError(
      `field "${key}:${value}" is ${bytes.length} bytes, exceeds the ${STAT_CHUNK_SIZE}-byte chunk`,
    )
  }
  plain.set(bytes, chunk * STAT_CHUNK_SIZE)
  return obfuscate(plain)
}

/**
 * Like {@link setStatField} but keeps the chunk's existing key, replacing only
 * its value. Convenience for retuning a stat (e.g. a weapon's `Damage`).
 *
 * @throws RangeError if `chunk` is out of range or does not hold a `Key:Value`
 *   line, or the new line does not fit in a chunk.
 */
export function setStatValue(data: Uint8Array, chunk: number, value: string): Uint8Array {
  const line = chunkLine(deobfuscate(data), chunk)
  const sep = line.indexOf(':')
  if (sep === -1) throw new RangeError(`chunk ${chunk} is not a Key:Value field`)
  return setStatField(data, chunk, line.slice(0, sep), value)
}

/**
 * Rebuild a whole obfuscated stat table from fields, one {@link STAT_CHUNK_SIZE}
 * -byte chunk each (`Key:Value` line + zero filler), in the given order. The
 * inverse of {@link parseStatTable} at the field level - but note the original
 * files carry non-zero filler after each line, so this is a *functional* rebuild
 * (the engine ignores the filler), not necessarily byte-identical to the input.
 * For an in-place value change that preserves the rest of the file exactly, use
 * {@link setStatValue} instead.
 *
 * @throws RangeError if any `key:value` line does not fit in a chunk.
 */
export function formatStatTable(fields: Iterable<ConfigEntry>): Uint8Array {
  const list = [...fields]
  const plain = new Uint8Array(list.length * STAT_CHUNK_SIZE)
  list.forEach((field, i) => {
    const bytes = latin1Bytes(`${field.key}:${field.value}\n`)
    if (bytes.length > STAT_CHUNK_SIZE) {
      throw new RangeError(
        `field "${field.key}:${field.value}" is ${bytes.length} bytes, exceeds the ${STAT_CHUNK_SIZE}-byte chunk`,
      )
    }
    plain.set(bytes, i * STAT_CHUNK_SIZE)
  })
  return obfuscate(plain)
}
