export interface TextureArchiveSpec {
  /** install-relative path, lowercase (engine probes case-insensitively) */
  installPath: string
  /** directory name under source/textures/ */
  sourceDir: string
}

export const TEXTURE_ARCHIVES: TextureArchiveSpec[] = [
  {installPath: '24bits/textures.dat', sourceDir: 'textures.dat'},
  {installPath: '24bits/texsec.dat', sourceDir: 'texsec.dat'},
  {installPath: 'menu/menupics.dat', sourceDir: 'menupics.dat'},
]

export interface StatTableSpec {
  file: string
  source: string
}

export const STAT_TABLES: StatTableSpec[] = [
  {file: 'data3.bin', source: 'units.json'},
  {file: 'data4.bin', source: 'weapons.json'},
  {file: 'mdata3.bin', source: 'units-mp.json'},
  {file: 'mdata4.bin', source: 'weapons-mp.json'},
]

export interface ConfigFileSpec {
  file: string
  source: string
}

/** Global Key:Value config texts (grow this list as more are confirmed global). */
export const CONFIG_FILES: ConfigFileSpec[] = [{file: 'keyconf.dat', source: 'keyconf.txt'}]

export const OBJECT_ARCHIVES = ['objects.dat', 'objects2.dat']

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’]+/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Files the engine generates at runtime — never source, never build products. */
export function isEngineGenerated(name: string): boolean {
  const lower = name.toLowerCase()
  return (
    lower === 'error.log' ||
    lower === 'hiscores.dat' ||
    lower === 'diacache.dat' ||
    lower.endsWith('cache.bin')
  )
}

/**
 * Files excluded from the source tree and from a build entirely: engine-generated
 * runtime files plus OS filesystem cruft (`.DS_Store`, which SMB shares expose as
 * `.ds_store`). Skipped on init, swept from `output/` on build.
 */
export function isIgnoredFile(name: string): boolean {
  return isEngineGenerated(name) || name.toLowerCase() === '.ds_store'
}
