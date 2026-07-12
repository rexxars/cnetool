// @env node
import {readFile, writeFile} from 'node:fs/promises'
import {extname} from 'node:path'
import {parseArgs} from 'node:util'

import {pngToTga, tgaToPng} from '../api/index.ts'

const usage = `Usage: cetool convert <input> [output]

Convert between TGA and PNG by file extension:
  input.tga -> PNG   (default output: input.png)
  input.png -> TGA   (default output: input.tga, game-style BGR/bottom-origin)

Options:
  -h, --help   Show this help.
`

/**
 * Run the `convert` CLI command.
 *
 * @param argv - Arguments following the `convert` command.
 */
export async function runConvert(argv: string[]): Promise<void> {
  const {values, positionals} = parseArgs({
    args: argv,
    options: {help: {type: 'boolean', short: 'h'}},
    allowPositionals: true,
  })

  if (values.help || positionals.length === 0) {
    process.stdout.write(usage)
    if (positionals.length === 0 && !values.help) process.exitCode = 1
    return
  }

  const input = positionals[0]!
  const ext = extname(input).toLowerCase()
  const data = await readFile(input)

  let output: string
  let result: Uint8Array
  if (ext === '.tga') {
    output = positionals[1] ?? `${input.slice(0, input.length - ext.length)}.png`
    result = tgaToPng(data)
  } else if (ext === '.png') {
    output = positionals[1] ?? `${input.slice(0, input.length - ext.length)}.tga`
    result = pngToTga(data)
  } else {
    process.stderr.write(`Unsupported extension "${ext}"; expected .tga or .png\n`)
    process.exitCode = 1
    return
  }

  await writeFile(output, result)
  process.stdout.write(`Converted ${input} -> ${output}\n`)
}
