#!/usr/bin/env node
// @env node
import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {runConvert} from './cli/convert.ts'
import {runExtract} from './cli/extract.ts'
import {runLevel} from './cli/level.ts'
import {runMenuInfo} from './cli/menuinfo.ts'
import {runMesh} from './cli/mesh.ts'
import {runObject} from './cli/object.ts'
import {runServer} from './cli/server.ts'
import {runServinfo} from './cli/servinfo.ts'
import {runTabmap} from './cli/tabmap.ts'
import {runWorld} from './cli/world.ts'

const usage = `cnetool - tools for Codename Eagle game data files

Usage: cnetool <command> [options]

Commands:
  extract <archive...>     Extract entries from an archive (textures -> TGA/PNG)
  mesh <objects.dat> ...   Export raw project meshes to OBJ files
  object <objects.dat> ... Export assembled models (incl. controllable vehicles) to OBJ
  level <levelDir>         Assemble a level (terrain + placed objects) to OBJ
  tabmap <levelDir>        Render the in-game tab map (tiles + MAPMTX.DAT) for a level
  world <data1.bin|World.dat>  Convert placements between data1.bin and World.dat
  convert <file>           Convert a texture between TGA and PNG
  servinfo <servinfo.dat>  Read or edit host multiplayer match settings
  menuinfo <menuinfo.dat>  Read or edit the persisted menu profile / options
  server <list|query>      Discover servers (master list + LAN) or query one

Run "cnetool <command> --help" for command-specific options.
`

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv

  switch (command) {
    case 'extract':
      await runExtract(rest)
      return
    case 'mesh':
      await runMesh(rest)
      return
    case 'object':
      await runObject(rest)
      return
    case 'level':
      await runLevel(rest)
      return
    case 'tabmap':
      await runTabmap(rest)
      return
    case 'world':
      await runWorld(rest)
      return
    case 'convert':
      await runConvert(rest)
      return
    case 'servinfo':
      await runServinfo(rest)
      return
    case 'menuinfo':
      await runMenuInfo(rest)
      return
    case 'server':
      await runServer(rest)
      return
    case '-v':
    case '--version':
      process.stdout.write(`${readVersion()}\n`)
      return
    case undefined:
    case '-h':
    case '--help':
      process.stdout.write(usage)
      return
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${usage}`)
      process.exitCode = 1
  }
}

function readVersion(): string {
  try {
    const pkg: unknown = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    )
    if (pkg && typeof pkg === 'object' && 'version' in pkg && typeof pkg.version === 'string') {
      return pkg.version
    }
  } catch {
    // fall through
  }
  return 'unknown'
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
