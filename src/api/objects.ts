import {ENTRY_COUNT_OFFSET, RECORD_LENGTH, TOC_START_OFFSET} from './constants.ts'
import {parseArchive} from './parse.ts'
import type {ArchiveEntry} from './types.ts'

const decoder = new TextDecoder('latin1')

/** Each record in the texture-name table is a 13-byte NUL-terminated filename. */
const TEXTURE_RECORD_LENGTH = 13

/**
 * Parse the texture-name table from `objects.dat`. It follows the project table
 * of contents: a `uint32` count, then that many 13-byte name records. A mesh
 * face's `texId` (see {@link parseMesh}) indexes this table, giving the texture's
 * source filename (eg `MULT15.TGA`) - resolve that name against `textures.dat`.
 *
 * @param data - Raw `objects.dat` bytes.
 * @returns Source texture filenames, indexed by `texId`.
 */
export function parseObjectTextures(data: Uint8Array): string[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const projectCount = view.getUint32(ENTRY_COUNT_OFFSET, true)

  let offset = TOC_START_OFFSET + projectCount * RECORD_LENGTH
  if (offset + 4 > data.byteLength) return []
  const textureCount = view.getUint32(offset, true)
  offset += 4

  const names: string[] = []
  for (let i = 0; i < textureCount && offset + TEXTURE_RECORD_LENGTH <= data.byteLength; i++) {
    const field = data.subarray(offset, offset + TEXTURE_RECORD_LENGTH)
    const nul = field.indexOf(0)
    names.push(decoder.decode(nul === -1 ? field : field.subarray(0, nul)))
    offset += TEXTURE_RECORD_LENGTH
  }
  return names
}

/** A mesh `texId` resolved to a material name and the texture archive entry to extract. */
/**
 * An alt-skin texture swap for {@link createTextureResolver}: maps a source texture's
 * lowercased base name (no extension, eg `carnew`) to the replacement base name
 * (`Carnew2`). CE bakes these per vehicle variant (`car2`, `plane4`) via an in-engine
 * face-texture rewrite; applying the same map reproduces the alt skin on export.
 */
export type TextureSkin = Record<string, string>

export interface ResolvedTexture {
  /** A safe material name (the texture's base filename). */
  material: string
  /** The archive entry holding the texture (pass to `extractTexture` with `textures`). */
  entry: ArchiveEntry
  /** The texture archive bytes `entry` belongs to (eg `textures.dat` or `texsec.dat`). */
  textures: Uint8Array
}

/**
 * Build a memoized resolver mapping a mesh face's `texId` to its material name
 * and texture-archive entry. Resolution: `texId` → name in `objects.dat`'s texture
 * table → entry in one of the texture archives (normalizing source extensions
 * like `.TIF` to `.TGA`). Returns `null` for unmapped/unknown textures.
 *
 * Pass several texture archives to search them in order - the 1.41 patch splits
 * model textures between `textures.dat` and `texsec.dat`. The resolved
 * {@link ResolvedTexture} carries the specific archive its `entry` came from.
 *
 * Pure: extracting/writing the texture image is the caller's job
 * (`extractTexture(resolved.textures, resolved.entry)`).
 *
 * @param objectsData - Raw object archive bytes (provides the texture-name table).
 * @param textures - One or more texture archives (eg `textures.dat`), searched in order.
 */
export function createTextureResolver(
  objectsData: Uint8Array,
  textures: Uint8Array | Uint8Array[],
  skin?: TextureSkin,
): (texId: number) => ResolvedTexture | null {
  const sourceNames = parseObjectTextures(objectsData)
  const archives = Array.isArray(textures) ? textures : [textures]
  const byName = new Map<string, {entry: ArchiveEntry; textures: Uint8Array}>()
  for (const archive of archives) {
    for (const entry of parseArchive(archive).entries) {
      const key = entry.name.toLowerCase()
      if (!byName.has(key)) byName.set(key, {entry, textures: archive})
    }
  }

  const cache = new Map<number, ResolvedTexture | null>()
  return (texId) => {
    const cached = cache.get(texId)
    if (cached !== undefined) return cached

    let resolved: ResolvedTexture | null = null
    const source = sourceNames[texId]
    if (source) {
      const dot = source.lastIndexOf('.')
      let base = dot === -1 ? source : source.slice(0, dot)
      // Alt-skin swap: the engine rewrites a face's texture X -> X2 for the alt vehicle
      // variant (car2, plane4). Apply the same name swap so the export shows that skin.
      const swapped = skin?.[base.toLowerCase()]
      if (swapped) base = swapped
      const found = byName.get(`${base.toLowerCase()}.tga`) ?? byName.get(source.toLowerCase())
      if (found) {
        resolved = {material: base.replace(/[^A-Za-z0-9_]/g, '_'), ...found}
      }
    }
    cache.set(texId, resolved)
    return resolved
  }
}
