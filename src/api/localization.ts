import type {BriefingSection, DialogueEntry, DialogueFile} from './types.ts'

const decoder = new TextDecoder('latin1')
const LANGUAGES_KEY = 'languages'
const FILENAME_KEY = 'filename'

function toText(input: string | Uint8Array): string {
  return typeof input === 'string' ? input : decoder.decode(input)
}

function toLines(text: string): string[] {
  return text.split('\n').map((line) => line.replace(/\r$/, ''))
}

/** A field line is `Key:value` where the key is a single bareword. */
const FIELD_LINE = /^([A-Za-z][A-Za-z0-9]*)[ \t]*:(.*)$/

/** Remove a single pair of surrounding double quotes, if present. */
function unquote(value: string): string {
  const trimmed = value.trim()
  if (!trimmed.startsWith('"')) return trimmed
  const close = trimmed.lastIndexOf('"')
  return close > 0 ? trimmed.slice(1, close) : trimmed.slice(1)
}

/**
 * Parse a dialogue file (`DIALOGUE.DAT`): a `Languages:N` header followed by
 * records, each a `Filename:<id>` line and one `<Language>:"…"` line per
 * language. Language tags are whatever the file uses (they vary between files,
 * eg `Fre` vs `Fra`).
 *
 * A translation value may span multiple lines (long cutscene dialogue with
 * embedded quotes and colons). A value therefore runs until the next field line
 * (`Key:`); prose continuation lines never start with `bareword:`. This is
 * resilient to the source's occasional missing closing quotes.
 *
 * @param input - File contents, as a string or raw (Latin-1) bytes.
 */
export function parseDialogue(input: string | Uint8Array): DialogueFile {
  let languageCount = 0
  const entries: DialogueEntry[] = []
  let current: DialogueEntry | null = null

  const lines = toLines(toText(input))
  for (let i = 0; i < lines.length; i++) {
    const match = FIELD_LINE.exec(lines[i]!)
    if (!match) continue

    const key = match[1]!
    const rest = match[2]!
    const lowerKey = key.toLowerCase()

    if (lowerKey === LANGUAGES_KEY) {
      languageCount = Number.parseInt(rest.trim(), 10) || 0
    } else if (lowerKey === FILENAME_KEY) {
      current = {filename: rest.trim(), translations: []}
      entries.push(current)
    } else if (current) {
      let value = rest
      while (i + 1 < lines.length && !FIELD_LINE.test(lines[i + 1]!)) {
        value += `\n${lines[++i]}`
      }
      current.translations.push({language: key, text: unquote(value)})
    }
  }

  return {languageCount, entries}
}

/**
 * Parse a briefing file (`MISSION.DAT`, `ENDBRF.DAT`): free-form localized text
 * split into sections by `//<language>:----` delimiter lines. Each section's
 * body is kept verbatim apart from trimmed surrounding blank lines.
 *
 * @param input - File contents, as a string or raw (Latin-1) bytes.
 */
export function parseBriefing(input: string | Uint8Array): BriefingSection[] {
  const sections: BriefingSection[] = []
  let language: string | null = null
  let body: string[] = []

  const flush = (): void => {
    if (language !== null) sections.push({language, text: body.join('\n').trim()})
  }

  for (const line of toLines(toText(input))) {
    const delimiter = /^\/\/([^:]+):/.exec(line)
    if (delimiter) {
      flush()
      language = delimiter[1]!.trim()
      body = []
    } else if (language !== null) {
      body.push(line)
    }
  }
  flush()

  return sections
}
