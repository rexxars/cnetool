import {describe, expect, test} from 'vitest'

import {compileScript, getLevelInfo, parseScript} from '../src/index.ts'

describe('getLevelInfo', () => {
  test('resolves terrain, water, lights, and sky from a mainscr startup', () => {
    const src = `startup() {
      REFSetGroundSounds("CrunSnow", "CruFloor");
      REFLightColor(1, 1, 193 / 255);
      REFLightMin(70, 70, 90);
      REFLightDirection(1, 0, 0);
      REFBackColor(2, 2, 10);
      REFSetPlanet("skysun", 1);
      REFSetWater(-10, 10);
      REFSetLandscape("dm1", "horizon1", 0, 5000);
    }`
    const info = getLevelInfo(parseScript(compileScript(src)))
    expect(info.landscape).toEqual({name: 'dm1', sky: 'horizon1', fogDistance: 5000})
    expect(info.water).toEqual({amplitude: -10})
    expect(info.light.color).toEqual({r: 1, g: 1, b: 193 / 255}) // const-folded division
    expect(info.light.min).toEqual({r: 70, g: 70, b: 90})
    expect(info.light.direction).toEqual({x: 1, y: 0, z: 0})
    expect(info.backColor).toEqual({r: 2, g: 2, b: 10})
    expect(info.planet).toEqual({texture: 'skysun', flag: 1})
    expect(info.groundSounds).toEqual(['CrunSnow', 'CruFloor'])
    expect(info.calls).toHaveLength(8)
  })

  test('omits settings the level does not configure', () => {
    const info = getLevelInfo(
      parseScript(compileScript('startup() { REFSetLandscape("land2", "m2moln", 0, 2800); }')),
    )
    expect(info.landscape?.name).toBe('land2')
    expect(info.water).toBeUndefined()
    expect(info.planet).toBeUndefined()
    expect(info.light.color).toBeUndefined()
    expect(info.groundSounds).toBeUndefined()
  })
})
