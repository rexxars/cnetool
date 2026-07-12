import type {Placement} from './types.ts'

const decoder = new TextDecoder('latin1')

// A record is real iff its name field holds a non-empty NUL-terminated run of
// printable ASCII (instance names are 7-bit: "sebguard_01", "Tree1_48", …).
function isPrintableAscii(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false
  for (const b of bytes) {
    if (b < 0x20 || b > 0x7e) return false
  }
  return true
}

const RECORD_LENGTH = 80
const NAME_FIELD_LENGTH = 28
const MARKER_OFFSET = 28 // a constant class/vtable pointer, one per record
const POSITION_OFFSET = 32
const ROTATION_OFFSET = 44

/**
 * Parse the object placements from a level's `data1.bin`: a packed array of
 * fixed 80-byte records, each a name, a world `position` (3 float32) and a
 * row-major 3×3 `rotation` matrix.
 *
 * Records are validated structurally (a NUL-terminated printable name), so
 * all-zero/garbage slots are skipped. The class-pointer `marker` at offset 28
 * is ignored - it's a stale per-file heap pointer the engine never reads, and
 * it isn't even constant within a file (the unofficial 1.42 patch appended
 * `sebguard` records with a different marker than the rest). Strip the trailing
 * `_NN` from a name to get its `objects.dat` project (eg `aagun3_03` → `aagun3`).
 *
 * Note: `data1.bin` appears to be level-editor placement data (the shipped
 * engine prefers `World.DAT` when present); positions/rotations match the
 * level terrain.
 *
 * @param data - Raw `data1.bin` bytes.
 */
export function parsePlacements(data: Uint8Array): Placement[] {
  if (data.byteLength < RECORD_LENGTH) return []
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  const placements: Placement[] = []
  for (let base = 0; base + RECORD_LENGTH <= data.byteLength; base += RECORD_LENGTH) {
    const field = data.subarray(base, base + NAME_FIELD_LENGTH)
    const nul = field.indexOf(0)
    if (nul === 0 || !isPrintableAscii(field.subarray(0, nul === -1 ? NAME_FIELD_LENGTH : nul))) {
      continue
    }
    const name = decoder.decode(nul === -1 ? field : field.subarray(0, nul))

    const position = {
      x: view.getFloat32(base + POSITION_OFFSET, true),
      y: view.getFloat32(base + POSITION_OFFSET + 4, true),
      z: view.getFloat32(base + POSITION_OFFSET + 8, true),
    }
    const rotation: number[] = []
    for (let i = 0; i < 9; i++) rotation.push(view.getFloat32(base + ROTATION_OFFSET + i * 4, true))

    placements.push({name, position, rotation})
  }
  return placements
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1]

/** Options for {@link serializePlacements}. */
export interface SerializePlacementsOptions {
  /**
   * The 4-byte `marker` written at offset 28 of every record. In shipped files this is a
   * stale per-file heap/vtable pointer (it varies between levels, and is `0` in some, e.g.
   * `Level6`), which the parser auto-detects rather than relies on - so it's treated as
   * don't-care. Defaults to `0`.
   */
  marker?: number
}

/**
 * Serialize placements into a `data1.bin` byte array - the inverse of
 * {@link parsePlacements}. Writes one fixed 80-byte record per placement: a NUL-padded
 * 28-byte name, the `marker`, the world `position` (3 float32) and the row-major 3×3
 * `rotation` matrix. Round-trips through {@link parsePlacements} exactly (float32 in/out).
 *
 * Names longer than 28 bytes are truncated; a `rotation` with fewer than 9 entries is
 * filled from the identity matrix.
 *
 * @param placements - Placements to write (eg from `parseWorld` or {@link parsePlacements}).
 * @param options - {@link SerializePlacementsOptions}.
 */
export function serializePlacements(
  placements: readonly Placement[],
  options: SerializePlacementsOptions = {},
): Uint8Array {
  const marker = options.marker ?? 0
  const out = new Uint8Array(placements.length * RECORD_LENGTH)
  const view = new DataView(out.buffer)
  const encoder = new TextEncoder()

  placements.forEach((placement, index) => {
    const base = index * RECORD_LENGTH
    out.set(encoder.encode(placement.name).subarray(0, NAME_FIELD_LENGTH), base)
    view.setUint32(base + MARKER_OFFSET, marker, true)
    view.setFloat32(base + POSITION_OFFSET, placement.position.x, true)
    view.setFloat32(base + POSITION_OFFSET + 4, placement.position.y, true)
    view.setFloat32(base + POSITION_OFFSET + 8, placement.position.z, true)
    for (let i = 0; i < 9; i++) {
      view.setFloat32(base + ROTATION_OFFSET + i * 4, placement.rotation[i] ?? IDENTITY[i]!, true)
    }
  })
  return out
}
