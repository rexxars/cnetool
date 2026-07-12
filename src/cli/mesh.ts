// @env node
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {basename, dirname, extname, join} from 'node:path'
import {parseArgs} from 'node:util'

import {
  buildMtl,
  createTextureResolver,
  extractFile,
  meshToObj,
  parseArchive,
  parseMesh,
} from '../api/index.ts'
import type {MeshLod, MeshToObjOptions, ObjUp, ResolvedTexture} from '../api/index.ts'
import {resolveGroup} from './textures.ts'

const usage = `Usage: cetool mesh [options] <objects.dat> [name...]

Export "project" meshes from objects.dat to Wavefront OBJ files. With no names,
every project that has geometry is exported (terrain projects are named land<n>
/ level<n>). Empty placeholder projects are skipped.

Options:
  -t, --textures       Also resolve textures: write a .mtl per mesh and extract
                       the referenced images (needs 24bits/textures.dat next to
                       objects.dat).
  -p, --png            Write extracted textures as PNG instead of TGA.
  --lod <level>        Which level-of-detail layer to export: high (default),
                       medium, low, or a 0-based index. Projects ship up to 3.
  --up <axis>          Up-axis of the export: y (default, upright Y-up), z (Z-up,
                       eg Blender), or raw (as stored - the game is -Y-up).
  -o, --output <dir>   Output directory. Defaults to "<archive>-meshes".
  -h, --help           Show this help.
`

/** Coerce a --lod flag value to a {@link MeshLod} (numeric index or named level). */
function parseLod(value: string | undefined): MeshLod | undefined {
  if (value === undefined) return undefined
  if (value === 'high' || value === 'medium' || value === 'low') return value
  const index = Number(value)
  return Number.isInteger(index) ? index : undefined
}

/** Coerce a --up flag value to an {@link ObjUp}. */
function parseUp(value: string | undefined): ObjUp | undefined {
  return value === 'y' || value === 'z' || value === 'raw' ? value : undefined
}

/**
 * Run the `mesh` CLI command.
 *
 * @param argv - Arguments following the `mesh` command.
 */
export async function runMesh(argv: string[]): Promise<void> {
  const {values, positionals} = parseArgs({
    args: argv,
    options: {
      output: {type: 'string', short: 'o'},
      textures: {type: 'boolean', short: 't'},
      png: {type: 'boolean', short: 'p'},
      lod: {type: 'string'},
      up: {type: 'string'},
      help: {type: 'boolean', short: 'h'},
    },
    allowPositionals: true,
  })

  const lod = parseLod(values.lod)
  const up = parseUp(values.up)

  if (values.help || positionals.length === 0) {
    process.stdout.write(usage)
    if (positionals.length === 0 && !values.help) process.exitCode = 1
    return
  }

  const [archivePath, ...names] = positionals
  const data = await readFile(archivePath!)
  const {entries} = parseArchive(data)

  const wanted = names.length > 0 ? new Set(names) : null
  const outDir = values.output ?? `${basename(archivePath!, extname(archivePath!))}-meshes`
  await mkdir(outDir, {recursive: true})

  let resolveTexture: ((texId: number) => ResolvedTexture | null) | null = null
  if (values.textures) {
    const dir24 = join(dirname(archivePath!), '24bits')
    const texturesData = await readFile(join(dir24, 'textures.dat')).catch(() => null)
    if (texturesData) {
      // 1.41 splits model textures between textures.dat and texsec.dat; search both.
      const texsec = await readFile(join(dir24, 'texsec.dat')).catch(() => null)
      resolveTexture = createTextureResolver(data, [texturesData, ...(texsec ? [texsec] : [])])
    } else {
      process.stderr.write(
        `--textures: ${join(dir24, 'textures.dat')} not found; exporting without materials\n`,
      )
    }
  }
  const written = new Set<string>()

  let writtenCount = 0
  let skipped = 0
  for (const entry of entries) {
    if (wanted && !wanted.has(entry.name)) continue
    const mesh = parseMesh(extractFile(data, entry), {lod})
    if (mesh.faces.length === 0) {
      skipped++
      continue
    }

    const objOptions: MeshToObjOptions = {name: entry.name, up}
    if (resolveTexture) {
      const {materialFor, materials} = await resolveGroup(resolveTexture, [mesh], outDir, written, {
        png: values.png,
      })
      if (materials.length > 0) {
        const mtlName = `${entry.name}.mtl`
        await writeFile(join(outDir, mtlName), buildMtl(materials))
        objOptions.mtllib = mtlName
        objOptions.material = materialFor
      }
    }

    await writeFile(join(outDir, `${entry.name}.obj`), meshToObj(mesh, objOptions))
    writtenCount++
  }

  process.stdout.write(
    `Exported ${writtenCount} meshes (${skipped} empty skipped) into ${outDir}/\n`,
  )
}
