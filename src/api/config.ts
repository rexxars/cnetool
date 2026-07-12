import type {ConfigEntry, ParseConfigOptions} from './types.ts'

const decoder = new TextDecoder('latin1')
const COMMENT_PREFIX = '//'

// A `Key:Value` pair where the key is a bareword and the value is a run of
// printable ASCII. Used by `scan` mode to pull pairs out of binary noise.
const SCAN_PATTERN = /([A-Za-z][A-Za-z0-9_]{0,20}):([ -~]*)/g

/**
 * Parse a Codename Eagle text-config `.dat` file (the `Key:Value` family used by
 * `MOBJS.DAT`, `BRIEF.DAT`, `MATS.DAT`, `KEYCONF.DAT`, etc).
 *
 * Each line is split on its first `:` into a trimmed key and value. Blank lines
 * and `//` comment lines are skipped, as are lines without a `:`. Order and
 * duplicate keys are preserved, since several files repeat keys (eg `MOBJS.DAT`
 * has many `Name:`/`Type:` pairs) - use {@link groupRecords} to split those
 * into records.
 *
 * With `{scan: true}`, pairs are instead matched anywhere in the input via a
 * `bareword:printable` pattern, ignoring line structure. Use this for the
 * obfuscated stat tables (`data3.bin`, `data4.bin` after {@link deobfuscate}),
 * where text fields are interleaved with binary; the binary is skipped.
 *
 * Line mode does not join multi-line quoted values (as found in the localization
 * files like `DIALOGUE.DAT`), which need a dedicated parser.
 *
 * @param input - File contents, as a string or raw (Latin-1) bytes.
 * @param options - Set `scan: true` for pattern-based extraction.
 */
export function parseConfig(
  input: string | Uint8Array,
  options: ParseConfigOptions = {},
): ConfigEntry[] {
  const text = typeof input === 'string' ? input : decoder.decode(input)

  if (options.scan) {
    return [...text.matchAll(SCAN_PATTERN)].map((match) => ({
      key: match[1]!,
      value: match[2]!.trim(),
    }))
  }

  const entries: ConfigEntry[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith(COMMENT_PREFIX)) continue

    const separator = line.indexOf(':')
    if (separator === -1) continue

    entries.push({
      key: line.slice(0, separator).trim(),
      value: line.slice(separator + 1).trim(),
    })
  }

  return entries
}

/**
 * Serialize config entries back to text - the inverse of {@link parseConfig} (line mode).
 * Writes one `Key:Value` line per entry, CRLF-terminated, as the game's files use (eg to
 * rebuild `MOBJS.DAT` from `Name:`/`Type:` pairs). No space follows the colon; the engine
 * reads values with leading whitespace skipped, so spacing is don't-care.
 *
 * @param entries - The entries to write, in order.
 */
export function formatConfig(entries: Iterable<ConfigEntry>): string {
  let out = ''
  for (const {key, value} of entries) out += `${key}:${value}\r\n`
  return out
}

/**
 * Split flat config entries into records, starting a new record at each entry
 * whose key equals `startKey` (case-insensitive). Entries before the first
 * `startKey` are not included.
 *
 * For example, `groupRecords(parseConfig(mobjs), 'Name')` yields one record per
 * object, each `[{key: 'Name', …}, {key: 'Type', …}]`.
 */
export function groupRecords<T extends ConfigEntry>(entries: T[], startKey: string): T[][] {
  const start = startKey.toLowerCase()
  const records: T[][] = []
  let current: T[] | null = null

  for (const entry of entries) {
    if (entry.key.toLowerCase() === start) {
      current = []
      records.push(current)
    }
    current?.push(entry)
  }

  return records
}
