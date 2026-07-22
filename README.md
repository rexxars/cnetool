# cnetool

[![npm version](https://img.shields.io/npm/v/cnetool.svg?style=flat-square)](https://www.npmjs.com/package/cnetool)

Tools for working with [Codename Eagle](https://en.wikipedia.org/wiki/Codename_Eagle) game data files. Use it programmatically as a library, or through the `cnetool` command line interface. The library is split into an `api` layer (operates on `Uint8Array`) and a Node.js `cli` layer that wraps it - the CLI is a thin shell around the same API methods you can call yourself.

It can unpack the game's `.dat` archives (`textures.dat`, `MENU/menupics.dat`, `objects.dat`, …) into their individual entries. Texture entries are rebuilt into standalone TGA files; entries whose payload isn't a known format are written out as their raw stored blobs.

For more info about the game, see [Codename Eagle Nation](https://codenameeagle.net/).

Requires Node.js 22.19 or higher. Pure ESM.

## Installation

```bash
npm install --save cnetool
```

To use the CLI without installing it as a dependency:

```bash
npx cnetool extract textures.dat
```

## CLI usage

The CLI wraps the API with a thin, filesystem-touching shell: `cnetool init`/`build` round-trip a whole game install to and from an editable project source tree, and `extract`, `mesh`, `object`, `level`, `tabmap`, `world`, `convert`, `servinfo`, `menuinfo`, `stattable`, and `server` cover individual archives, models, levels, tab maps, placements, textures, match settings, the menu profile, stat tables, and multiplayer server discovery.

```bash
# Extract every entry from an archive (textures rebuilt as TGA, everything else raw)
cnetool extract textures.dat

# Export a level's terrain + placed objects, textured, to one OBJ
cnetool level path/to/LEVEL128 --textures --controllable -o out/level.obj
```

Full command reference, options and examples: [`docs/cli.md`](./docs/cli.md). The `init`/`build` project source tree - layout, manifest, and round-trip fidelity - is documented in [`docs/project.md`](./docs/project.md).

## API usage

Everything the CLI does is available as plain functions that take and return `Uint8Array`s and data structures: only the CLI touches the filesystem, so the API works in Node, browsers and workers alike.

```ts
import {readFile, writeFile} from 'node:fs/promises'
import {extractEntries} from 'cnetool'

const data = await readFile('textures.dat')

// Extract every entry, rebuilding textures into TGAs and passing other
// payloads through as raw blobs. Each entry's `data` is a `Uint8Array`.
for (const entry of extractEntries(data)) {
  console.log('%s (%s)', entry.name, entry.kind) // eg "Water.tga (tga)" or "TankPjb (raw)"
  await writeFile(entry.name, entry.data)
}
```

Full API reference - archives, images, meshes, level assembly, tab maps, scripts, controllables, text configs and stat tables, localization, level metadata, server discovery, and exported types: [`docs/api.md`](./docs/api.md).

## Contributing

Contributing - and the API-vs-CLI separation of concerns - is in [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

MIT © [Espen Hovlandsdal](https://espen.codes/)
