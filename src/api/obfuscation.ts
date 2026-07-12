import {OBFUSCATION_KEY} from './constants.ts'

/**
 * Reverse the byte obfuscation used by some config files (`data3.bin`,
 * `data4.bin`): subtract {@link OBFUSCATION_KEY} from every byte. The result is
 * the original content - text records (readable with `parseConfig`'s `scan`
 * mode) interleaved with binary numeric fields.
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
