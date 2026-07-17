import type {LevelIndexEntry} from './types.ts'

const decoder = new TextDecoder('latin1')

// A `Name:<display name> Val:<number>` line. The name is captured lazily up to
// the trailing ` Val:<digits>` so names with embedded spaces (eg `No mans land`)
// are kept intact.
const LINE_PATTERN = /^Name:(.*?)\s+Val:(-?\d+)\s*$/i

/**
 * Parse `LEVELS.NFO`: the game's level index, one `Name:<display name>
 * Val:<number>` line per level, mapping a display name to its numeric id (the
 * `LEVEL<n>/` folder number). Campaign levels are 1-12; 128+ are the
 * bonus/multiplayer maps.
 *
 * Order and duplicates are preserved; blank and malformed lines are skipped.
 * Unlike the generic {@link parseConfig}, this handles the two-keys-per-line
 * (`Name:` + `Val:`) shape unique to this file.
 *
 * @param input - File contents, as a string or raw (Latin-1) bytes.
 */
export function parseLevelIndex(input: string | Uint8Array): LevelIndexEntry[] {
  const text = typeof input === 'string' ? input : decoder.decode(input)

  const entries: LevelIndexEntry[] = []
  for (const line of text.split('\n')) {
    const match = LINE_PATTERN.exec(line.trim())
    if (!match) continue
    entries.push({name: match[1]!.trim(), number: Number.parseInt(match[2]!, 10)})
  }

  return entries
}

/**
 * Serialize a level index back to `LEVELS.NFO` text - the inverse of
 * {@link parseLevelIndex}. Writes one `Name:<name> Val:<number>` line per entry,
 * CRLF-terminated, as the game's file uses.
 *
 * @param entries - The entries to write, in order.
 */
export function formatLevelIndex(entries: Iterable<LevelIndexEntry>): string {
  let out = ''
  for (const {name, number} of entries) out += `Name:${name} Val:${number}\r\n`
  return out
}
