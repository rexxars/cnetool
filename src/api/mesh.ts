import type {Mesh, MeshFace, Placement, RgbColor, Vector3} from './types.ts'

const EDGE_TABLE_STRIDE = 5 // bytes per entry in the skipped precomputed edge table
const MATERIAL_LENGTH = 8
const UNTEXTURED = 0xffff

/**
 * Which level-of-detail layer {@link parseMesh} returns. Layers are ordered
 * highest-detail first, so `'high'` = layer 0, `'low'` = the last, `'medium'` =
 * the middle, or pass a 0-based index. Any value is clamped to the layers present
 * (projects ship 1-3 layers).
 */
export type MeshLod = number | 'high' | 'medium' | 'low'

export interface ParseMeshOptions {
  /** Which LOD layer to return. Default `'high'` (the highest-detail layer). */
  lod?: MeshLod
}

/**
 * Parse an `objects.dat` "project" blob into a 3D mesh.
 *
 * A project is a **level-of-detail chain**: `uint32 nv` + `nv` vertex triplets,
 * then one or more layers that are the same model at decreasing detail (high →
 * medium → low), each indexing its own slice of the shared vertex array. By
 * default the **highest-detail layer** is returned; rendering the rest would
 * overlay lower-poly copies as artifacts. Use {@link ParseMeshOptions.lod} to pick
 * another, or {@link parseMeshLayers} to get them all.
 *
 * Each layer is a skipped precomputed edge table (`nEdges` × 5 bytes), then
 * `nFaces` polygons; each face is `uint8 nv`, skipped edge indices (`nv` × uint16),
 * `nv` vertex indices (uint16), an 8-byte material (RGB + flags + uint16 texId),
 * and - when textured - `nv` UV pairs (float32).
 *
 * @param blob - Raw project bytes (eg from `extractFile`).
 * @param options - See {@link ParseMeshOptions}.
 */
export function parseMesh(blob: Uint8Array, options: ParseMeshOptions = {}): Mesh {
  const lod = options.lod ?? 'high'
  // Fast path: the common case only needs the first (highest-detail) layer.
  if (lod === 'high' || lod === 0) {
    return parseMeshLayers(blob, 1)[0] ?? {vertices: [], faces: []}
  }
  const layers = parseMeshLayers(blob)
  if (layers.length === 0) return {vertices: [], faces: []}
  const index =
    lod === 'low'
      ? layers.length - 1
      : lod === 'medium'
        ? Math.floor((layers.length - 1) / 2)
        : Math.min(Math.max(Math.trunc(lod), 0), layers.length - 1)
  return layers[index]!
}

/**
 * Parse every LOD layer of a project blob as a separate {@link Mesh}, ordered
 * highest-detail first (index 0 is what {@link parseMesh} returns by default).
 * Each returned mesh shares the project's full vertex array and carries only that
 * layer's faces.
 *
 * @param blob - Raw project bytes (eg from `extractFile`).
 * @param limit - Stop after this many layers (default: all).
 */
export function parseMeshLayers(blob: Uint8Array, limit = Infinity): Mesh[] {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
  const end = blob.byteLength
  let offset = 0

  const need = (bytes: number): boolean => offset + bytes <= end
  const u32 = (): number => {
    const value = view.getUint32(offset, true)
    offset += 4
    return value
  }
  const u16 = (): number => {
    const value = view.getUint16(offset, true)
    offset += 2
    return value
  }
  const u8 = (): number => view.getUint8(offset++)
  const f32 = (): number => {
    const value = view.getFloat32(offset, true)
    offset += 4
    return value
  }

  if (!need(4)) return []
  const vertexCount = u32()
  const vertices: Vector3[] = []
  for (let i = 0; i < vertexCount && need(12); i++) {
    vertices.push({x: f32(), y: f32(), z: f32()})
  }

  const layers: Mesh[] = []
  while (layers.length < limit && need(8)) {
    const edgeCount = u32()
    offset += edgeCount * EDGE_TABLE_STRIDE // skip the precomputed edge table
    if (!need(4)) break
    const faceCount = u32()
    if (faceCount === 0) break

    const faces: MeshFace[] = []
    let desynced = false
    for (let f = 0; f < faceCount && need(1); f++) {
      const faceVerts = u8()
      if (faceVerts === 0) {
        desynced = true // corrupt / past the real layers
        break
      }
      offset += faceVerts * 2 // skip per-face edge indices
      if (!need(faceVerts * 2 + MATERIAL_LENGTH)) {
        desynced = true
        break
      }

      const indices: number[] = []
      let valid = true
      for (let k = 0; k < faceVerts; k++) {
        const idx = u16()
        if (idx >= vertices.length) valid = false
        indices.push(idx)
      }
      // An out-of-range index means we've run into trailing bytes past the real
      // layers - stop rather than emit garbage geometry.
      if (!valid) {
        desynced = true
        break
      }

      const color = {r: u8(), g: u8(), b: u8()}
      const alpha = (255 - u8()) & 0xff // stored inverted: 0 -> opaque
      const flags = u8()
      offset += 1 // padding byte
      const rawTexId = u16()
      const texId = rawTexId === UNTEXTURED ? null : rawTexId

      let uv: Array<[number, number]> | null = null
      if (texId !== null) {
        if (!need(faceVerts * 8)) {
          desynced = true
          break
        }
        uv = []
        for (let k = 0; k < faceVerts; k++) uv.push([f32(), f32()])
      }

      faces.push({vertices: indices, color, alpha, flags, texId, uv})
    }

    if (faces.length > 0) layers.push({vertices, faces: dropRedundantFaces(faces)})
    if (desynced) break
  }

  return layers
}

/**
 * Offset where the render-LOD chain (the first mesh group) ends - i.e. where a trailing
 * detect/collision mesh begins, or the blob length if there's none. The LOD layers
 * share one vertex array and index into it; the next group has its own `vertexCount`
 * and directly follows, so the chain ends at the first "layer" whose faces don't index
 * the shared vertices (a fresh `vertexCount` misreads as a bad layer), at a `0`
 * face-count terminator, or at EOF.
 */
function lodChainEnd(blob: Uint8Array, view: DataView): number {
  const len = blob.byteLength
  if (len < 4) return len
  const vertexCount = view.getUint32(0, true)
  let o = 4 + vertexCount * 12
  if (o > len) return len
  while (o + 8 <= len) {
    const layerStart = o
    const edgeCount = view.getUint32(o, true)
    o += 4 + edgeCount * EDGE_TABLE_STRIDE
    if (o + 4 > len) return layerStart
    const faceCount = view.getUint32(o, true)
    o += 4
    if (faceCount === 0) return o // clean terminator
    let valid = true
    for (let f = 0; f < faceCount && valid; f++) {
      if (o >= len) {
        valid = false
        break
      }
      const faceVerts = blob[o]!
      o += 1 + faceVerts * 2 // face-vert count + skipped per-face edge indices
      if (faceVerts === 0 || o + faceVerts * 2 + MATERIAL_LENGTH > len) {
        valid = false
        break
      }
      for (let k = 0; k < faceVerts; k++) {
        if (view.getUint16(o, true) >= vertexCount) valid = false
        o += 2
      }
      o += 6 // rgb + alpha + flags + pad
      const texId = view.getUint16(o, true)
      o += 2
      if (texId !== UNTEXTURED) o += faceVerts * 8 // uvs
    }
    if (!valid) return layerStart // a fresh vertexCount → the detect mesh starts here
  }
  return len
}

/**
 * Parse a project's **detect/collision mesh** - the low-poly hull the build tool
 * (PACKETOR's `<detect>` input) appends after the render LODs. It's a separate mesh
 * group, with its own vertices, following the LOD chain. Returns `null` when the
 * project has none (eg simple/static entries).
 *
 * @param blob - a project blob from `objects.dat` (same input as {@link parseMesh}).
 */
export function parseDetectMesh(blob: Uint8Array): Mesh | null {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
  const start = lodChainEnd(blob, view)
  if (start <= 0 || start + 8 > blob.byteLength) return null
  return parseMeshLayers(blob.subarray(start), 1)[0] ?? null
}

function isSubset(a: Set<number>, b: Set<number>): boolean {
  for (const v of a) if (!b.has(v)) return false
  return true
}

/**
 * Drop degenerate and redundant faces: those with fewer than three distinct
 * vertices (zero area), and slivers whose vertex set is wholly contained in a
 * larger face. The game's models carry a few such coplanar duplicates (eg a
 * wheel disc that also stores an inward-wound sub-triangle with out-of-range
 * UVs); rendered double-sided in-engine they're harmless, but exported to a
 * single-sided viewer they z-fight the real face and read as a flickering
 * "spiral" overlay. Comparisons are limited to faces sharing a candidate's first
 * vertex, since any containing face must include it.
 */
function dropRedundantFaces(faces: MeshFace[]): MeshFace[] {
  const sets = faces.map((f) => new Set(f.vertices))
  const byVertex = new Map<number, number[]>()
  sets.forEach((set, i) => {
    for (const v of set) {
      const list = byVertex.get(v)
      if (list) list.push(i)
      else byVertex.set(v, [i])
    }
  })
  const drop = new Set<number>()
  for (let i = 0; i < faces.length; i++) {
    if (sets[i]!.size < 3) {
      drop.add(i)
      continue
    }
    for (const j of byVertex.get(faces[i]!.vertices[0]!) ?? []) {
      if (j === i || drop.has(j)) continue
      // Only strictly larger faces, so we drop the sliver - never an equal-size
      // exact duplicate, which may be an intentional opposite-wound backface.
      if (sets[j]!.size > sets[i]!.size && isSubset(sets[i]!, sets[j]!)) {
        drop.add(i)
        break
      }
    }
  }
  return drop.size === 0 ? faces : faces.filter((_, i) => !drop.has(i))
}

/**
 * Target up-axis for an exported mesh. The game stores models with **−Y as up**,
 * so the default `'y'` flips them vertically to a conventional upright **Y-up**;
 * `'z'` orients to **Z-up** (Blender / Unreal); `'raw'` leaves the data untouched
 * (−Y-up, as stored). Reflecting transforms also reverse face winding so normals
 * stay outward.
 */
export type ObjUp = 'y' | 'z' | 'raw'

const REORIENT: Record<ObjUp, {map: (v: Vector3) => Vector3; flipsWinding: boolean}> = {
  y: {map: (v) => ({x: v.x, y: -v.y, z: v.z}), flipsWinding: true}, // −Y-up → Y-up (reflection)
  z: {map: (v) => ({x: v.x, y: v.z, z: -v.y}), flipsWinding: false}, // −Y-up → Z-up (rotation)
  raw: {map: (v) => v, flipsWinding: false}, // as stored (−Y-up)
}

/**
 * Return a copy of `mesh` re-oriented to the given up-axis (see {@link ObjUp}).
 * For reflecting transforms, face winding (and per-vertex UVs) are reversed so
 * normals keep pointing outward.
 */
export function orientMesh(mesh: Mesh, up: ObjUp): Mesh {
  const {map, flipsWinding} = REORIENT[up]
  const vertices = mesh.vertices.map(map)
  if (!flipsWinding) return {vertices, faces: mesh.faces}
  const faces = mesh.faces.map((face) => ({
    ...face,
    vertices: face.vertices.toReversed(),
    uv: face.uv ? face.uv.toReversed() : null,
  }))
  return {vertices, faces}
}

export interface MeshToObjOptions {
  /** Optional object name (`o` line). */
  name?: string
  /** Emit a `mtllib` reference and group faces with `usemtl` (requires `material`). */
  mtllib?: string
  /** Map a face to a material name, or `null` to leave it unassigned. */
  material?: (face: MeshFace) => string | null
  /** Up-axis of the export (default `'y'`, upright Y-up - the game stores −Y-up). See {@link ObjUp}. */
  up?: ObjUp
}

/**
 * Serialize a {@link Mesh} to Wavefront OBJ text. UV coordinates are emitted
 * per face-vertex (`v/vt` references) when present. When `material` and `mtllib`
 * are given, faces are grouped with `usemtl` so the mesh imports textured.
 */
export function meshToObj(mesh: Mesh, options: MeshToObjOptions = {}): string {
  const oriented = orientMesh(mesh, options.up ?? 'y')
  const head: string[] = []
  if (options.mtllib) head.push(`mtllib ${options.mtllib}`)
  if (options.name) head.push(`o ${options.name}`)

  const vertexLines = oriented.vertices.map((v) => `v ${v.x} ${v.y} ${v.z}`)

  const texcoords: string[] = []
  const faceLines: string[] = []
  let currentMaterial: string | null = null
  for (const face of oriented.faces) {
    if (options.material) {
      const material = options.material(face)
      if (material && material !== currentMaterial) {
        faceLines.push(`usemtl ${material}`)
        currentMaterial = material
      }
    }
    const refs = face.vertices.map((vertexIndex, k) => {
      if (face.uv) {
        const [u, vCoord] = face.uv[k]!
        texcoords.push(`vt ${u} ${vCoord}`)
        return `${vertexIndex + 1}/${texcoords.length}`
      }
      return `${vertexIndex + 1}`
    })
    faceLines.push(`f ${refs.join(' ')}`)
  }

  return [...head, ...vertexLines, ...texcoords, ...faceLines].join('\n') + '\n'
}

/** Build the per-layer edge table from faces (the inverse of what {@link parseMesh} skips). */
function buildEdgeTable(faces: MeshFace[]): {
  edges: {va: number; vb: number; shares: number}[]
  faceEdges: number[][]
} {
  const edges: {va: number; vb: number; shares: number}[] = []
  const index = new Map<string, number>()
  const faceEdges: number[][] = []
  for (const face of faces) {
    const v = face.vertices
    const fe: number[] = []
    for (let i = 0; i < v.length; i++) {
      const a = v[i]!
      const b = v[(i + 1) % v.length]!
      const key = a < b ? `${a},${b}` : `${b},${a}`
      let idx = index.get(key)
      if (idx === undefined) {
        idx = edges.length
        edges.push({va: a, vb: b, shares: 1}) // mirrors PACKETOR: new edge starts at 1…
        index.set(key, idx)
      } else {
        edges[idx]!.shares = Math.min(255, edges[idx]!.shares + 1) // …+1 each time the pair recurs
      }
      fe.push(idx)
    }
    faceEdges.push(fe)
  }
  return {edges, faceEdges}
}

/** The number of render LOD layers a project always carries (engine reads exactly this many). */
const RENDER_LAYERS = 3

/** Return `faces` with every vertex index shifted by `base` (for sharing one vertex array). */
function offsetFaces(faces: MeshFace[], base: number): MeshFace[] {
  if (base === 0) return faces
  return faces.map((face) => ({...face, vertices: face.vertices.map((i) => i + base)}))
}

/** Options for {@link serializeMesh}. */
export interface SerializeMeshOptions {
  /**
   * Additional, **lower-detail render layers** after the primary `mesh` (which is the
   * highest-detail layer 0), in decreasing-detail order. A project always carries exactly
   * {@link RENDER_LAYERS} render layers, so any not supplied here are padded by repeating
   * the lowest-detail one - mirroring how the shipped data triplicates simple models, so an
   * object never renders empty at distance. At most three layers total (`mesh` + two `lods`);
   * more throws.
   */
  lods?: Mesh[]
  /** A collision/detect hull written after the render layers (see {@link parseDetectMesh}). */
  detect?: Mesh
}

/**
 * Serialize a {@link Mesh} to an `objects.dat` **project blob** - the inverse of
 * {@link parseMesh}. Round-trips through {@link parseMesh}/{@link parseMeshLayers}/
 * {@link parseDetectMesh}.
 *
 * The on-disk layout the engine's loader (`FUN_00480b60`) expects is fixed: a leading
 * vertex array shared by **three render LOD layers**, then a **second vertex array** for a
 * fourth detect/collision layer. Every shipped project has this shape - simple models just
 * repeat one mesh across all three render layers (and leave the detect layer empty). So a
 * single `mesh` is written to all three render slots; pass {@link SerializeMeshOptions.lods}
 * for genuine decreasing-detail layers and {@link SerializeMeshOptions.detect} for the hull.
 * The three render layers share one vertex array (each layer's faces index its own slice).
 *
 * Each layer's edge table is regenerated from face topology (the format requires it present
 * so the loader can step to the faces). The per-edge 5th byte ("shares") is a face-share
 * count - PACKETOR derives the same value plus extra passes, so this is not byte-exact to
 * PACKETOR but is structurally valid; the engine recomputes normals from vertices+faces at
 * load. Pair with `buildArchive` to add the project to `objects.dat`.
 *
 * @param mesh - the highest-detail render mesh (LOD layer 0).
 * @param options - extra LOD layers and/or a detect hull.
 */
export function serializeMesh(mesh: Mesh, options: SerializeMeshOptions = {}): Uint8Array {
  const out: number[] = []
  const u8 = (v: number): void => void out.push(v & 0xff)
  const u16 = (v: number): void => void out.push(v & 0xff, (v >> 8) & 0xff)
  const u32 = (v: number): void => {
    u16(v & 0xffff)
    u16((v >>> 16) & 0xffff)
  }
  const f32 = (v: number): void => {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setFloat32(0, v, true)
    out.push(...b)
  }

  const writeVertices = (vertices: Vector3[]): void => {
    u32(vertices.length)
    for (const v of vertices) {
      f32(v.x)
      f32(v.y)
      f32(v.z)
    }
  }

  const writeLayer = (faces: MeshFace[]): void => {
    const {edges, faceEdges} = buildEdgeTable(faces)
    u32(edges.length)
    for (const e of edges) {
      u16(e.va)
      u16(e.vb)
      u8(e.shares)
    }
    u32(faces.length)
    faces.forEach((face, fi) => {
      u8(face.vertices.length)
      for (const ei of faceEdges[fi]!) u16(ei) // per-face edge indices
      for (const vi of face.vertices) u16(vi) // vertex indices
      u8(face.color.r)
      u8(face.color.g)
      u8(face.color.b)
      u8((255 - face.alpha) & 0xff) // stored inverted
      u8(face.flags)
      u8(0) // padding
      u16(face.texId ?? UNTEXTURED)
      if (face.texId !== null && face.uv)
        for (const [u, v] of face.uv) {
          f32(u)
          f32(v)
        }
    })
  }

  const layers = [mesh, ...(options.lods ?? [])]
  if (layers.length > RENDER_LAYERS) {
    throw new RangeError(
      `a project holds at most ${RENDER_LAYERS} render LOD layers, got ${layers.length}`,
    )
  }
  while (layers.length < RENDER_LAYERS) layers.push(layers[layers.length - 1]!) // pad w/ lowest detail

  // The three render layers share one vertex array; a repeated layer reuses its slice
  // (so a triplicated single mesh writes its vertices once, like the shipped data).
  const sharedVertices: Vector3[] = []
  const baseOf = new Map<Mesh, number>()
  const layerFaces = layers.map((layer) => {
    let base = baseOf.get(layer)
    if (base === undefined) {
      base = sharedVertices.length
      sharedVertices.push(...layer.vertices)
      baseOf.set(layer, base)
    }
    return offsetFaces(layer.faces, base)
  })

  writeVertices(sharedVertices)
  for (const faces of layerFaces) writeLayer(faces)

  // The detect/collision hull is a fourth layer with its own vertex array (empty when absent).
  writeVertices(options.detect?.vertices ?? [])
  writeLayer(options.detect?.faces ?? [])

  return Uint8Array.from(out)
}

/** Map a `usemtl` name to a texture id (`tex7` → 7), or `null` for an untextured material. */
const defaultMaterialId = (name: string): number | null => {
  const m = /^tex(\d+)$/.exec(name)
  return m ? Number(m[1]) : null
}

/** Quantise a 0..1 MTL colour/opacity component to an integer 0..255. */
const toByte = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)))

/** Parse a Wavefront MTL into per-material diffuse colour/opacity (the inverse of {@link buildMtl}). */
function parseMtl(text: string): Map<string, {color: RgbColor; alpha: number}> {
  const map = new Map<string, {color: RgbColor; alpha: number}>()
  let current: {color: RgbColor; alpha: number} | null = null
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    if (parts[0] === 'newmtl') {
      current = {color: {r: 255, g: 255, b: 255}, alpha: 255}
      map.set(parts.slice(1).join(' '), current)
    } else if (!current) continue
    else if (parts[0] === 'Kd')
      current.color = {
        r: toByte(Number(parts[1])),
        g: toByte(Number(parts[2])),
        b: toByte(Number(parts[3])),
      }
    else if (parts[0] === 'd') current.alpha = toByte(Number(parts[1]))
    else if (parts[0] === 'Tr') current.alpha = toByte(1 - Number(parts[1]))
  }
  return map
}

/** Options for {@link objToMesh}. */
export interface ObjToMeshOptions {
  /** Up-axis the OBJ uses (default `'y'`, matching {@link meshToObj}); inverted back to −Y-up storage. */
  up?: ObjUp
  /** Map a `usemtl` name to a texture id (default recognises `tex<n>`); `null` = untextured. */
  material?: (name: string) => number | null
  /** Companion `.mtl` contents - when given, faces take their colour/opacity from each `usemtl`'s `Kd`/`d`. */
  mtl?: string
}

/**
 * Resolve an OBJ index reference (1-based, negatives relative to the end) to a 0-based index.
 */
const resolveObjIndex = (n: number, len: number): number => (n < 0 ? len + n : n - 1)

/**
 * Parse Wavefront OBJ text into a {@link Mesh} - the inverse of {@link meshToObj}, so
 * an object can round-trip out to OBJ, be edited (eg in Blender), and come back. Reads
 * `v`/`vt`/`f` and `usemtl`; faces default to opaque raw-colour white (OBJ carries no
 * per-face colour), textured when a `usemtl` resolves to a texId and the face has UVs.
 * Polygons are kept as-is. Feed the result to {@link serializeMesh} → `buildArchive` to
 * import it into `objects.dat`.
 *
 * @param text - OBJ file contents.
 * @param options - up-axis and material mapping.
 */
export function objToMesh(text: string, options: ObjToMeshOptions = {}): Mesh {
  const up = options.up ?? 'y'
  const materialId = options.material ?? defaultMaterialId
  const mtl = options.mtl ? parseMtl(options.mtl) : null
  const vertices: Vector3[] = []
  const uvs: Array<[number, number]> = []
  const faces: MeshFace[] = []
  let texId: number | null = null
  let color: RgbColor = {r: 255, g: 255, b: 255}
  let alpha = 255

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    const tag = parts[0]
    if (tag === 'v') vertices.push({x: Number(parts[1]), y: Number(parts[2]), z: Number(parts[3])})
    else if (tag === 'vt') uvs.push([Number(parts[1]), Number(parts[2] ?? 0)])
    else if (tag === 'usemtl') {
      const name = parts.slice(1).join(' ')
      texId = materialId(name)
      const mat = mtl?.get(name)
      color = mat?.color ?? {r: 255, g: 255, b: 255} // Kd, or white when unknown
      alpha = mat?.alpha ?? 255
    } else if (tag === 'f') {
      const vIdx: number[] = []
      const faceUv: Array<[number, number]> = []
      let hasUv = true
      for (const ref of parts.slice(1)) {
        const [vRef, vtRef] = ref.split('/')
        vIdx.push(resolveObjIndex(Number(vRef), vertices.length))
        if (vtRef) faceUv.push(uvs[resolveObjIndex(Number(vtRef), uvs.length)] ?? [0, 0])
        else hasUv = false
      }
      const textured = texId !== null && hasUv && faceUv.length === vIdx.length
      faces.push({
        vertices: vIdx,
        color: {...color},
        alpha,
        flags: 0x04, // use raw colour (so an untextured face shows its Kd colour as-is)
        texId: textured ? texId : null,
        uv: textured ? faceUv : null,
      })
    }
  }

  const mesh: Mesh = {vertices, faces}
  if (up === 'raw') return mesh
  if (up === 'y') return orientMesh(mesh, 'y') // the Y reflection is its own inverse
  // 'z': invert orientMesh's (x, z, −y) rotation → (x, −z, y)
  return {vertices: vertices.map((v) => ({x: v.x, y: -v.z, z: v.y})), faces}
}

/**
 * Apply a placement (3×3 rotation + translation) to a mesh's vertices,
 * returning a new mesh that shares the original faces.
 *
 * The stored matrix follows the engine's (DirectX) row-vector convention, so a
 * vertex is transformed as `v · M` - i.e. using the matrix columns. (Applying it
 * the other way leaves symmetric rotations like 0°/180° correct but flips the
 * direction of 90°/270° ones.)
 */
export function transformMesh(
  mesh: Mesh,
  placement: Pick<Placement, 'position' | 'rotation'>,
): Mesh {
  const [a = 1, b = 0, c = 0, d = 0, e = 1, f = 0, g = 0, h = 0, i = 1] = placement.rotation
  const {x: tx, y: ty, z: tz} = placement.position
  const vertices = mesh.vertices.map((v) => ({
    x: a * v.x + d * v.y + g * v.z + tx,
    y: b * v.x + e * v.y + h * v.z + ty,
    z: c * v.x + f * v.y + i * v.z + tz,
  }))
  return {vertices, faces: mesh.faces}
}

/**
 * Row-major 3×3 rotation about the vertical (Y) axis by `degrees`, in the form
 * {@link transformMesh}/{@link Placement} expect. Used to yaw a part (eg a steered
 * front wheel) before applying its body-local offset.
 */
export function yawRotation(degrees: number): number[] {
  const t = (degrees * Math.PI) / 180
  const c = Math.cos(t)
  const s = Math.sin(t)
  return [c, 0, -s, 0, 1, 0, s, 0, c]
}

export interface MeshesToObjOptions {
  /** Emit a `mtllib` reference and group faces with `usemtl` (requires `material`). */
  mtllib?: string
  /** Map a face to a material name, or `null` to leave it unassigned. */
  material?: (face: MeshFace) => string | null
  /** Up-axis of the export (default `'y'`, upright Y-up - the game stores −Y-up). See {@link ObjUp}. */
  up?: ObjUp
}

/** A named mesh for {@link meshesToObj}. */
export interface MeshesToObjItem {
  name: string
  mesh: Mesh
  /**
   * Per-item face → material name resolver, overriding the call-level
   * `material`. Use when items come from different texture-table namespaces (eg
   * meshes drawn from `objects.dat` vs `OBJECTS2.DAT`).
   */
  material?: (face: MeshFace) => string | null
}

/**
 * Serialize several named meshes into one Wavefront OBJ, each under its own `o`
 * group with globally-correct vertex and texcoord indices - for assembling a
 * whole level scene. With `material`/`mtllib`, UVs and `usemtl` groups are
 * emitted so the scene imports textured.
 */
export function meshesToObj(
  items: Array<MeshesToObjItem>,
  options: MeshesToObjOptions = {},
): string {
  const head: string[] = []
  if (options.mtllib) head.push(`mtllib ${options.mtllib}`)

  const up = options.up ?? 'y'
  const body: string[] = []
  let vertexBase = 0
  let texcoordBase = 0
  for (const {name, mesh: rawMesh, material: itemMaterial} of items) {
    const mesh = orientMesh(rawMesh, up)
    const resolveMaterial = itemMaterial ?? options.material
    body.push(`o ${name}`)
    for (const v of mesh.vertices) body.push(`v ${v.x} ${v.y} ${v.z}`)

    const texcoords: string[] = []
    const faceLines: string[] = []
    let currentMaterial: string | null = null
    for (const face of mesh.faces) {
      if (resolveMaterial) {
        const material = resolveMaterial(face)
        if (material && material !== currentMaterial) {
          faceLines.push(`usemtl ${material}`)
          currentMaterial = material
        }
      }
      const refs = face.vertices.map((idx, k) => {
        const vertex = idx + 1 + vertexBase
        if (face.uv) {
          const [u, vCoord] = face.uv[k]!
          texcoords.push(`vt ${u} ${vCoord}`)
          return `${vertex}/${texcoordBase + texcoords.length}`
        }
        return `${vertex}`
      })
      faceLines.push(`f ${refs.join(' ')}`)
    }

    body.push(...texcoords, ...faceLines)
    vertexBase += mesh.vertices.length
    texcoordBase += texcoords.length
  }

  return [...head, ...body].join('\n') + '\n'
}

/** A material for {@link buildMtl}. */
export interface MtlMaterial {
  name: string
  /** Diffuse texture image (`map_Kd`). */
  map?: string
  /**
   * Grayscale opacity image driving transparency (`map_d`): white = opaque, black =
   * transparent. Use for a color-keyed texture so renderers show the transparency
   * instead of the keyed-out background. Grayscale (rather than the RGBA texture) so it
   * reads correctly whether a viewer samples alpha, green, or luminance.
   */
  mask?: string
  /** Diffuse colour (0-255 per channel); written as `Kd` (defaults to white). */
  color?: RgbColor
  /** Opacity 0-255; written as `d` when below 255. */
  alpha?: number
}

/**
 * Build a Wavefront MTL (material library) from a list of materials, each with an
 * optional diffuse colour (`Kd`), opacity (`d`), texture image (`map_Kd`), and alpha
 * map (`map_d`). `Kd` values are written as 0-1 floats that {@link objToMesh} reads
 * back to the exact 0-255 channel value.
 */
export function buildMtl(materials: Iterable<MtlMaterial>): string {
  const blocks: string[] = []
  for (const {name, map, mask, color, alpha} of materials) {
    const c = color ?? {r: 255, g: 255, b: 255}
    const lines = [`newmtl ${name}`, `Kd ${c.r / 255} ${c.g / 255} ${c.b / 255}`]
    if (alpha !== undefined && alpha < 255) lines.push(`d ${alpha / 255}`)
    if (map) lines.push(`map_Kd ${map}`)
    // Grayscale opacity map (white opaque / black transparent) so a color-keyed texture's
    // keyed-out texels render transparent rather than as a black box.
    if (mask) lines.push(`map_d ${mask}`)
    blocks.push(lines.join('\n'))
  }
  return blocks.join('\n\n') + '\n'
}
