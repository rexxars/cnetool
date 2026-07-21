// @env node
import {copyFile, mkdir, readdir, stat} from 'node:fs/promises'
import {dirname, join, relative, sep} from 'node:path'

/** Whether an error is a Node "file not found" (`ENOENT`). */
export function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/**
 * Recursively list every file under `root`, returning paths relative to `root`
 * with forward-slash separators (stable across platforms, usable as map keys).
 * A missing `root` yields an empty list.
 */
export async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = []
  await walkInto(root, root, out)
  return out.map((path) => path.split(sep).join('/'))
}

async function walkInto(root: string, dir: string, out: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, {withFileTypes: true})
  } catch (error) {
    if (isEnoent(error)) return
    throw error
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walkInto(root, full, out)
    else if (entry.isFile()) out.push(relative(root, full))
  }
}

/** Whether a filesystem path exists (any kind). */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Copy `src` to `dest`, creating the destination's parent directory. */
export async function copyThrough(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), {recursive: true})
  await copyFile(src, dest)
}
