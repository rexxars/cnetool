import {projectToMap} from './binary.ts'
import {decodeTga, encodeTga} from './image.ts'
import {parseArchive} from './parse.ts'
import type {ArchiveInputEntry} from './parse.ts'
import {extractTexture, getTextureInfo} from './texture.ts'
import type {MapMatrix, Mesh, MeshFace, RawImage, RgbColor} from './types.ts'

/** Full tab-map resolution: the four 256×256 tiles tile a 512×512 image. */
export const TAB_MAP_RESOLUTION = 512
/** Side length of a single tab-map tile, in pixels. */
export const TAB_MAP_TILE = 256

/**
 * A square world-space region framed by the tab map. The map shows the horizontal
 * (X/Z) plane looking straight down, so `size` is the world extent the full square
 * map covers; `centerX`/`centerZ` are the world coords at its center.
 */
export interface TabMapWindow {
  /** World X at the center of the map. */
  centerX: number
  /** World Z at the center of the map. */
  centerZ: number
  /** World units spanned by the (square) map's full width and height. */
  size: number
}

/**
 * Derive a square {@link TabMapWindow} that frames a mesh's horizontal (X/Z) extent,
 * with a little padding. Use this to auto-frame a level's terrain.
 *
 * @param mesh - The terrain (or any) mesh to frame.
 * @param marginFraction - Padding added on each side, as a fraction of the larger span
 *   (default `0.04` = 4%). The window is square (the larger of the X/Z spans wins).
 */
export function tabMapWindowForMesh(mesh: Mesh, marginFraction = 0.04): TabMapWindow {
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const v of mesh.vertices) {
    if (v.x < minX) minX = v.x
    if (v.x > maxX) maxX = v.x
    if (v.z < minZ) minZ = v.z
    if (v.z > maxZ) maxZ = v.z
  }
  if (!Number.isFinite(minX)) return {centerX: 0, centerZ: 0, size: 1}

  const span = Math.max(maxX - minX, maxZ - minZ) * (1 + 2 * marginFraction)
  return {
    centerX: (minX + maxX) / 2,
    centerZ: (minZ + maxZ) / 2,
    size: span > 0 ? span : 1,
  }
}

/**
 * Build the `MAPMTX.DAT` affine that maps world `(x, z)` to a tab-map pixel for a given
 * {@link TabMapWindow} - the engine convention confirmed against the shipped levels:
 * uniform scale, Z flipped so world +Z (north) points up, centered. Pairs with
 * {@link renderTabMap}: a marker projected through this matrix lands on the rendered map.
 *
 * @param window - The world region the map frames.
 * @param resolution - Full map size in pixels (default {@link TAB_MAP_RESOLUTION}).
 */
export function tabMapMatrix(window: TabMapWindow, resolution = TAB_MAP_RESOLUTION): MapMatrix {
  const scale = resolution / window.size
  const half = resolution / 2
  // px = scale·x + (half − scale·cx);  py = −scale·z + (half + scale·cz)
  return {
    values: [
      scale,
      0,
      half - scale * window.centerX,
      0,
      -scale,
      half + scale * window.centerZ,
      0,
      0,
      1,
    ],
  }
}

/** Options for {@link renderTabMap}. */
export interface RenderTabMapOptions {
  /** Output size in pixels (default {@link TAB_MAP_RESOLUTION}). */
  resolution?: number
  /** Color for pixels no face covers (default black). */
  background?: RgbColor
  /**
   * Color a face. Return `null` to skip it (eg untextured faces). Defaults to a flat
   * mid-gray for every face - pass a resolver that averages each face's texture for a
   * recognizable map. Used when {@link RenderTabMapOptions.texture} returns nothing.
   */
  faceColor?: (face: MeshFace, index: number) => RgbColor | null
  /**
   * Per-face texture to sample per-pixel (with the face's UVs, wrapped) for a detailed
   * render - the actual ground texture rather than one flat color. Return `null` to fall
   * back to {@link RenderTabMapOptions.faceColor} for that face.
   */
  texture?: (face: MeshFace, index: number) => RawImage | null
}

/** Average the Y (CE's −Y-up vertical axis) of a face's vertices - the top-down depth key. */
function faceHeight(mesh: Mesh, face: MeshFace): number {
  let sum = 0
  for (const i of face.vertices) sum += mesh.vertices[i]?.y ?? 0
  return sum / face.vertices.length
}

/**
 * Render a mesh top-down (orthographic, looking down the vertical axis) into a
 * {@link RawImage}, framing the given {@link TabMapWindow}. Each face is sampled from its
 * {@link RenderTabMapOptions.texture} per-pixel (or filled with its flat
 * {@link RenderTabMapOptions.faceColor} when no texture is given); where faces overlap, the
 * one nearer the top-down camera (CE is −Y-up, so the most-negative average Y) wins. The
 * result is top-down (row 0 = north), matching {@link tabMapMatrix} - slice it with
 * {@link sliceTabMapTiles}.
 *
 * @param mesh - The mesh to render (typically a level's terrain project).
 * @param window - The world region to frame.
 * @param options - Coloring, resolution and background.
 */
export function renderTabMap(
  mesh: Mesh,
  window: TabMapWindow,
  options: RenderTabMapOptions = {},
): RawImage {
  const res = options.resolution ?? TAB_MAP_RESOLUTION
  const bg = options.background ?? {r: 0, g: 0, b: 0}
  const faceColor = options.faceColor ?? (() => ({r: 128, g: 128, b: 128}))
  const texture = options.texture
  const matrix = tabMapMatrix(window, res)

  const data = new Uint8Array(res * res * 3)
  for (let i = 0; i < res * res; i++) {
    data[i * 3] = bg.r
    data[i * 3 + 1] = bg.g
    data[i * 3 + 2] = bg.b
  }
  const depth = new Float32Array(res * res).fill(Infinity)

  // Project every vertex to pixel space once.
  const px = new Float32Array(mesh.vertices.length)
  const py = new Float32Array(mesh.vertices.length)
  for (let i = 0; i < mesh.vertices.length; i++) {
    const v = mesh.vertices[i]!
    const p = projectToMap(matrix, v.x, v.z)
    px[i] = p.x
    py[i] = p.y
  }

  mesh.faces.forEach((face, index) => {
    const h = faceHeight(mesh, face)
    const tex = texture?.(face, index) ?? null
    const color = tex && face.uv ? null : faceColor(face, index)
    if (!tex && !color) return

    // Fan-triangulate the (convex) face and scan-fill each triangle.
    for (let t = 1; t + 1 < face.vertices.length; t++) {
      const ia = face.vertices[0]!
      const ib = face.vertices[t]!
      const ic = face.vertices[t + 1]!
      rasterTriangle(
        px[ia]!,
        py[ia]!,
        px[ib]!,
        py[ib]!,
        px[ic]!,
        py[ic]!,
        res,
        (x, y, w0, w1, w2) => {
          const idx = y * res + x
          if (h >= depth[idx]!) return
          let r: number
          let g: number
          let b: number
          if (tex && face.uv) {
            const u = w0 * face.uv[0]![0] + w1 * face.uv[t]![0] + w2 * face.uv[t + 1]![0]
            const v = w0 * face.uv[0]![1] + w1 * face.uv[t]![1] + w2 * face.uv[t + 1]![1]
            ;[r, g, b] = sampleTexel(tex, u, v)
          } else if (color) {
            r = color.r
            g = color.g
            b = color.b
          } else return
          depth[idx] = h
          const p = idx * 3
          data[p] = r
          data[p + 1] = g
          data[p + 2] = b
        },
      )
    }
  })

  return {width: res, height: res, channels: 3, data}
}

/** Map a texture coordinate to a texel index, wrapped into `[0, n)` for tiling. */
function wrapTexel(t: number, n: number): number {
  const i = Math.floor((t - Math.floor(t)) * n)
  return i < 0 ? 0 : i >= n ? n - 1 : i
}

/**
 * Nearest-neighbor sample a texture at UV (wrapped for tiling); returns `[r,g,b]`. The V axis
 * is flipped: archive texture rows are stored top-down behind a lying bottom-origin descriptor
 * (see {@link TgaToPngOptions.topOrigin}), so a descriptor-honoring {@link decodeTga} returns
 * them vertically flipped relative to how the engine draws them - without the compensating flip
 * each face's texture samples upside-down, which on baked multi-tile terrain (`MULT*`) shows as
 * banding/discontinuities between faces.
 */
function sampleTexel(tex: RawImage, u: number, v: number): [number, number, number] {
  const x = wrapTexel(u, tex.width)
  const y = tex.height - 1 - wrapTexel(v, tex.height)
  const p = (y * tex.width + x) * tex.channels
  return [tex.data[p]!, tex.data[p + 1]!, tex.data[p + 2]!]
}

/**
 * Scan-fill a triangle (half-open, pixel-center sampling), clipped to `[0,res)²`, calling
 * `plot` for each covered pixel with its barycentric weights `(w0,w1,w2)` for vertices A/B/C.
 */
function rasterTriangle(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  res: number,
  plot: (x: number, y: number, w0: number, w1: number, w2: number) => void,
): void {
  const denom = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
  if (denom === 0) return // degenerate
  const top = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.5))
  const bottom = Math.min(res - 1, Math.floor(Math.max(ay, by, cy) - 0.5))
  const edges: Array<[number, number, number, number]> = [
    [ax, ay, bx, by],
    [bx, by, cx, cy],
    [cx, cy, ax, ay],
  ]
  for (let y = top; y <= bottom; y++) {
    const yc = y + 0.5
    const crossings: number[] = []
    for (const [x0, y0, x1, y1] of edges) {
      if ((y0 <= yc && y1 > yc) || (y1 <= yc && y0 > yc)) {
        crossings.push(x0 + ((yc - y0) / (y1 - y0)) * (x1 - x0))
      }
    }
    if (crossings.length < 2) continue
    crossings.sort((m, n) => m - n)
    const left = Math.max(0, Math.ceil(crossings[0]! - 0.5))
    const right = Math.min(res - 1, Math.floor(crossings[crossings.length - 1]! - 0.5))
    for (let x = left; x <= right; x++) {
      const xc = x + 0.5
      const w0 = ((by - cy) * (xc - cx) + (cx - bx) * (yc - cy)) / denom
      const w1 = ((cy - ay) * (xc - cx) + (ax - cx) * (yc - cy)) / denom
      plot(x, y, w0, w1, 1 - w0 - w1)
    }
  }
}

/**
 * Slice a full (square, even-sized) tab-map image into the engine's four tiles, named
 * `map<mapNumber><0..3>.tga`. Confirmed in-engine: the tiles are laid out **row-major** -
 * `0`=top-left, `1`=top-right, `2`=bottom-left, `3`=bottom-right - and the map renderer draws
 * each tile **top-origin** (stored pixel row 0 at the screen top), so each quadrant is
 * vertically flipped before encoding (`encodeTga` writes bottom-origin, so the flip cancels and
 * the stored pixels end up top-origin). Feed the result to {@link buildTextureArchive} - which
 * strips the 8-byte TGA prefix to the engine's internal blob - to produce a loadable
 * `leveltex.bin`. Tiles are 24-bit.
 *
 * @param image - The full top-down map (eg from {@link renderTabMap}); width must equal height.
 * @param mapNumber - The map number used in the filenames (`REFUseMapNumber`'s value).
 */
export function sliceTabMapTiles(image: RawImage, mapNumber: number): ArchiveInputEntry[] {
  if (image.width !== image.height || image.width % 2 !== 0) {
    throw new Error(
      `tab-map image must be square with even dimensions, got ${image.width}×${image.height}`,
    )
  }
  const tile = image.width / 2
  // Tile index → [column offset, row offset] in the full image (top-down), row-major.
  const quadrants: Array<[number, number]> = [
    [0, 0], // 0 = top-left
    [tile, 0], // 1 = top-right
    [0, tile], // 2 = bottom-left
    [tile, tile], // 3 = bottom-right
  ]
  return quadrants.map(([ox, oy], index) => ({
    name: `map${mapNumber}${index}.tga`,
    data: encodeTga(flipImageV(cropImage(image, ox, oy, tile, tile))),
  }))
}

/** Per-side widths in **pixels**: a single number for all sides, or an object per side. */
export type TabMapMargin = number | {top?: number; right?: number; bottom?: number; left?: number}

/** Options for {@link frameTabMap}. */
export interface FrameTabMapOptions {
  /** Black margin per side, in **pixels** (default `0` = none). The engine crops the **bottom**
   * of the tab map, so a bottom margin keeps content/marker out of the cropped region; other
   * sides frame the map. A single number applies to all sides. */
  margin?: TabMapMargin
  /** White frame width just inside the margin, in **pixels** (default `0` = none) - the
   * decorative border the shipped maps have, drawn on all four sides. */
  border?: number
  /** Fill color for the margin (default black). */
  marginColor?: RgbColor
  /** Color of the border frame (default white). */
  borderColor?: RgbColor
  /** Grid line spacing in **pixels** (default `0` = no grid). Thin (1px) alpha-blended lines drawn
   * over the content **inside** the border, mirroring the shipped maps' graph-paper overlay. */
  grid?: number
  /** Grid line color (default white). */
  gridColor?: RgbColor
  /** Grid line opacity, `0`-`1` (default `0.18`) - low for a subtle, antialiased-looking line. */
  gridAlpha?: number
}

/** Round a pixel value (a possibly-undefined side width) to an integer. */
function roundPx(v: number | undefined): number {
  return Math.round(v ?? 0)
}

/** Resolve a {@link TabMapMargin} to per-side pixel widths. */
function marginPixels(margin: TabMapMargin | undefined): {
  top: number
  right: number
  bottom: number
  left: number
} {
  if (typeof margin === 'number')
    return {
      top: roundPx(margin),
      right: roundPx(margin),
      bottom: roundPx(margin),
      left: roundPx(margin),
    }
  return {
    top: roundPx(margin?.top),
    right: roundPx(margin?.right),
    bottom: roundPx(margin?.bottom),
    left: roundPx(margin?.left),
  }
}

/**
 * Frame a rendered tab map in place: paint a black {@link FrameTabMapOptions.margin} (per side, in
 * pixels) over the edges of the (square) `content`, then an optional white
 * {@link FrameTabMapOptions.border} just inside it - matching the shipped maps. The content keeps
 * its size and position (so the matching `MAPMTX` needs **no** offset); the painted frame covers
 * the outer edges (water/cropped region), and the playable area - kept central by water-padding -
 * stays visible.
 *
 * @param content - The full-size rendered map (eg from {@link renderTabMap}); must be square.
 * @param options - Per-side margin, border width (pixels), and colors.
 */
export function frameTabMap(content: RawImage, options: FrameTabMapOptions = {}): RawImage {
  if (content.width !== content.height) throw new Error('tab-map content must be square')
  const size = content.width
  const m = marginPixels(options.margin)
  const b = Math.round(options.border ?? 0)
  const black = options.marginColor ?? {r: 0, g: 0, b: 0}
  const white = options.borderColor ?? {r: 255, g: 255, b: 255}

  const out = content.data.slice()
  const fill = (x0: number, y0: number, x1: number, y1: number, c: RgbColor): void => {
    for (let y = Math.max(0, y0); y < Math.min(size, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(size, x1); x++) {
        const i = (y * size + x) * 3
        out[i] = c.r
        out[i + 1] = c.g
        out[i + 2] = c.b
      }
    }
  }
  // Black margins (each edge inward by its width).
  fill(0, 0, size, m.top, black)
  fill(0, size - m.bottom, size, size, black)
  fill(0, 0, m.left, size, black)
  fill(size - m.right, 0, size, size, black)
  // White border: a band of width b just inside each side's margin.
  if (b > 0) {
    fill(m.left, m.top, size - m.right, m.top + b, white)
    fill(m.left, size - m.bottom - b, size - m.right, size - m.bottom, white)
    fill(m.left, m.top, m.left + b, size - m.bottom, white)
    fill(size - m.right - b, m.top, size - m.right, size - m.bottom, white)
  }

  // Grid: thin alpha-blended lines over the content area only (inside the margin + border),
  // matching the shipped maps' graph-paper overlay.
  const spacing = Math.round(options.grid ?? 0)
  if (spacing > 0) {
    const gx0 = m.left + b
    const gy0 = m.top + b
    const gx1 = size - m.right - b
    const gy1 = size - m.bottom - b
    const c = options.gridColor ?? {r: 255, g: 255, b: 255}
    const a = options.gridAlpha ?? 0.18
    const blendV = (x: number): void => {
      if (x < gx0 || x >= gx1) return
      for (let y = gy0; y < gy1; y++) blendPixel(out, (y * size + x) * 3, c, a)
    }
    const blendH = (y: number): void => {
      if (y < gy0 || y >= gy1) return
      for (let x = gx0; x < gx1; x++) blendPixel(out, (y * size + x) * 3, c, a)
    }
    for (let x = gx0; x < gx1; x += spacing) blendV(x)
    for (let y = gy0; y < gy1; y += spacing) blendH(y)
  }
  return {width: size, height: size, channels: 3, data: out}
}

/** Alpha-blend `color` (at opacity `a`, 0-1) onto the RGB pixel at byte offset `i`. */
function blendPixel(out: Uint8Array, i: number, color: RgbColor, a: number): void {
  out[i] = Math.round(out[i]! * (1 - a) + color.r * a)
  out[i + 1] = Math.round(out[i + 1]! * (1 - a) + color.g * a)
  out[i + 2] = Math.round(out[i + 2]! * (1 - a) + color.b * a)
}

/** Options for {@link grayscaleTabMap}. */
export interface GrayscaleTabMapOptions {
  /** Brightness multiplier at the **top-left** (lit) corner (default `2.0`). */
  light?: number
  /** Brightness multiplier at the **bottom-right** (shadowed) corner (default `0.7`). */
  shadow?: number
}

/**
 * Desaturate a rendered map to grayscale and apply a **diagonal light gradient** - brighter at the
 * top-left, darker toward the bottom-right - reproducing the shipped maps' lit, contrasty,
 * heightmap-like look (a flat grayscale is too even). Each pixel's luminance is multiplied by a
 * factor interpolated from {@link GrayscaleTabMapOptions.light} (top-left) to
 * {@link GrayscaleTabMapOptions.shadow} (bottom-right) along the diagonal.
 *
 * @param image - The rendered map (typically the color {@link renderTabMap} output, pre-framing).
 * @param options - Light/shadow multipliers.
 */
export function grayscaleTabMap(image: RawImage, options: GrayscaleTabMapOptions = {}): RawImage {
  const {width, height, channels, data} = image
  const light = options.light ?? 2.0
  const shadow = options.shadow ?? 0.7
  const out = new Uint8Array(data.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels
      const luma = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!
      const tx = width > 1 ? x / (width - 1) : 0
      const ty = height > 1 ? y / (height - 1) : 0
      const factor = light + (shadow - light) * ((tx + ty) / 2)
      const v = Math.max(0, Math.min(255, Math.round(luma * factor)))
      out[i] = v
      out[i + 1] = v
      out[i + 2] = v
      if (channels === 4) out[i + 3] = data[i + 3]!
    }
  }
  return {width, height, channels, data: out}
}

/** Vertically flip an image (row `y` ↔ row `height-1-y`). */
function flipImageV(image: RawImage): RawImage {
  const {width, height, channels, data} = image
  const stride = width * channels
  const out = new Uint8Array(data.length)
  for (let y = 0; y < height; y++)
    out.set(data.subarray((height - 1 - y) * stride, (height - y) * stride), y * stride)
  return {width, height, channels, data: out}
}

/** Copy a rectangular sub-region of an image into a new {@link RawImage}. */
function cropImage(image: RawImage, ox: number, oy: number, w: number, h: number): RawImage {
  const {channels, data, width} = image
  const out = new Uint8Array(w * h * channels)
  for (let y = 0; y < h; y++) {
    const src = ((oy + y) * width + ox) * channels
    out.set(data.subarray(src, src + w * channels), y * w * channels)
  }
  return {width: w, height: h, channels, data: out}
}

/**
 * Reassemble four tab-map tiles into the full map as the engine displays it - the inverse of
 * {@link sliceTabMapTiles}. Tiles are given in index order `0..3` **as decoded from the archive**
 * (eg `decodeTga(extractTexture(...))`), which is bottom-origin; each is flipped to the engine's
 * top-origin orientation and placed row-major (`0`=TL, `1`=TR, `2`=BL, `3`=BR). All four tiles
 * must be the same square size.
 *
 * @param tiles - The four decoded tiles, in index order.
 */
export function assembleTabMap(tiles: RawImage[]): RawImage {
  if (tiles.length !== 4) throw new Error(`tab map needs 4 tiles, got ${tiles.length}`)
  const {width: s, height, channels} = tiles[0]!
  for (const t of tiles) {
    if (t.width !== s || t.height !== height || t.width !== t.height) {
      throw new Error('tab-map tiles must all be the same square size')
    }
  }
  const w = s * 2
  const out = new Uint8Array(w * w * channels)
  const place = (img: RawImage, ox: number, oy: number): void => {
    const up = flipImageV(img) // archive tiles are bottom-origin; engine draws top-origin
    for (let y = 0; y < s; y++) {
      const src = y * s * channels
      out.set(up.data.subarray(src, src + s * channels), ((oy + y) * w + ox) * channels)
    }
  }
  place(tiles[0]!, 0, 0) // TL
  place(tiles[1]!, s, 0) // TR
  place(tiles[2]!, 0, s) // BL
  place(tiles[3]!, s, s) // BR
  return {width: w, height: w, channels, data: out}
}

/**
 * Extract a level's existing tab map: find the four `map<mapNumber><0..3>.tga` tiles in the given
 * texture archives, decode them, and reassemble them into the full map as the engine shows it (via
 * {@link assembleTabMap}). Returns `null` if the complete set isn't present.
 *
 * @param archives - Texture archives to search in order (eg the level's `leveltex.bin`, then the
 *   global `textures.dat`/`texsec.dat`); the first archive containing a given tile wins.
 * @param mapNumber - The map number (see the `[133,247]→333` rule / `REFUseMapNumber` in the docs).
 */
export function extractTabMap(archives: Uint8Array[], mapNumber: number): RawImage | null {
  // Index every texture entry by name once (first archive wins), then pull the four tiles.
  const byName = new Map<
    string,
    {archive: Uint8Array; entry: ReturnType<typeof parseArchive>['entries'][number]}
  >()
  for (const archive of archives) {
    let entries
    try {
      entries = parseArchive(archive).entries
    } catch {
      continue // skip empty/garbage archives
    }
    for (const entry of entries) {
      const key = entry.name.toLowerCase()
      if (!byName.has(key)) byName.set(key, {archive, entry})
    }
  }

  const tiles: RawImage[] = []
  for (let k = 0; k < 4; k++) {
    const found = byName.get(`map${mapNumber}${k}.tga`)
    if (!found || !getTextureInfo(found.archive, found.entry)) return null
    tiles.push(decodeTga(extractTexture(found.archive, found.entry)))
  }
  return assembleTabMap(tiles)
}
