import {describe, expect, test} from 'vitest'

import {
  averageColor,
  buildTextureArchive,
  decodeTga,
  extractTabMap,
  frameTabMap,
  grayscaleTabMap,
  projectToMap,
  renderTabMap,
  sliceTabMapTiles,
  tabMapMatrix,
  tabMapWindowForMesh,
} from '../src/index.ts'
import type {Mesh, RawImage} from '../src/index.ts'

/** A solid-color square image. */
const solid = (size: number, c: [number, number, number]): RawImage => {
  const data = new Uint8Array(size * size * 3)
  for (let i = 0; i < size * size; i++) [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]] = c
  return {width: size, height: size, channels: 3, data}
}

/** An 8×8 image whose pixels encode (col, row) distinctly, for slice/extract round-trips. */
function distinctImage(): RawImage {
  const data = new Uint8Array(8 * 8 * 3)
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const p = (y * 8 + x) * 3
      data[p] = x * 30
      data[p + 1] = y * 30
      data[p + 2] = 100
    }
  }
  return {width: 8, height: 8, channels: 3, data}
}

const v = (x: number, y: number, z: number): {x: number; y: number; z: number} => ({x, y, z})

const pixel = (img: RawImage, x: number, y: number): [number, number, number] => {
  const p = (y * img.width + x) * 3
  return [img.data[p]!, img.data[p + 1]!, img.data[p + 2]!]
}

/** Return a vertically-flipped copy of an image's pixel data (row y ↔ height-1-y). */
const flipImageVData = (img: RawImage): Uint8Array => {
  const stride = img.width * img.channels
  const out = new Uint8Array(img.data.length)
  for (let y = 0; y < img.height; y++) {
    out.set(img.data.subarray((img.height - 1 - y) * stride, (img.height - y) * stride), y * stride)
  }
  return out
}

/** A 4×4 image whose pixels encode (col,row) so quadrants are identifiable after slicing. */
function gradientImage(): RawImage {
  const data = new Uint8Array(4 * 4 * 3)
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const p = (y * 4 + x) * 3
      data[p] = x * 60
      data[p + 1] = y * 60
      data[p + 2] = 0
    }
  }
  return {width: 4, height: 4, channels: 3, data}
}

/** A flat quad covering world X/Z [-100,100], at height `y`, with the given face color. */
function quad(y: number, color: {r: number; g: number; b: number}): Mesh {
  return {
    vertices: [v(-100, y, -100), v(100, y, -100), v(100, y, 100), v(-100, y, 100)],
    faces: [{vertices: [0, 1, 2, 3], color, alpha: 255, flags: 0, texId: null, uv: null}],
  }
}

describe('tabMapMatrix', () => {
  const window = {centerX: 0, centerZ: 0, size: 200}

  test('maps the window center to the map center', () => {
    const m = tabMapMatrix(window, 512)
    expect(projectToMap(m, 0, 0)).toEqual({x: 256, y: 256})
  })

  test('scales by resolution/size and flips Z (north is up)', () => {
    const m = tabMapMatrix(window, 512)
    // +X is east (right); +Z is north, so a larger Z gives a smaller (higher) y.
    expect(projectToMap(m, 100, 0)).toEqual({x: 512, y: 256}) // east edge
    expect(projectToMap(m, 0, 100).y).toBeCloseTo(0) // north edge -> top
    expect(projectToMap(m, 0, -100).y).toBeCloseTo(512) // south edge -> bottom
  })

  test('honors an off-origin center', () => {
    const m = tabMapMatrix({centerX: 50, centerZ: -30, size: 200}, 512)
    expect(projectToMap(m, 50, -30)).toEqual({x: 256, y: 256})
  })
})

describe('tabMapWindowForMesh', () => {
  test('frames the X/Z bounding box as a square with margin', () => {
    const mesh: Mesh = {
      vertices: [v(-40, 0, -10), v(60, 5, 30)], // X span 100, Z span 40
      faces: [],
    }
    const w = tabMapWindowForMesh(mesh, 0) // no margin
    expect(w.centerX).toBe(10)
    expect(w.centerZ).toBe(10)
    expect(w.size).toBe(100) // the larger span wins (square)
  })

  test('adds margin on each side', () => {
    const mesh: Mesh = {vertices: [v(0, 0, 0), v(100, 0, 0)], faces: []}
    expect(tabMapWindowForMesh(mesh, 0.1).size).toBeCloseTo(120) // +10% each side
  })

  test('falls back to a unit window for an empty mesh', () => {
    expect(tabMapWindowForMesh({vertices: [], faces: []})).toEqual({
      centerX: 0,
      centerZ: 0,
      size: 1,
    })
  })
})

describe('renderTabMap', () => {
  const window = {centerX: 0, centerZ: 0, size: 200}

  test('fills covered pixels with the face color and leaves the background elsewhere', () => {
    // Quad covers world [-100,100]² -> the whole 64px map; shrink it so a margin stays bg.
    const mesh = quad(0, {r: 10, g: 200, b: 30})
    mesh.vertices = [v(-50, 0, -50), v(50, 0, -50), v(50, 0, 50), v(-50, 0, 50)]
    const img = renderTabMap(mesh, window, {
      resolution: 64,
      background: {r: 0, g: 0, b: 0},
      faceColor: (f) => f.color,
    })
    expect(pixel(img, 32, 32)).toEqual([10, 200, 30]) // center is covered
    expect(pixel(img, 1, 1)).toEqual([0, 0, 0]) // corner is background
  })

  test('depth buffer keeps the face nearer the top-down camera (most-negative Y)', () => {
    const low = quad(10, {r: 255, g: 0, b: 0}) // farther (larger Y)
    const high = quad(-10, {r: 0, g: 0, b: 255}) // nearer (smaller Y) -> should win
    const merged: Mesh = {
      vertices: [...low.vertices, ...high.vertices],
      faces: [low.faces[0]!, {...high.faces[0]!, vertices: [4, 5, 6, 7]}],
    }
    const img = renderTabMap(merged, window, {resolution: 16, faceColor: (f) => f.color})
    expect(pixel(img, 8, 8)).toEqual([0, 0, 255]) // the high (nearer) face
  })

  test('samples a texture per-pixel when one is provided', () => {
    // A 2×2 texture: top row red/green, bottom row blue/white.
    const tex: RawImage = {
      width: 2,
      height: 2,
      channels: 3,
      // prettier-ignore
      data: Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]),
    }
    const mesh: Mesh = {
      vertices: [v(-100, 0, -100), v(100, 0, -100), v(100, 0, 100), v(-100, 0, 100)],
      faces: [
        {
          vertices: [0, 1, 2, 3],
          color: {r: 0, g: 0, b: 0},
          alpha: 255,
          flags: 0,
          texId: 0,
          uv: [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ],
        },
      ],
    }
    const img = renderTabMap(mesh, window, {resolution: 4, texture: () => tex})
    // The map fills the whole 4px image; corners sample the texture corners. v=0 row at top.
    const colors = new Set<string>()
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) {
        const p = (y * 4 + x) * 3
        colors.add(`${img.data[p]},${img.data[p + 1]},${img.data[p + 2]}`)
      }
    // All four texel colors should appear somewhere in the render.
    expect(colors.has('255,0,0')).toBe(true)
    expect(colors.has('0,255,0')).toBe(true)
    expect(colors.has('0,0,255')).toBe(true)
    expect(colors.has('255,255,255')).toBe(true)
  })
})

describe('sliceTabMapTiles', () => {
  // gradientImage pixels encode (col*60, row*60) in (R, G); 4×4 → 2×2 tiles.
  test('names tiles map<n>0..3 in row-major order, stored top-origin (flipped)', () => {
    const tiles = sliceTabMapTiles(gradientImage(), 333)
    expect(tiles.map((t) => t.name)).toEqual([
      'map3330.tga',
      'map3331.tga',
      'map3332.tga',
      'map3333.tga',
    ])
    // Row-major: 0=TL, 1=TR, 2=BL, 3=BR. Each tile is stored vertically flipped (so the engine,
    // which draws top-origin, shows it upright) - so flipping the decoded tile back gives the
    // upright quadrant, whose top-left pixel is that quadrant's image origin.
    const upright = (i: number): [number, number] => {
      const t = decodeTga(tiles[i]!.data)
      const flipped = pixel({...t, data: flipImageVData(t)}, 0, 0) // un-flip, read top-left
      return [flipped[0], flipped[1]]
    }
    expect(upright(0)).toEqual([0, 0]) // TL quadrant origin = image (col 0, row 0)
    expect(upright(1)).toEqual([2 * 60, 0]) // TR = (col 2, row 0)
    expect(upright(2)).toEqual([0, 2 * 60]) // BL = (col 0, row 2)
    expect(upright(3)).toEqual([2 * 60, 2 * 60]) // BR = (col 2, row 2)
    // The stored tile is genuinely flipped: tile 0 decoded directly shows the quadrant's BOTTOM row.
    expect([decodeTga(tiles[0]!.data).data[0], decodeTga(tiles[0]!.data).data[1]]).toEqual([0, 60])
    expect([decodeTga(tiles[0]!.data).width, decodeTga(tiles[0]!.data).height]).toEqual([2, 2])
  })

  test('rejects a non-square or odd-sized image', () => {
    expect(() =>
      sliceTabMapTiles({width: 4, height: 6, channels: 3, data: new Uint8Array(72)}, 1),
    ).toThrow(/square/)
    expect(() =>
      sliceTabMapTiles({width: 3, height: 3, channels: 3, data: new Uint8Array(27)}, 1),
    ).toThrow(/even/)
  })
})

describe('frameTabMap', () => {
  test('paints a bottom-only black margin + white border over the content edges (pixels)', () => {
    // 100×100 content, bottom margin 10px, border 5px → bottom black [90,100), white band [85,90).
    const out = frameTabMap(solid(100, [12, 34, 56]), {margin: {bottom: 10}, border: 5})
    expect([out.width, out.height]).toEqual([100, 100])
    expect(pixel(out, 50, 50)).toEqual([12, 34, 56]) // content (kept full-size, central)
    expect(pixel(out, 50, 99)).toEqual([0, 0, 0]) // bottom = black margin (the crop reserve)
    expect(pixel(out, 50, 87)).toEqual([255, 255, 255]) // white border just above the bottom margin
    expect(pixel(out, 2, 50)).toEqual([255, 255, 255]) // left white border (no left margin → at edge)
    expect(pixel(out, 50, 2)).toEqual([255, 255, 255]) // top white border
  })

  test('a single margin number applies to all sides (pixels)', () => {
    const out = frameTabMap(solid(100, [9, 9, 9]), {margin: 10, border: 0})
    expect(pixel(out, 0, 0)).toEqual([0, 0, 0]) // every corner black
    expect(pixel(out, 99, 0)).toEqual([0, 0, 0])
    expect(pixel(out, 0, 99)).toEqual([0, 0, 0])
    expect(pixel(out, 50, 50)).toEqual([9, 9, 9]) // content center
  })

  test('overlays an alpha-blended grid, inside the border only', () => {
    const out = frameTabMap(solid(100, [100, 100, 100]), {
      border: 10,
      grid: 20,
      gridColor: {r: 255, g: 255, b: 255},
      gridAlpha: 0.5,
    })
    // content/grid area is inside the 10px border → [10,90); grid lines at x/y = 10,30,50,70.
    expect(pixel(out, 10, 20)[0]).toBe(178) // on a vertical line only: round(100*0.5 + 255*0.5)
    expect(pixel(out, 20, 20)).toEqual([100, 100, 100]) // between grid lines = unchanged content
    expect(pixel(out, 5, 50)).toEqual([255, 255, 255]) // in the white border, not gridded
  })

  test('no margin/border leaves the content unchanged', () => {
    const out = frameTabMap(solid(64, [9, 9, 9]), {})
    expect([out.width, out.height]).toEqual([64, 64])
    expect(pixel(out, 0, 0)).toEqual([9, 9, 9])
  })

  test('rejects non-square content', () => {
    expect(() =>
      frameTabMap({width: 4, height: 6, channels: 3, data: new Uint8Array(72)}, {}),
    ).toThrow(/square/)
  })
})

describe('grayscaleTabMap', () => {
  test('desaturates and applies the diagonal light gradient (TL bright, BR dark)', () => {
    const img = solid(100, [100, 150, 200]) // luma = 0.299·100 + 0.587·150 + 0.114·200 = 140.75
    const out = grayscaleTabMap(img, {light: 2.0, shadow: 0.5})
    const [r, g, b] = pixel(out, 30, 30)
    expect(r === g && g === b).toBe(true) // gray
    expect(pixel(out, 0, 0)[0]).toBe(255) // top-left: 140.75 × 2.0 → clamped
    expect(pixel(out, 99, 99)[0]).toBe(70) // bottom-right: round(140.75 × 0.5)
    expect(pixel(out, 0, 0)[0]).toBeGreaterThan(pixel(out, 99, 99)[0]) // lit → shadowed
  })
})

describe('extractTabMap', () => {
  test('round-trips: slice → buildTextureArchive → extractTabMap === original image', () => {
    const img = distinctImage()
    const archive = buildTextureArchive(sliceTabMapTiles(img, 7))
    const back = extractTabMap([archive], 7)
    if (!back) throw new Error('extractTabMap returned null')
    expect([back.width, back.height]).toEqual([8, 8])
    expect([...back.data]).toEqual([...img.data]) // exact: the slice/assemble flips cancel
  })

  test('returns null when the tile set is incomplete', () => {
    const partial = buildTextureArchive(sliceTabMapTiles(distinctImage(), 7).slice(0, 3))
    expect(extractTabMap([partial], 7)).toBeNull()
  })

  test('searches archives in order (first match wins)', () => {
    const a = buildTextureArchive(sliceTabMapTiles(distinctImage(), 7))
    const empty = buildTextureArchive([])
    expect(extractTabMap([empty, a], 7)).not.toBeNull() // found in the second archive
  })
})

describe('averageColor', () => {
  test('averages every pixel', () => {
    const img: RawImage = {
      width: 2,
      height: 1,
      channels: 3,
      data: Uint8Array.from([0, 100, 200, 100, 100, 0]),
    }
    expect(averageColor(img)).toEqual({r: 50, g: 100, b: 100})
  })

  test('returns black for an empty image', () => {
    expect(averageColor({width: 0, height: 0, channels: 3, data: new Uint8Array(0)})).toEqual({
      r: 0,
      g: 0,
      b: 0,
    })
  })
})
