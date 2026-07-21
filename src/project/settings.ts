// @env node
import type {MenuInfo, MenuInfoPatch} from '../api/index.ts'

/**
 * Map a decoded {@link MenuInfo} to a full {@link MenuInfoPatch} covering every
 * field. `build` uses this to rewrite `menuinfo.dat` by patching the pristine
 * base bytes captured at init: because {@link formatMenuInfo} is patch-based over
 * the file's undecoded payload regions, editing must go through a patch rather
 * than re-serialize the whole struct.
 */
export function menuInfoToPatch(info: MenuInfo): MenuInfoPatch {
  return {
    lastLevel: info.lastLevel,
    multiplayer: info.multiplayer,
    maxPlayers: info.maxPlayers,
    networkProtocol: info.networkProtocol,
    serverIp: info.serverIp,
    hostName: info.hostName,
    playerName: info.playerName,
    gameMode: info.gameMode,
    saveSlot: info.saveSlot,
    team: info.team,
    soundVolume: info.soundVolume,
    musicVolume: info.musicVolume,
    soundChannels: info.soundChannels,
    detail: info.detail,
    graphicFx: info.graphicFx,
    renderer: info.renderer,
    language: info.language,
    subtitles: info.subtitles,
    resolution: {
      width: info.resolution.width,
      height: info.resolution.height,
      depth: info.resolution.depth,
    },
  }
}
