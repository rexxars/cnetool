import type {Mesh, Vector3} from './types.ts'

/**
 * A rigid transform an animation frame applies to an attached sub-part (eg the
 * motorcycle's front wheel): a position, a row-major 3×3 rotation, and a translation.
 */
export interface AnmTransform {
  position: Vector3
  /** Row-major 3×3 rotation (steering is a yaw about Y: `atan2(rotation[2], rotation[0])`). */
  rotation: number[]
  translation: Vector3
}

/** A decoded `.anm` vertex animation (eg `ANM\mc.anm`). */
export interface ParsedAnm {
  frameCount: number
  vertexCount: number
  /** Per-frame vertex positions (`frames[f][v]`), parallel to the project mesh's vertices. */
  frames: Vector3[][]
  /**
   * Per-frame trailer transform for the frame's attached sub-part, or `null` if the
   * frame has no trailer. For `mc.anm` this is the front wheel's pose, sweeping an arc
   * with yaw 120°→90°→60° (full-left → straight → full-right) across the steering range.
   */
  transforms: Array<AnmTransform | null>
}

/**
 * Parse a Codename Eagle `.anm` vertex animation. Header is three `u32`s
 * (`frameCount`, a kind/`1` field, `vertexCount`), then `frameCount` frames. Each frame
 * holds the project's vertex positions (3×`f32`, matching the mesh's vertex order - frame
 * 0 equals the base mesh) followed by a small trailer that's skipped; the frame stride is
 * derived from the file length so the trailer size doesn't need to be known.
 *
 * Used to recover a static rest pose for meshes the engine animates - eg the motorcycle's
 * `motobody`, whose front fork/handlebars are baked steered and straightened by a mid
 * animation frame (see `restPoses`).
 */
export function parseAnm(bytes: Uint8Array): ParsedAnm {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const frameCount = dv.getUint32(0, true)
  const vertexCount = dv.getUint32(8, true)
  if (frameCount <= 0 || vertexCount <= 0) throw new Error('not a valid .anm (bad header)')
  const HEADER = 12
  const stride = (bytes.byteLength - HEADER) / frameCount
  if (!Number.isInteger(stride) || stride < vertexCount * 12) {
    throw new Error(
      `.anm frame stride ${stride} inconsistent with ${frameCount} frames / ${vertexCount} verts`,
    )
  }
  const trailerBytes = stride - vertexCount * 12
  const frames: Vector3[][] = []
  const transforms: Array<AnmTransform | null> = []
  for (let f = 0; f < frameCount; f++) {
    const verts: Vector3[] = []
    let off = HEADER + f * stride
    for (let v = 0; v < vertexCount; v++) {
      verts.push({
        x: dv.getFloat32(off, true),
        y: dv.getFloat32(off + 4, true),
        z: dv.getFloat32(off + 8, true),
      })
      off += 12
    }
    frames.push(verts)
    // Trailer = [position (3f)][3×3 rotation (9f)][translation (3f)] for the attached part.
    if (trailerBytes >= 60) {
      const fl = (i: number): number => dv.getFloat32(off + i * 4, true)
      transforms.push({
        position: {x: fl(0), y: fl(1), z: fl(2)},
        rotation: [fl(3), fl(4), fl(5), fl(6), fl(7), fl(8), fl(9), fl(10), fl(11)],
        translation: {x: fl(12), y: fl(13), z: fl(14)},
      })
    } else {
      transforms.push(null)
    }
  }
  return {frameCount, vertexCount, frames, transforms}
}

/**
 * Return a copy of `mesh` with its vertices replaced by `frame`'s positions (faces kept).
 * The frame must have the same vertex count as the mesh (it's a re-pose of the same mesh).
 */
export function applyAnmFrame(mesh: Mesh, frame: Vector3[]): Mesh {
  if (frame.length !== mesh.vertices.length) {
    throw new Error(`anm frame has ${frame.length} verts, mesh has ${mesh.vertices.length}`)
  }
  return {vertices: frame.map((v) => ({x: v.x, y: v.y, z: v.z})), faces: mesh.faces}
}
