// @env node
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import {
  buildMtl,
  meshToObj,
  objToMesh,
  parseDetectMesh,
  parseMeshLayers,
  serializeMesh,
} from '../api/index.ts'
import type {Mesh, MeshFace, MeshFaceAttrs, MtlMaterial, RgbColor} from '../api/index.ts'

/**
 * The `$schema` reference written into each `project.json`. A project directory
 * lives at `source/objects/<archive>/<project>/` - four levels below the project
 * root, where `.cnetool/schemas/` sits - so the relative path climbs four dirs.
 */
const PROJECT_SCHEMA_REF = '../../../../.cnetool/schemas/project.schema.json'

/** Per-LOD OBJ filenames, highest-detail first (index maps to a render layer). */
const LOD_FILES = ['high.obj', 'medium.obj', 'low.obj']

/** The collision-hull OBJ filename. */
const DETECT_FILE = 'detect.obj'

/** The material library filename referenced by every OBJ's `mtllib`. */
const MTL_FILE = 'model.mtl'

/** One material entry in `project.json`: a face's fields OBJ can't carry. */
interface MaterialRecord {
  /** Source texture filename (from the archive texture table), or `null` if untextured. */
  texture: string | null
  /** Render-flags byte. */
  flags: number
  /** Diffuse colour as `[r, g, b]`, each 0-255. */
  color: [number, number, number]
  /** Opacity 0-255. */
  alpha: number
}

/**
 * Extract one `objects.dat` project blob into an editable directory: a `high.obj`
 * (+ `medium.obj`/`low.obj` for genuine extra render LODs), a `detect.obj`
 * collision hull when present, a `model.mtl`, and a `project.json` sidecar naming
 * the materials. Faces are grouped by their distinct `(texId, flags, color,
 * alpha)` tuple into `m0`, `m1`, … materials so every field survives the OBJ
 * round-trip that `meshToObj`/`objToMesh` alone can't carry.
 *
 * A blob with no render geometry (an empty stub / non-mesh entry) throws so the
 * caller can fall back to storing it as a raw blob.
 *
 * @param blob - Raw project bytes (one archive entry).
 * @param dir - Output directory (created if missing).
 * @param textureNames - The archive's texId → filename table (index = texId).
 * @param name - The original archive entry name (recorded in `project.json`).
 */
export async function extractMeshDir(
  blob: Uint8Array,
  dir: string,
  textureNames: string[],
  name: string,
): Promise<void> {
  const layers = parseMeshLayers(blob)
  if (layers.length === 0) throw new Error('blob has no render geometry (not a mesh project)')
  const detect = parseDetectMesh(blob)
  // Collapse the trailing render layers serializeMesh pads by repeating the
  // lowest-detail one, so a triplicated single mesh yields just `high.obj`.
  const distinct = collapseTrailingDuplicates(layers)

  // Assign m0, m1, … to each distinct face tuple in first-appearance order
  // (render layers high→low, then the detect hull).
  const materials = new Map<string, {name: string; record: MaterialRecord}>()
  const nameFor = (face: MeshFace): string => {
    const key = tupleKey(face)
    let material = materials.get(key)
    if (!material) {
      material = {name: `m${materials.size}`, record: materialRecord(face, textureNames)}
      materials.set(key, material)
    }
    return material.name
  }
  for (const face of distinct.flatMap((layer) => layer.faces)) nameFor(face)
  if (detect) for (const face of detect.faces) nameFor(face)

  // Derive every file's bytes BEFORE touching the filesystem, so any failure
  // (bad geometry, etc) throws with nothing written - no orphaned partial dir.
  const files: Array<{file: string; content: string}> = []
  for (let i = 0; i < distinct.length; i++) {
    const obj = meshToObj(sliceLayer(distinct[i]!), {
      up: 'raw',
      mtllib: MTL_FILE,
      material: nameFor,
    })
    files.push({file: LOD_FILES[i]!, content: obj})
  }
  if (detect) {
    const obj = meshToObj(sliceLayer(detect), {up: 'raw', mtllib: MTL_FILE, material: nameFor})
    files.push({file: DETECT_FILE, content: obj})
  }

  const mtlMaterials: MtlMaterial[] = [...materials.values()].map(({name: mName, record}) => {
    const material: MtlMaterial = {name: mName, color: colorOf(record.color), alpha: record.alpha}
    if (record.texture !== null) material.map = record.texture
    return material
  })
  files.push({file: MTL_FILE, content: buildMtl(mtlMaterials)})

  const materialsJson: Record<string, MaterialRecord> = {}
  for (const {name: mName, record} of materials.values()) materialsJson[mName] = record
  // `name` here is informational; on rebuild the authoritative entry name comes
  // from the archive's entries.json, not from project.json.
  const document = {$schema: PROJECT_SCHEMA_REF, name, materials: materialsJson}
  files.push({file: 'project.json', content: `${JSON.stringify(document, null, 2)}\n`})

  await mkdir(dir, {recursive: true})
  for (const {file, content} of files) await writeFile(join(dir, file), content)
}

/**
 * Reassemble a project blob from a directory produced by {@link extractMeshDir},
 * the inverse operation. Reads `project.json` for the material tuples, the present
 * LOD OBJs (`high`/`medium`/`low`) and the `detect.obj` hull, rebuilds each layer
 * with `objToMesh`, and serializes them. For a clean cetool-authored mesh this is
 * byte-identical to the extracted blob; for a shipped mesh it is geometrically
 * faithful (see `docs/formats.md`).
 *
 * @param dir - A project directory.
 * @param textureNames - The archive's texId → filename table (index = texId), for
 *   resolving each material's `texture` name back to a texId.
 */
export async function buildMeshDir(dir: string, textureNames: string[]): Promise<Uint8Array> {
  const materials = await readProjectMaterials(dir, textureNames)
  const attrsFor = (materialName: string): MeshFaceAttrs =>
    materials.get(materialName) ?? UNTEXTURED

  const lods: Mesh[] = []
  for (const file of LOD_FILES) {
    const text = await readFileOrNull(join(dir, file))
    if (text !== null) lods.push(objToMesh(text, {up: 'raw', material: attrsFor}))
  }
  if (lods.length === 0) throw new Error(`no ${LOD_FILES[0]} in ${dir}`)

  const detectText = await readFileOrNull(join(dir, DETECT_FILE))
  const detect =
    detectText === null ? undefined : objToMesh(detectText, {up: 'raw', material: attrsFor})

  const [base, ...rest] = lods
  return serializeMesh(base!, detect ? {lods: rest, detect} : {lods: rest})
}

/** Fallback face attributes for an OBJ material not listed in `project.json`. */
const UNTEXTURED: MeshFaceAttrs = {
  texId: null,
  flags: 0x04,
  color: {r: 255, g: 255, b: 255},
  alpha: 255,
}

/** Stable key for a face's distinct material tuple `(texId, flags, color, alpha)`. */
function tupleKey(face: MeshFace): string {
  const {r, g, b} = face.color
  return `${face.texId}|${face.flags}|${r},${g},${b}|${face.alpha}`
}

/** Build a {@link MaterialRecord} from a face, resolving its texId to a texture name. */
function materialRecord(face: MeshFace, textureNames: string[]): MaterialRecord {
  const texture = face.texId === null ? null : (textureNames[face.texId] ?? null)
  return {
    texture,
    flags: face.flags,
    color: [face.color.r, face.color.g, face.color.b],
    alpha: face.alpha,
  }
}

/** Convert a `[r, g, b]` triple to an {@link RgbColor}. */
function colorOf(rgb: [number, number, number]): RgbColor {
  return {r: rgb[0], g: rgb[1], b: rgb[2]}
}

/**
 * Drop trailing render layers whose faces duplicate the previous layer's -
 * {@link serializeMesh} always emits three render layers, padding a shorter chain
 * by repeating the lowest-detail one, so those repeats are not genuine LODs.
 */
function collapseTrailingDuplicates(layers: Mesh[]): Mesh[] {
  const result = [...layers]
  while (result.length > 1 && sameFaces(result[result.length - 1]!, result[result.length - 2]!)) {
    result.pop()
  }
  return result
}

function sameFaces(a: Mesh, b: Mesh): boolean {
  return JSON.stringify(a.faces) === JSON.stringify(b.faces)
}

/**
 * Reduce a layer to just the contiguous vertex slice its faces reference, remapping
 * indices to a local `[0, n)` range. The parsed layers all carry the project's full
 * vertex array; slicing gives each emitted OBJ only its own vertices so
 * {@link serializeMesh} lays them back out consecutively.
 */
function sliceLayer(mesh: Mesh): Mesh {
  let min = Infinity
  let max = -1
  for (const face of mesh.faces) {
    for (const index of face.vertices) {
      if (index < min) min = index
      if (index > max) max = index
    }
  }
  if (max < 0) return {vertices: [], faces: mesh.faces}
  const vertices = mesh.vertices.slice(min, max + 1)
  const faces = mesh.faces.map((face) => ({...face, vertices: face.vertices.map((i) => i - min)}))
  return {vertices, faces}
}

/** Read a UTF-8 file, or `null` when it does not exist. */
async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isEnoent(error)) return null
    throw error
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/**
 * Read `project.json` and resolve each material to the {@link MeshFaceAttrs} an
 * `objToMesh` callback returns (texture name → texId via `textureNames`).
 */
async function readProjectMaterials(
  dir: string,
  textureNames: string[],
): Promise<Map<string, MeshFaceAttrs>> {
  const path = join(dir, 'project.json')
  const raw = await readFile(path, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Invalid project.json in ${dir}: not valid JSON.`, {cause: error})
  }
  if (typeof parsed !== 'object' || parsed === null || !('materials' in parsed)) {
    throw new Error(`Invalid project.json in ${dir}: expected an object with a "materials" map.`)
  }
  const {materials} = parsed
  if (typeof materials !== 'object' || materials === null || Array.isArray(materials)) {
    throw new Error(`Invalid project.json in ${dir}: "materials" must be an object.`)
  }

  const result = new Map<string, MeshFaceAttrs>()
  for (const key of Object.keys(materials)) {
    const record = coerceMaterial(Reflect.get(materials, key), `${dir} material ${key}`)
    const texId = record.texture === null ? null : textureIndex(record.texture, textureNames)
    result.set(key, {texId, flags: record.flags, color: colorOf(record.color), alpha: record.alpha})
  }
  return result
}

/** Resolve a texture filename to its texId; `null` (untextured) when not in the table. */
function textureIndex(texture: string, textureNames: string[]): number | null {
  const index = textureNames.indexOf(texture)
  return index === -1 ? null : index
}

/** Validate one `project.json` material entry, narrowing without assertions. */
function coerceMaterial(value: unknown, label: string): MaterialRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label}: expected an object`)
  }
  const texture = 'texture' in value ? value.texture : undefined
  if (texture !== null && typeof texture !== 'string') {
    throw new Error(`${label}: "texture" must be a string or null`)
  }
  const color = 'color' in value ? value.color : undefined
  if (
    !Array.isArray(color) ||
    color.length !== 3 ||
    !color.every((c): c is number => typeof c === 'number')
  ) {
    throw new Error(`${label}: "color" must be a [r, g, b] number array`)
  }
  return {
    texture,
    flags: numberField(value, 'flags', label),
    color: [color[0]!, color[1]!, color[2]!], // length checked to be 3 above
    alpha: numberField(value, 'alpha', label),
  }
}

function numberField(value: object, key: string, label: string): number {
  const field = key in value ? Reflect.get(value, key) : undefined
  if (typeof field !== 'number') throw new Error(`${label}: "${key}" must be a number`)
  return field
}
