import {SERVER_INFO_SIZE} from './constants.ts'
import type {ServerInfo} from './types.ts'

/**
 * Parse `servinfo.dat`: the host's persisted multiplayer match settings, stored
 * as four little-endian uint32 fields (fraglimit, scorelimit, timelimit in
 * minutes, and the map-rotation "nextmap" level number).
 *
 * The shipped files are all-zero (no limits, rotation off); non-zero values are
 * written by the host once limits/rotation are configured for a session.
 *
 * @param data - Raw `servinfo.dat` bytes.
 */
export function parseServerInfo(data: Uint8Array): ServerInfo {
  if (data.byteLength < SERVER_INFO_SIZE) {
    throw new Error(
      `servinfo.dat must be at least ${SERVER_INFO_SIZE} bytes, got ${data.byteLength}`,
    )
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return {
    fragLimit: view.getUint32(0, true),
    scoreLimit: view.getUint32(4, true),
    timeLimit: view.getUint32(8, true),
    nextMap: view.getUint32(12, true),
  }
}

/**
 * Serialize a {@link ServerInfo} to `servinfo.dat` bytes - the inverse of
 * {@link parseServerInfo}. Writes exactly 16 bytes; round-trips losslessly.
 *
 * @param info - The match settings to write.
 */
export function formatServerInfo(info: ServerInfo): Uint8Array {
  const data = new Uint8Array(SERVER_INFO_SIZE)
  const view = new DataView(data.buffer)
  view.setUint32(0, info.fragLimit, true)
  view.setUint32(4, info.scoreLimit, true)
  view.setUint32(8, info.timeLimit, true)
  view.setUint32(12, info.nextMap, true)
  return data
}
