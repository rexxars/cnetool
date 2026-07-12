import {
  LIGHT_COLOR_OFFSET,
  LIGHT_ID_OFFSET,
  LIGHT_POSITION_OFFSET,
  LIGHT_RANGE_OFFSET,
  LIGHT_RECORD_LENGTH,
  MAP_MATRIX_SIZE,
  MAP_MATRIX_VALUE_COUNT,
} from './constants.ts'
import type {LightSource, MapMatrix} from './types.ts'

function viewOf(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength)
}

/**
 * Parse `MAPMTX.DAT`: a 3×3 affine matrix of 9 row-major little-endian float32
 * values that maps world coordinates to minimap pixels.
 *
 * @param data - Raw `MAPMTX.DAT` bytes.
 */
export function parseMatrix(data: Uint8Array): MapMatrix {
  if (data.byteLength < MAP_MATRIX_SIZE) {
    throw new Error(`MAPMTX.DAT must be at least ${MAP_MATRIX_SIZE} bytes, got ${data.byteLength}`)
  }

  const view = viewOf(data)
  const values: number[] = []
  for (let i = 0; i < MAP_MATRIX_VALUE_COUNT; i++) {
    values.push(view.getFloat32(i * 4, true))
  }
  return {values}
}

/**
 * Serialize a {@link MapMatrix} to `MAPMTX.DAT` bytes - the inverse of {@link parseMatrix}:
 * the 9 row-major values as little-endian float32. Round-trips losslessly.
 *
 * @param matrix - The 3×3 affine (9 values; missing entries default to 0).
 */
export function formatMatrix(matrix: MapMatrix): Uint8Array {
  const out = new Uint8Array(MAP_MATRIX_SIZE)
  const view = new DataView(out.buffer)
  for (let i = 0; i < MAP_MATRIX_VALUE_COUNT; i++) {
    view.setFloat32(i * 4, matrix.values[i] ?? 0, true)
  }
  return out
}

/**
 * Apply a {@link MapMatrix} to a pair of planar world coordinates, returning the
 * minimap pixel position. The two world inputs are the horizontal-plane axes
 * (the vertical/altitude axis is not part of the projection).
 */
export function projectToMap(matrix: MapMatrix, a: number, b: number): {x: number; y: number} {
  const v = matrix.values
  return {
    x: v[0]! * a + v[1]! * b + v[2]!,
    y: v[3]! * a + v[4]! * b + v[5]!,
  }
}

/**
 * Parse `LIGHTS.DAT`: a header-less array of 23-byte light records. An empty
 * file (no lights) yields an empty array.
 *
 * @param data - Raw `LIGHTS.DAT` bytes.
 */
export function parseLights(data: Uint8Array): LightSource[] {
  if (data.byteLength % LIGHT_RECORD_LENGTH !== 0) {
    throw new Error(
      `LIGHTS.DAT length ${data.byteLength} is not a multiple of ${LIGHT_RECORD_LENGTH}`,
    )
  }

  const view = viewOf(data)
  const lights: LightSource[] = []
  for (let base = 0; base < data.byteLength; base += LIGHT_RECORD_LENGTH) {
    lights.push({
      range: view.getFloat32(base + LIGHT_RANGE_OFFSET, true),
      id: view.getUint32(base + LIGHT_ID_OFFSET, true),
      color: {
        r: view.getUint8(base + LIGHT_COLOR_OFFSET),
        g: view.getUint8(base + LIGHT_COLOR_OFFSET + 1),
        b: view.getUint8(base + LIGHT_COLOR_OFFSET + 2),
      },
      position: {
        x: view.getFloat32(base + LIGHT_POSITION_OFFSET, true),
        y: view.getFloat32(base + LIGHT_POSITION_OFFSET + 4, true),
        z: view.getFloat32(base + LIGHT_POSITION_OFFSET + 8, true),
      },
    })
  }
  return lights
}

/**
 * Serialize light sources to `LIGHTS.DAT` bytes - the inverse of {@link parseLights}: a
 * header-less array of 23-byte records (`f32 range`, `u32 id`, `3 × u8` RGB, `3 × f32` xyz,
 * packed unaligned). An empty list yields an empty file. Round-trips losslessly.
 *
 * @param lights - The light sources to write.
 */
export function formatLights(lights: Iterable<LightSource>): Uint8Array {
  const list = [...lights]
  const out = new Uint8Array(list.length * LIGHT_RECORD_LENGTH)
  const view = new DataView(out.buffer)
  list.forEach((light, i) => {
    const base = i * LIGHT_RECORD_LENGTH
    view.setFloat32(base + LIGHT_RANGE_OFFSET, light.range, true)
    view.setUint32(base + LIGHT_ID_OFFSET, light.id, true)
    out[base + LIGHT_COLOR_OFFSET] = light.color.r & 0xff
    out[base + LIGHT_COLOR_OFFSET + 1] = light.color.g & 0xff
    out[base + LIGHT_COLOR_OFFSET + 2] = light.color.b & 0xff
    view.setFloat32(base + LIGHT_POSITION_OFFSET, light.position.x, true)
    view.setFloat32(base + LIGHT_POSITION_OFFSET + 4, light.position.y, true)
    view.setFloat32(base + LIGHT_POSITION_OFFSET + 8, light.position.z, true)
  })
  return out
}
