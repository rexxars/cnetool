import {controllableGeometry} from './controllable.ts'
import {extractFile} from './file.ts'
import {applyAnmFrame} from './anm.ts'
import {parseMesh, transformMesh, yawRotation} from './mesh.ts'
import {parseArchive} from './parse.ts'
import {parsePlacements} from './placement.ts'
import type {ArchiveEntry, ControllableGeometryMap, Mesh, Placement, Vector3} from './types.ts'

const decoder = new TextDecoder('latin1')

/** One named, world-placed mesh in an assembled level. */
export interface LevelSceneItem {
  name: string
  mesh: Mesh
  /**
   * Index of the object archive this geometry came from: `0` is the primary
   * `objects.dat`, `1+` are `extraObjects` in order. Lets the caller resolve a
   * face's `texId` against the right archive's texture table.
   */
  source: number
}

/** The result of {@link assembleLevel}. */
export interface LevelScene {
  /** Terrain (if any) followed by each placed object, transformed into world space. */
  items: LevelSceneItem[]
  /** Project names referenced by placements/terrain that had no usable mesh. */
  missing: string[]
}

/** Options for {@link assembleLevel}. */
export interface AssembleLevelOptions {
  /**
   * A level's object placements - either raw `data1.bin` bytes (parsed with
   * `parsePlacements`) or an already-parsed array (eg from `parseWorld`).
   */
  placements?: Uint8Array | Placement[]
  /** Terrain project name (eg `dm1`); see {@link readLandscape}. */
  terrain?: string | null
  /**
   * Additional object archives searched (in order, after the primary
   * `objects.dat`) when resolving a project's geometry - eg the 1.41 patch's
   * `OBJECTS2.DAT`, which holds the helicopter, zeppelin and battleship bodies.
   */
  extraObjects?: Uint8Array[]
  /**
   * Substitute body geometry for *controllable* objects (vehicles/turrets) whose
   * logical project is an empty stub - so they render instead of being dropped.
   * `true` uses the built-in {@link controllableGeometry} map; pass a custom
   * {@link ControllableGeometryMap} to override it (eg
   * `{...controllableGeometry, plane: ['…']}`). Default (`false`) leaves them as
   * empty stubs - appropriate for a real game, where the engine attaches them.
   */
  controllable?: boolean | ControllableGeometryMap
  /**
   * Rest-pose vertex frames for engine-animated projects (lowercased project name →
   * frame vertices), eg `motobody`'s straight steering frame from `mc.anm`. When a
   * resolved mesh's project has an entry (and the vertex counts match), its vertices are
   * replaced with the frame so the static export shows the rest pose. See
   * {@link restPoses} and `parseAnm`.
   */
  restFrames?: Map<string, Vector3[]>
}

/**
 * Assemble a level scene from `objects.dat`: optionally the terrain project, plus
 * every object in `data1.bin` positioned and rotated into world space. The
 * caller serializes the result with `meshesToObj`.
 *
 * @param objectsData - Raw `objects.dat` bytes.
 * @param options - Placements and/or terrain to include.
 */
export function assembleLevel(
  objectsData: Uint8Array,
  options: AssembleLevelOptions = {},
): LevelScene {
  const archives = [objectsData, ...(options.extraObjects ?? [])]
  const byName = archives.map((archive) => {
    const map = new Map<string, ArchiveEntry>()
    for (const entry of parseArchive(archive).entries) {
      if (!map.has(entry.name.toLowerCase())) map.set(entry.name.toLowerCase(), entry)
    }
    return map
  })

  const meshCache = new Map<string, {mesh: Mesh; source: number} | null>()
  const getMesh = (project: string): {mesh: Mesh; source: number} | null => {
    const key = project.toLowerCase()
    const cached = meshCache.get(key)
    if (cached !== undefined) return cached
    // Search each archive in order; take the first with usable (non-empty) geometry
    // so an empty stub in objects.dat falls through to a real mesh in OBJECTS2.DAT.
    let result: {mesh: Mesh; source: number} | null = null
    for (let source = 0; source < archives.length; source++) {
      const entry = byName[source]!.get(key)
      if (!entry) continue
      let mesh = parseMesh(extractFile(archives[source]!, entry))
      if (mesh.faces.length > 0) {
        const frame = options.restFrames?.get(key)
        if (frame && frame.length === mesh.vertices.length) mesh = applyAnmFrame(mesh, frame)
        result = {mesh, source}
        break
      }
    }
    meshCache.set(key, result)
    return result
  }

  const controllableSource =
    options.controllable === true ? controllableGeometry : options.controllable || null
  const controllable = controllableSource
    ? new Map(Object.entries(controllableSource).map(([key, parts]) => [key.toLowerCase(), parts]))
    : null

  const items: LevelSceneItem[] = []
  const missing = new Set<string>()

  if (options.terrain) {
    const found = getMesh(options.terrain)
    if (found)
      items.push({name: `terrain_${options.terrain}`, mesh: found.mesh, source: found.source})
    else missing.add(options.terrain)
  }

  if (options.placements) {
    const placements =
      options.placements instanceof Uint8Array
        ? parsePlacements(options.placements)
        : options.placements
    for (const placement of placements) {
      const project = placement.name.replace(/[._]?\d+$/, '')
      const found = getMesh(project)
      if (found) {
        items.push({
          name: placement.name,
          mesh: transformMesh(found.mesh, placement),
          source: found.source,
        })
        continue
      }

      // No direct geometry: if it's a known controllable (vehicle/turret) stub,
      // draw its body/parts at the placement's transform instead of dropping it.
      const parts = controllable?.get(project.toLowerCase())
      if (!parts) {
        missing.add(project)
        continue
      }

      let substituted = false
      for (const part of parts) {
        if (typeof part === 'string') {
          // Rigid part: drawn once at the placement.
          const found2 = getMesh(part)
          if (!found2) {
            missing.add(part)
            continue
          }
          items.push({
            name: `${placement.name}__${part}`,
            mesh: transformMesh(found2.mesh, placement),
            source: found2.source,
          })
          substituted = true
          continue
        }
        // Instanced part: a copy at each body-local offset, then placed.
        const found2 = getMesh(part.project)
        if (!found2) {
          missing.add(part.project)
          continue
        }
        part.at.forEach((offset, k) => {
          const suffix = part.at.length > 1 ? `#${k}` : ''
          // yaw the part about its own origin (if any), then offset, then world-place
          const local =
            part.yaw !== undefined
              ? transformMesh(found2.mesh, {position: offset, rotation: yawRotation(part.yaw)})
              : translateMesh(found2.mesh, offset)
          items.push({
            name: `${placement.name}__${part.project}${suffix}`,
            mesh: transformMesh(local, placement),
            source: found2.source,
          })
        })
        substituted = true
      }
      if (!substituted) missing.add(project)
    }
  }

  return {items, missing: [...missing]}
}

/** Return a copy of `mesh` with its vertices translated by `offset` (faces shared). */
function translateMesh(mesh: Mesh, offset: Vector3): Mesh {
  return {
    vertices: mesh.vertices.map((v) => ({x: v.x + offset.x, y: v.y + offset.y, z: v.z + offset.z})),
    faces: mesh.faces,
  }
}

const STRING_PUSH = 0x08 // .scr opcode: push string (u16 length + bytes incl NUL)

/**
 * Read the landscape (and horizon) project names from a level's `MAINSCR.SCR` -
 * the string arguments of its `REFSetLandscape` call. Returns `null` if the call
 * isn't found.
 *
 * @param script - Raw `MAINSCR.SCR` bytes.
 */
export function readLandscape(
  script: Uint8Array,
): {landscape: string; horizon: string | null} | null {
  const call = indexOfAscii(script, 'REFSetLandscape')
  if (call < 0) return null

  // The string arguments are pushed just before the call; collect the string
  // pushes in the preceding window and take the last two (landscape, horizon).
  const strings: string[] = []
  for (let p = Math.max(0, call - 64); p + 3 < call; p++) {
    if (script[p] !== STRING_PUSH) continue
    const length = script[p + 1]! | (script[p + 2]! << 8)
    if (length < 2 || length > 40 || p + 3 + length > call) continue
    const text = decoder.decode(script.subarray(p + 3, p + 3 + length - 1))
    if (/^[\x20-\x7e]+$/.test(text)) {
      strings.push(text)
      p += 2 + length // skip past this push
    }
  }
  if (strings.length === 0) return null

  return {
    landscape: strings[strings.length >= 2 ? strings.length - 2 : strings.length - 1]!,
    horizon: strings.length >= 2 ? strings[strings.length - 1]! : null,
  }
}

function indexOfAscii(data: Uint8Array, text: string): number {
  const first = text.charCodeAt(0)
  outer: for (let i = 0; i <= data.byteLength - text.length; i++) {
    if (data[i] !== first) continue
    for (let j = 1; j < text.length; j++) if (data[i + j] !== text.charCodeAt(j)) continue outer
    return i
  }
  return -1
}
