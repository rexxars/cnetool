// @env node
import {readFile, writeFile} from 'node:fs/promises'
import {parseArgs} from 'node:util'

import {formatWorld, parsePlacements, parseWorld, serializePlacements} from '../api/index.ts'

const usage = `Usage: cetool world <input> [output]

Convert a level's object placements between the binary "data1.bin" and the editable
text "World.dat" (same data: name + position + 3x3 rotation). Direction is auto-detected:

  data1.bin  ->  World.dat   binary -> editable text (prints to stdout if no output given)
  World.dat  ->  data1.bin   text -> binary (an output path is required)

So the round trip is: cetool world data1.bin -o World.dat ; edit ; cetool world World.dat -o data1.bin

Options:
  -o, --output <file>   Output path (or pass it as the 2nd positional).
  --marker <hex>        data1.bin record marker to write (default 0). It's a stale
                        per-file pointer in shipped files, treated as don't-care.
  -h, --help            Show this help.
`

/** Does the input look like text World.dat (vs binary data1.bin)? */
function looksLikeWorld(data: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(data.subarray(0, 256))
  return /(^|[\r\n])\s*(Name|Dele|Translation|Dof|Up|Right)\s*:/.test(head)
}

/**
 * Run the `world` CLI command.
 *
 * @param argv - Arguments following the `world` command.
 */
export async function runWorld(argv: string[]): Promise<void> {
  const {values, positionals} = parseArgs({
    args: argv,
    options: {
      output: {type: 'string', short: 'o'},
      marker: {type: 'string'},
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
  const output = values.output ?? positionals[1]
  const data = await readFile(input)

  if (looksLikeWorld(data)) {
    // World.dat -> data1.bin (binary output required)
    if (!output) {
      process.stderr.write(
        'world: World.dat -> data1.bin needs an output path, e.g. -o LEVEL3/data1.bin\n',
      )
      process.exitCode = 1
      return
    }
    const entries = parseWorld(data)
    const placements = entries.filter((e) => e.kind !== 'Dele')
    const dropped = entries.length - placements.length
    const marker = values.marker ? Number.parseInt(values.marker, 16) : 0
    await writeFile(output, serializePlacements(placements, {marker}))
    const note = dropped > 0 ? ` (skipped ${dropped} Dele: entr${dropped === 1 ? 'y' : 'ies'})` : ''
    process.stderr.write(`Wrote ${input} -> ${output}: ${placements.length} placements${note}\n`)
  } else {
    // data1.bin -> World.dat (text; stdout by default)
    const text = formatWorld(parsePlacements(data))
    if (output) {
      await writeFile(output, text)
      process.stderr.write(
        `Wrote ${input} -> ${output}: ${parsePlacements(data).length} placements\n`,
      )
    } else {
      process.stdout.write(text)
    }
  }
}
