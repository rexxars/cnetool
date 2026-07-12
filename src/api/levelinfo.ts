import {REF_ARITY} from './script.ts'
import type {LevelCall, LevelInfo, ParsedScript, RgbColor, ScriptInstruction} from './types.ts'

const NON_CONST = NaN // marker for an argument that isn't a compile-time constant

/**
 * Evaluate a handler's straight-line `REF*` calls, resolving each call's constant
 * arguments (folding simple literal arithmetic like `193 / 255`). Variables and
 * call results become `NaN`. Branch/loop opcodes are ignored - the level-setup run in
 * `startup` is straight-line, which is all this needs.
 */
function extractCalls(code: ScriptInstruction[]): LevelCall[] {
  const stack: (number | string)[] = []
  const calls: LevelCall[] = []
  for (const ins of code) {
    switch (ins.opcode) {
      case 0x07:
        stack.push(ins.arg as number)
        break // pushf
      case 0x08:
        stack.push(ins.arg as string)
        break // pushs
      case 0x06:
        stack.push(NON_CONST)
        break // pushvar - not a constant
      case 0x01:
      case 0x02:
      case 0x03:
      case 0x04:
      case 0x0f: {
        const b = stack.pop(),
          a = stack.pop()
        if (typeof a !== 'number' || typeof b !== 'number') {
          stack.push(NON_CONST)
          break
        }
        stack.push(
          ins.opcode === 0x01
            ? a * b
            : ins.opcode === 0x02
              ? a / b
              : ins.opcode === 0x03
                ? a + b
                : ins.opcode === 0x04
                  ? a - b
                  : a % b,
        )
        break
      }
      case 0x09:
      case 0x0a:
        stack.pop()
        stack.push(NON_CONST)
        break // comparison
      case 0x05:
        stack.pop()
        stack.pop()
        break // store
      case 0x10: {
        const name = String(ins.arg)
        const arity = REF_ARITY[name] ?? stack.length
        const args: (number | string)[] = []
        for (let i = 0; i < arity; i++) args.unshift(stack.pop() ?? NON_CONST)
        calls.push({name, args})
        stack.push(NON_CONST) // the call result is not a known constant
        break
      }
      case 0x0b:
        stack.pop()
        break // discard
      default:
        break // jumps: config is straight-line, so flow control is irrelevant here
    }
  }
  return calls
}

const num = (v: number | string | undefined): number | undefined =>
  typeof v === 'number' && !Number.isNaN(v) ? v : undefined
const text = (v: number | string | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined
const rgb = (a: (number | string)[]): RgbColor | undefined => {
  const r = num(a[0]),
    g = num(a[1]),
    b = num(a[2])
  return r !== undefined && g !== undefined && b !== undefined ? {r, g, b} : undefined
}

/**
 * Resolve a level's ambient configuration - terrain, water, lights, sky, weather - from
 * its `mainscr.scr`. A level's `startup` handler issues a run of `REF*` setup calls with
 * constant arguments; this evaluates them and maps the well-understood ones to typed
 * fields, keeping every call (in order) in `calls` so any other setting is still
 * reachable.
 *
 * @param mainscr - the parsed `mainscr.scr` (from {@link parseScript}).
 */
export function getLevelInfo(mainscr: ParsedScript): LevelInfo {
  const startup = mainscr.handlers.find((h) => h.name === 'startup') ?? mainscr.handlers[0]
  const calls = startup ? extractCalls(startup.code) : []
  const argsOf = (name: string): (number | string)[] | undefined =>
    calls.find((c) => c.name === name)?.args

  const info: LevelInfo = {light: {}, calls}

  const land = argsOf('REFSetLandscape')
  const landName = land && text(land[0])
  if (landName !== undefined)
    info.landscape = {
      name: landName,
      sky: (land && text(land[1])) ?? '',
      fogDistance: (land && num(land[3])) ?? 0,
    }

  const water = argsOf('REFSetWater')
  const waterAmplitude = water && num(water[0])
  if (waterAmplitude !== undefined) info.water = {amplitude: waterAmplitude}

  const color = argsOf('REFLightColor')
  if (color) info.light.color = rgb(color)
  const min = argsOf('REFLightMin')
  if (min) info.light.min = rgb(min)
  const dir = argsOf('REFLightDirection')
  if (dir) {
    const x = num(dir[0]),
      y = num(dir[1]),
      z = num(dir[2])
    if (x !== undefined && y !== undefined && z !== undefined) info.light.direction = {x, y, z}
  }

  const back = argsOf('REFBackColor')
  if (back) info.backColor = rgb(back)

  const planet = argsOf('REFSetPlanet')
  const planetTex = planet && text(planet[0])
  if (planetTex !== undefined)
    info.planet = {texture: planetTex, flag: (planet && num(planet[1])) ?? 0}

  const weather = argsOf('REFSetWeatherType')
  const weatherType = weather && num(weather[0])
  if (weatherType !== undefined) info.weather = {type: weatherType}

  const gs = argsOf('REFSetGroundSounds')
  const gsA = gs && text(gs[0]),
    gsB = gs && text(gs[1])
  if (gsA !== undefined && gsB !== undefined) info.groundSounds = [gsA, gsB]

  return info
}
