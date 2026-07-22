import type {Placement, WorldEntry} from './types.ts'

const decoder = new TextDecoder('latin1')

/** A {@link Placement} optionally tagged with its `World.dat` keyword, for {@link formatWorld}. */
export type WorldPlacement = Placement & {kind?: 'Name' | 'Dele'}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1]

/**
 * Parse a level's text `World.dat` into placements.
 *
 * `World.dat` is the engine's human-readable level-placement format (the text
 * twin of the binary `data1.bin`). Each object is a block:
 *
 * ```
 * Name:tank_01
 * Translation: -3162.09,-9.48,3790.53
 * Dof:   0.0 0.0 -1.0
 * Up:    0.0 1.0  0.0
 * Right: 1.0 0.0  0.0
 * ```
 *
 * `Translation` is the world position; `Dof` (direction of forward), `Up` and
 * `Right` are the object's orientation basis vectors. They map onto the same
 * 9-value `rotation` matrix as a {@link Placement}, in row order `[Dof, Up, Right]`
 * - verified byte-identical to `data1.bin`'s matrix - so the result drops straight
 * into `transformMesh`/`assembleLevel`.
 *
 * @param data - Raw `World.dat` bytes or text.
 */
export function parseWorld(data: Uint8Array | string): WorldEntry[] {
  const text = typeof data === 'string' ? data : decoder.decode(data)
  const entries: WorldEntry[] = []
  let current: WorldEntry | null = null

  const setTriplet = (offset: number, value: string): void => {
    if (!current) return
    const parts = value.split(/\s+/).map(Number)
    for (let i = 0; i < 3; i++) {
      if (Number.isFinite(parts[i])) current.rotation[offset + i] = parts[i]!
    }
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon)
    const value = line.slice(colon + 1).trim()

    if (key === 'Name' || key === 'Dele') {
      if (current) entries.push(current)
      current = {kind: key, name: value, position: {x: 0, y: 0, z: 0}, rotation: [...IDENTITY]}
    } else if (!current) {
      continue
    } else if (key === 'Translation') {
      const [x, y, z] = value.split(',').map((s) => Number(s.trim()))
      current.position = {x: x ?? 0, y: y ?? 0, z: z ?? 0}
    } else if (key === 'Dof') {
      setTriplet(0, value)
    } else if (key === 'Up') {
      setTriplet(3, value)
    } else if (key === 'Right') {
      setTriplet(6, value)
    }
  }
  if (current) entries.push(current)
  return entries
}

/**
 * Serialize placements back into `World.dat` text (CRLF line endings, as the game
 * writes). Each entry's `kind` is preserved when present (else `Name`), and its
 * `rotation` is emitted as `Dof`/`Up`/`Right` from rows `[0..2]`/`[3..5]`/`[6..8]`.
 *
 * Round-trips through {@link parseWorld} losslessly in value (not necessarily
 * byte-for-byte, since float formatting differs from the original editor's).
 *
 * @param entries - Placements to write (eg from {@link parseWorld} or `parsePlacements`).
 */
export function formatWorld(entries: Iterable<WorldPlacement>): string {
  const blocks: string[] = []
  for (const entry of entries) {
    const r = entry.rotation
    const {x, y, z} = entry.position
    blocks.push(
      [
        `${entry.kind ?? 'Name'}:${entry.name}`,
        `Translation: ${x},${y},${z}`,
        `Dof: ${r[0] ?? 1} ${r[1] ?? 0} ${r[2] ?? 0}`,
        `Up: ${r[3] ?? 0} ${r[4] ?? 1} ${r[5] ?? 0}`,
        `Right: ${r[6] ?? 0} ${r[7] ?? 0} ${r[8] ?? 1}`,
      ].join('\r\n'),
    )
  }
  return blocks.join('\r\n') + '\r\n'
}
