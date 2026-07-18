// @env node
import {readFile} from 'node:fs/promises'
import {parseArgs} from 'node:util'

import {groupRecords, parseStatTable} from '../api/index.ts'
import type {ConfigEntry} from '../api/index.ts'

const usage = `Usage: cnetool stattable <file> [options]

Dump an obfuscated stat table - data3.bin / data4.bin and their mdata* MP
variants - as a readable table or JSON. Fields are grouped into records by their
Name field (any header chunks before the first Name are dropped).

Options:
  --json              Emit JSON (an array of record objects) instead of a table.
  -h, --help          Show this help.
`

/** Convert one record's fields to a plain object, preserving key order. */
function recordToObject(record: ConfigEntry[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const {key, value} of record) out[key] = value
  return out
}

/**
 * Render grouped stat records as an aligned text table. Columns are the union of
 * all field keys, in first-seen order; missing fields render blank.
 *
 * @param records - Records from {@link groupRecords}.
 */
export function formatStatTableText(records: ConfigEntry[][]): string {
  const rows = records.map(recordToObject)

  const columns: string[] = []
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key)
  }

  const width = columns.map((col) =>
    Math.max(col.length, ...rows.map((r) => (r[col] ?? '').length)),
  )
  const renderRow = (cells: string[]): string =>
    cells
      .map((cell, i) => cell.padEnd(width[i]!))
      .join('  ')
      .trimEnd()

  const lines = [renderRow(columns), renderRow(width.map((w) => '-'.repeat(w)))]
  for (const row of rows) lines.push(renderRow(columns.map((col) => row[col] ?? '')))
  return `${lines.join('\n')}\n`
}

/**
 * Run the `stattable` CLI command.
 *
 * @param argv - Arguments following the `stattable` command.
 */
export async function runStatTable(argv: string[]): Promise<void> {
  const {values, positionals} = parseArgs({
    args: argv,
    options: {
      json: {type: 'boolean'},
      help: {type: 'boolean', short: 'h'},
    },
    allowPositionals: true,
  })

  if (values.help || positionals.length === 0) {
    process.stdout.write(usage)
    if (positionals.length === 0 && !values.help) process.exitCode = 1
    return
  }

  const input = positionals[0]!
  const records = groupRecords(parseStatTable(await readFile(input)), 'Name')

  if (records.length === 0) {
    process.stderr.write(
      `No records found in ${input} (no "Name" fields - is this a stat table?)\n`,
    )
    process.exitCode = 1
    return
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(records.map(recordToObject), null, 2)}\n`)
    return
  }
  process.stdout.write(formatStatTableText(records))
}
