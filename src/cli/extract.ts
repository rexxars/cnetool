// @env node
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {basename, extname, join} from 'node:path'
import {parseArgs} from 'node:util'

import {extractEntries, tgaToPng} from '../api/index.ts'

const usage = `Usage: cnetool extract [options] <archive...>

Extract every entry from one or more Codename Eagle archives (eg textures.dat,
menupics.dat, objects.dat). Texture entries are rebuilt into standalone TGA
files; any other entry is written out as its raw stored blob.

Textures export as-is: a 32-bit texture keeps its alpha (RGBA PNG), a 24-bit one
stays opaque RGB. CE makes a 24-bit texture's black see-through at draw time via a
per-draw color-key (engine behaviour, not the texture's), so
it is not reproduced here.

Options:
  -p, --png            Write textures as PNG instead of TGA.
  -o, --output <dir>   Output directory. Defaults to a directory named after
                       each archive (eg "textures.dat" -> "./textures/").
  -h, --help           Show this help.
`

interface ExtractOptions {
  output?: string
  png?: boolean
}

/**
 * Run the `extract` CLI command.
 *
 * @param argv - Arguments following the `extract` command.
 */
export async function runExtract(argv: string[]): Promise<void> {
  const {values, positionals} = parseArgs({
    args: argv,
    options: {
      output: {type: 'string', short: 'o'},
      png: {type: 'boolean', short: 'p'},
      help: {type: 'boolean', short: 'h'},
    },
    allowPositionals: true,
  })

  if (values.help || positionals.length === 0) {
    process.stdout.write(usage)
    if (positionals.length === 0 && !values.help) process.exitCode = 1
    return
  }

  for (const archive of positionals) {
    await extractArchive(archive, {
      output: values.output,
      png: values.png,
    })
  }
}

async function extractArchive(archivePath: string, options: ExtractOptions): Promise<void> {
  const data = await readFile(archivePath)
  const entries = extractEntries(data)

  const outDir = options.output ?? basename(archivePath, extname(archivePath))
  await mkdir(outDir, {recursive: true})

  const used = new Map<string, number>()
  let textures = 0
  for (const entry of entries) {
    let {name, data: bytes} = {name: entry.name, data: entry.data}
    if (entry.kind === 'tga') {
      textures++
      if (options.png) {
        name = `${name.slice(0, name.length - extname(name).length)}.png`
        // topOrigin: archive blobs store rows top-down behind a lying bottom-origin
        // descriptor (see TgaToPngOptions); the .tga output stays byte-faithful.
        bytes = tgaToPng(entry.data, {topOrigin: true})
      }
    }
    const fileName = uniqueName(safeName(name), used)
    await writeFile(join(outDir, fileName), bytes)
  }

  const raw = entries.length - textures
  process.stdout.write(
    `Extracted ${entries.length} entries (${textures} textures, ${raw} raw) ` +
      `from ${archivePath} into ${outDir}/\n`,
  )
}

/** Reduce an entry name to a safe single path segment. */
function safeName(name: string): string {
  const segment = basename(name).replace(/[/\\]/g, '_').trim()
  return segment.length > 0 ? segment : 'unnamed'
}

function uniqueName(name: string, used: Map<string, number>): string {
  const key = name.toLowerCase()
  const seen = (used.get(key) ?? 0) + 1
  used.set(key, seen)
  if (seen === 1) return name

  const ext = extname(name)
  return `${name.slice(0, name.length - ext.length)}_${seen}${ext}`
}
