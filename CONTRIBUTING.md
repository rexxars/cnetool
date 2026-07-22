# Contributing

## Architecture: the API does the work, the CLI is glue

`cnetool` is a library first and a CLI second. **All real logic lives in the `api` layer; the `cli` layer only does I/O and orchestration.**

### The `api` layer (`src/api/`)

- Operates on **`Uint8Array`** (and strings/objects) in, data structures out.
- **No filesystem, no `process`, no argv, no `console`.** Keeping the core byte-oriented is what makes it usable as a library and easy to test, and as a bonus it runs in browsers, Deno and workers too.
- Each format gets a parser that takes bytes and returns typed data; transforms take data and return data. Anything reusable or testable in isolation goes here.
- Types live in `types.ts` (or as co-located `export type` for module-local types); constants in `constants.ts`.

### The `cli` layer (`src/cli/`)

- The only place that touches the filesystem, `process`, args and stdout. Mark these files `// @env node`.
- A command should read inputs (flags via `node:util` `parseArgs`, files, cwd), call **one or a few** `api` functions, and write outputs. If a command grows a non-trivial algorithm, that algorithm belongs in `api` instead.
- Filesystem-only concerns (unique output filenames, directory layout) may stay in the CLI - they aren't part of the library's job.

### Rule of thumb

If you can describe a step as "given these bytes/values, produce this result" without mentioning files or the terminal, it's an `api` function. The CLI then reads the bytes, calls it, and writes the result.

Good (CLI):

```ts
const scene = assembleLevel(objectsData, {placements, terrain}) // api: the logic
await writeFile(out, meshesToObj(scene.items)) // cli: glue
```

Avoid (CLI): looping placements, resolving project names, transforming meshes, and resolving textures inline - that's all `api` work.

## Conventions

- **Pure ESM**, TypeScript with **erasable syntax only** (no enums/namespaces/decorators), strict mode, no type assertions to silence errors.
- Separate `types.ts` / `constants.ts`; explicit return types; `unknown` over `any`.
- Imports use explicit `.ts` extensions and `import type` for type-only imports; Node built-ins use the `node:` prefix.
- Tests with **Vitest** (`describe` + `test`, imported explicitly); in success tests use `if (error) throw error` over `expect(error).toBeUndefined()`.

## Workflow

```sh
npm run lint       # oxlint + oxfmt --check
npm run format     # oxfmt --write
npm run typecheck  # tsc --noEmit
npm test           # vitest run
npm run build      # tsc -p tsconfig.build.json
```

Run all of them before opening a pull request. New `api` functions need unit tests; new format findings should be documented, with the confidence level (confirmed in-engine vs inferred) stated.
