import {OBFUSCATION_KEY} from './constants.ts'

/**
 * Reverse the byte obfuscation used by the stat tables (`data3.bin`,
 * `data4.bin`, and the `mdata*` variants): subtract {@link OBFUSCATION_KEY}
 * from every byte. Each table is a flat array of fixed 127-byte slots, and each
 * slot holds one NUL-terminated `Key:Value\n` text line (the bytes after the
 * NUL are ignored filler, not data); see `stattable.ts` for the slot codec.
 * This is the raw whole-array transform — the engine deobfuscates only up to
 * the first NUL per slot.
 *
 * @param data - Obfuscated bytes.
 * @returns A new array of deobfuscated bytes.
 */
export function deobfuscate(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i++) out[i] = (data[i]! - OBFUSCATION_KEY) & 0xff
  return out
}

/**
 * Inverse of {@link deobfuscate}: add {@link OBFUSCATION_KEY} to every byte.
 *
 * @param data - Plain bytes.
 * @returns A new array of obfuscated bytes.
 */
export function obfuscate(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i++) out[i] = (data[i]! + OBFUSCATION_KEY) & 0xff
  return out
}
