import type {ParsedScript, ScriptHandler, ScriptInstruction} from './types.ts'
import {
  AI_MODE,
  AI_VAR,
  PLAYER_STAT,
  PROJECT_VAR,
  PROVECT_TYPE,
  SCORE_MODE,
  VIEW_MODE,
  WEATHER_TYPE,
} from './constants.ts'

const decoder = new TextDecoder('latin1')

/**
 * The `.scr` stack-machine opcodes, recovered from the compiler (`CPARSE.EXE`)
 * and verified by compiling probe snippets. Each instruction serializes as
 * `[u8 opcode][u16 operandLen][operand]`. Comparisons are *synthesized* by the
 * compiler (eg `a < b` → `sub` then `ltz`), so there is no dedicated `<`/`>`/`==`
 * opcode.
 */
const OPCODES: Record<
  number,
  {mnemonic: string; operand: 'var' | 'float' | 'string' | 'jump' | null}
> = {
  0x00: {mnemonic: 'xor', operand: null}, // integer bitwise XOR (engine op; unused by shipped scripts)
  0x01: {mnemonic: 'mul', operand: null}, // *
  0x02: {mnemonic: 'div', operand: null}, // /
  0x03: {mnemonic: 'add', operand: null}, // +
  0x04: {mnemonic: 'sub', operand: null}, // -
  0x05: {mnemonic: 'store', operand: null}, // = (pop value into the variable below)
  0x06: {mnemonic: 'pushvar', operand: 'var'}, // push variable by index
  0x07: {mnemonic: 'pushf', operand: 'float'}, // push float literal
  0x08: {mnemonic: 'pushs', operand: 'string'}, // push string literal
  0x09: {mnemonic: 'eqz', operand: null}, // == 0  (also logical NOT)
  0x0a: {mnemonic: 'ltz', operand: null}, // < 0
  0x0b: {mnemonic: 'ret', operand: null}, // return / end of handler (the interpreter halts here)
  0x0c: {mnemonic: 'jmp', operand: 'jump'}, // unconditional jump
  0x0d: {mnemonic: 'jz', operand: 'jump'}, // jump if false/zero
  0x0e: {mnemonic: 'jg', operand: 'jump'}, // jump if > 0 (engine op; unused by shipped scripts)
  0x0f: {mnemonic: 'mod', operand: null}, // % - but the engine no-ops this opcode (modulo unsupported)
  0x10: {mnemonic: 'call', operand: 'string'}, // call REF* builtin
}

const MAX_OPCODE = 0x10

/**
 * Friendly names for the parameters the engine passes into well-known callbacks,
 * so the decompiler emits e.g. `SeePlayer(player)` instead of `SeePlayer(v0)`.
 *
 * Keys are lowercased (the engine resolves handler names case-insensitively). Only
 * parameters whose role is established are named; the rest stay `vN`. Roles were
 * derived by mining how each parameter flows into `REF*` calls across all shipped
 * scripts:
 *
 * - `EnterVehicle` → both args go to `REFChangeVehicle(player, vehicle)`.
 * - `SeePlayer` / `HeardFiring` → fired on the AI (the AI is `MYSELF`); the engine pushes
 *   the literal `0`, the player's handle (the spotted/heard player) - `SeePlayer` passes it
 *   straight to `REFAttack`.
 * - `HitItem` → arg2 is *only ever* player functions; arg1 is a type discriminator
 *   (`if (v1 == 2)`); arg0 is the hit object (vehicle/object stat calls).
 * - `Touched` → fired via the 4-arg invoker (`0x487d30`, asserts nParams==4). arg0 is the
 *   colliding object's project index; args1-3 are the collision's relative (impact) velocity
 *   vector - the caller computes `other.vel - self.vel` (`[obj+0x120..0x128]`) right before
 *   dispatch. No shipped script reads args1-3.
 * - `ItemActivated` → fired (via `CallScriptTwo`) once per nearby project the item can act
 *   on. arg0 is that target object (`DAT_004de3b0[i]`; repair items test `REFProIsVehicle`
 *   on it); arg1 is `(target[+0x2ec] != 0)` - a boolean "the target has an owner/parent
 *   back-reference" (repair items gate on `if (owned == 1)` before repairing).
 * - `ItemUsed` → engine callback with no shipped implementers; its only fire site passes the
 *   constant `1`, so the arg carries no data. Left unnamed.
 * - `UseItem` → fired on the target the item is used *on* (`MYSELF`); arg0 is the player
 *   (`REFRemoveItem`/`REFGetPlayerInx`), arg1 is the used item's data index (scripts test
 *   `v1 == REFGetDataIndex("wrench"/"chkey"/…)`).
 * - `InWater` / `TouchedGround` → the engine passes the affected object's own project
 *   index (`fild [obj+0]`, the value `REFGetMyProjectInx` returns) as the single arg;
 *   `InWater` resolves it via `REFGetPlayerNr` to apply drowning damage.
 */
const CALLBACK_PARAMS: Record<string, string[]> = {
  entervehicle: ['player', 'vehicle'],
  seeplayer: ['player'],
  heardfiring: ['player'],
  hititem: ['object', 'type', 'player'],
  touched: ['other', 'velX', 'velY', 'velZ'],
  itemactivated: ['object', 'owned'],
  useitem: ['player', 'item'],
  inwater: ['object'],
  touchedground: ['object'],
}

const paramName = (handler: string, index: number): string =>
  CALLBACK_PARAMS[handler.toLowerCase()]?.[index] ?? `v${index}`

/**
 * Canonical display casing for the engine's event callbacks. The engine resolves
 * handler names case-insensitively, so scripts spell these inconsistently
 * (`startup`/`StartUp`/`startUp`, `seeplayer`/`SeePlayer`); the decompiler normalizes
 * the known ones to a single PascalCase form. Author-defined handlers (which have no
 * canonical form) are left exactly as written. Names confirmed as literals in `ce.exe`.
 */
const CANONICAL_CALLBACKS: Record<string, string> = {
  startup: 'Startup',
  prepareworld: 'PrepareWorld',
  playercreated: 'PlayerCreated',
  loadgameinit: 'LoadGameInit',
  killed: 'Killed',
  destroyed: 'Destroyed',
  hititem: 'HitItem',
  touched: 'Touched',
  touchedground: 'TouchedGround',
  inwater: 'InWater',
  seeplayer: 'SeePlayer',
  heardfiring: 'HeardFiring',
  patrolend: 'PatrolEnd',
  useitem: 'UseItem',
  useactive: 'UseActive',
  itemactivated: 'ItemActivated',
  itemused: 'ItemUsed',
  entervehicle: 'EnterVehicle',
  activate: 'Activate',
}

const canonicalName = (handler: string): string =>
  CANONICAL_CALLBACKS[handler.toLowerCase()] ?? handler

/**
 * Parse a compiled `.scr` script into its event handlers and decoded bytecode.
 *
 * Layout: `u32 paramBytes`, `u32 handlerCount`, then per-handler descriptors
 * (name + a metadata block that carries baked load-time pointers), then the
 * handlers' bytecode. The metadata bytes contain values `> 0x10` that aren't
 * valid opcodes, which cleanly delimits the descriptor region from the bytecode;
 * we locate the bytecode as the first decodable run (starting at a `push`) that
 * reaches the end of file. Multi-handler splitting is heuristic (at `ret`
 * boundaries) - single-handler scripts (the common case) are exact.
 *
 * @param blob - Raw `.scr` bytes.
 */
export function parseScript(blob: Uint8Array): ParsedScript {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
  if (blob.byteLength < 8) return {paramBytes: 0, handlers: []}
  const paramBytes = view.getUint32(0, true)
  const handlerCount = view.getUint32(4, true)

  // Try the exact descriptor layout first (handles multi-handler precisely); fall back
  // to the heuristic bytecode-scan for files that don't match it (eg odd builds).
  const structured = parseStructured(blob, view, paramBytes, handlerCount)
  if (structured) return structured

  const start = findBytecodeStart(blob, view)
  if (start < 0) return {paramBytes, handlers: []}

  const names = extractNames(blob, 8, start, handlerCount)
  const instructions = decodeFrom(blob, view, start)
  const handlers = splitHandlers(instructions, Math.max(1, handlerCount), names)
  if (handlers.length === 1) handlers[0]!.paramCount = readParamCount(blob, view, start)
  return {paramBytes, handlers}
}

const handlerNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Parse the exact on-disk layout. Descriptors run in reverse declaration order; the
 * final one carries a trailing `u32 totalInstructionCount` before the combined
 * (declaration-order) bytecode, and each handler's `startIndex` locates its code.
 *
 * Two compiler variants exist (see `formats.md`) - our reference `CPARSE.EXE` uses an
 * 8-byte name field and bakes three relocated pointers + a repeated `varBytes`; the
 * shipped game's compiler uses a wider name region and two pointers. They differ only
 * in the descriptor's leading bytes: in **both**, the meaningful fields sit at fixed
 * offsets - `u16 startIndex` at `+32`, `u16 nParams` at `+34`, the slot table at `+40`,
 * and the descriptor spans `40 + 2·nParams` bytes. So we read those offsets directly
 * (skipping the build-specific pointer/constant fields) and validate structurally: the
 * decoded instruction count must equal the stored total and the starts must form a
 * 0-based partition. Returns `null` (caller falls back to the heuristic) on any
 * mismatch, eg synthetic blobs.
 */
function parseStructured(
  blob: Uint8Array,
  view: DataView,
  paramBytes: number,
  handlerCount: number,
): ParsedScript | null {
  if (handlerCount < 1 || handlerCount > 1024) return null
  let p = 8
  const metas: {name: string; startIndex: number; paramCount: number}[] = []
  let total = -1
  for (let h = 0; h < handlerCount; h++) {
    if (p + 40 > blob.byteLength) return null
    // Name: NUL-terminated, within the fixed region (≤ 28 bytes) before the field block.
    let e = p
    while (e < p + 28 && blob[e] !== 0) e++
    if (e === p || e === p + 28) return null
    const name = decoder.decode(blob.subarray(p, e))
    if (!handlerNamePattern.test(name)) return null
    const startIndex = view.getUint16(p + 32, true)
    const paramCount = view.getUint16(p + 34, true)
    p += 40 + paramCount * 2
    if (h === handlerCount - 1) {
      if (p + 4 > blob.byteLength) return null
      total = view.getUint32(p, true)
      p += 4
    }
    metas.push({name, startIndex, paramCount})
  }

  const instructions = decodeFrom(blob, view, p)
  if (total <= 0 || instructions.length !== total) return null // count must agree exactly
  // Order by bytecode start (= declaration order) and split the combined stream.
  const ordered = metas.map((m, i) => ({m, i})).toSorted((a, b) => a.m.startIndex - b.m.startIndex)
  if (ordered[0]!.m.startIndex !== 0) return null
  if (ordered.some(({m}) => m.startIndex < 0 || m.startIndex >= instructions.length)) return null
  const handlers: ScriptHandler[] = ordered.map(({m}, idx) => {
    const next = idx + 1 < ordered.length ? ordered[idx + 1]!.m.startIndex : instructions.length
    return {
      name: m.name,
      paramCount: m.paramCount,
      code: rebase(instructions.slice(m.startIndex, next)),
    }
  })
  return {paramBytes, handlers}
}

/** Decode the bytecode stream from `offset` to EOF into instructions (stream-indexed). */
function decodeFrom(blob: Uint8Array, view: DataView, offset: number): ScriptInstruction[] {
  const out: ScriptInstruction[] = []
  let p = offset
  let index = 0
  while (p < blob.byteLength) {
    const opcode = blob[p]!
    if (opcode > MAX_OPCODE) break
    const spec = OPCODES[opcode]!
    const at = p
    p += 1
    if (p + 2 > blob.byteLength) break
    const len = view.getUint16(p, true)
    p += 2
    if (p + len > blob.byteLength) break
    out.push({
      offset: at - offset,
      index: index++,
      opcode,
      mnemonic: spec.mnemonic,
      arg: readOperand(blob, view, spec.operand, p, len),
    })
    p += len
  }
  return out
}

function readOperand(
  blob: Uint8Array,
  view: DataView,
  kind: 'var' | 'float' | 'string' | 'jump' | null,
  at: number,
  len: number,
): number | string | null {
  if (kind === null || len === 0) return null
  if (kind === 'var') return view.getUint16(at, true)
  if (kind === 'float') return view.getFloat32(at, true)
  if (kind === 'jump') return view.getUint32(at, true)
  return decoder.decode(blob.subarray(at, at + len - 1)) // string (drop NUL)
}

/**
 * Find the start of the bytecode: the earliest offset that begins with a `push`
 * (`06`/`07`/`08`), decodes cleanly to EOF, and is real code (has a `call` or
 * ends in `ret`). The descriptor metadata's `>0x10` bytes make it undecodable,
 * so this skips past it.
 */
function findBytecodeStart(blob: Uint8Array, view: DataView): number {
  for (let s = 8; s < blob.byteLength - 2; s++) {
    const op = blob[s]!
    if (op !== 0x06 && op !== 0x07 && op !== 0x08) continue
    const instrs = decodeFrom(blob, view, s)
    if (instrs.length === 0) continue
    const last = instrs[instrs.length - 1]!
    // must consume to (near) EOF and look like a handler body
    const consumed = s + last.offset + 3 + lastOperandLen(blob, view, s, instrs)
    if (consumed < blob.byteLength - 2) continue
    if (instrs.some((i) => i.opcode === 0x10) || last.opcode === 0x0b) return s
  }
  return -1
}

function lastOperandLen(
  blob: Uint8Array,
  view: DataView,
  start: number,
  instrs: ScriptInstruction[],
): number {
  const last = instrs[instrs.length - 1]!
  return view.getUint16(start + last.offset + 1, true)
}

/** Pull `count` NUL-terminated identifier names out of the descriptor region `[from, to)`. */
function extractNames(blob: Uint8Array, from: number, to: number, count: number): string[] {
  const names: string[] = []
  let p = from
  while (p < to && names.length < count) {
    if (isIdentStart(blob[p]!)) {
      let end = p
      while (end < to && blob[end] !== 0 && isIdent(blob[end]!)) end++
      if (blob[end] === 0 && end - p >= 2) {
        names.push(decoder.decode(blob.subarray(p, end)))
        p = end + 1
        continue
      }
    }
    p++
  }
  return names
}

const isIdentStart = (b: number): boolean =>
  (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 95
const isIdent = (b: number): boolean => isIdentStart(b) || (b >= 48 && b <= 57)

/**
 * Split a decoded stream into `count` handler blocks. Jump targets are
 * block-local instruction indices, so each handler is the shortest prefix ending
 * in `ret` whose jumps all stay in range. Exact for single-handler scripts.
 */
function splitHandlers(
  instrs: ScriptInstruction[],
  count: number,
  names: string[],
): ScriptHandler[] {
  if (count <= 1) return [{name: names[0] ?? '', paramCount: -1, code: instrs}]
  const handlers: ScriptHandler[] = []
  let start = 0
  for (let h = 0; h < count - 1 && start < instrs.length; h++) {
    let end = instrs.length
    for (let i = start; i < instrs.length; i++) {
      if (instrs[i]!.opcode !== 0x0b) continue
      const len = i - start + 1
      if (jumpsInRange(instrs, start, i + 1, len)) {
        end = i + 1
        break
      }
    }
    handlers.push({
      name: names[h] ?? '',
      paramCount: -1,
      code: rebase(instrs.slice(start, end)),
    })
    start = end
  }
  handlers.push({
    name: names[count - 1] ?? '',
    paramCount: -1,
    code: rebase(instrs.slice(start)),
  })
  return handlers
}

/**
 * Recover a single handler's parameter count from its descriptor. The descriptor
 * follows the (NUL-terminated, 4-byte-aligned) name and lays out as
 * `[u32 4][u32 0][u32 ptr1][u32 varBytes][u32 ptr2][u32 ptr3][u16 nLocals][u16 nParams]…`,
 * so `nParams` sits 26 bytes in. Returns `-1` if it doesn't fit before the bytecode.
 */
function readParamCount(blob: Uint8Array, view: DataView, bytecodeStart: number): number {
  let p = 8
  while (p < blob.byteLength && blob[p] !== 0) p++ // name end
  const descriptor = (p + 1 + 3) & ~3 // skip NUL, align to 4
  if (descriptor + 28 > bytecodeStart) return -1
  return view.getUint16(descriptor + 26, true)
}

function jumpsInRange(instrs: ScriptInstruction[], from: number, to: number, len: number): boolean {
  for (let i = from; i < to; i++) {
    const ins = instrs[i]!
    if (
      (ins.opcode === 0x0c || ins.opcode === 0x0d) &&
      typeof ins.arg === 'number' &&
      ins.arg >= len
    )
      return false
  }
  return true
}

/**
 * Renumber a sliced handler block to start at 0. Jump targets are stored **absolute**
 * (combined-stream indices), so they're rebased to handler-local too - a target at or
 * past the block's end (the epilogue) is left as such so the structurer reads it as a
 * `return`.
 */
function rebase(block: ScriptInstruction[]): ScriptInstruction[] {
  const base = block[0]?.index ?? 0
  return block.map((ins) => {
    const out = {...ins, index: ins.index - base}
    if ((ins.opcode === 0x0c || ins.opcode === 0x0d) && typeof ins.arg === 'number')
      out.arg = ins.arg - base
    return out
  })
}

/**
 * Argument counts for the `REF*` builtins (the script "standard library"). Used by
 * {@link decompileScript} to group a call's arguments off the stack; unknown
 * builtins fall back to consuming the whole stack. The full set of 128 builtins is the
 * engine's REF dispatch table (resolved by name at script load); each arity here is
 * how many values that function pops off the VM stack.
 */
export const REF_ARITY: Record<string, number> = {
  REFAddAnimation: 6,
  REFAddBriefing: 6,
  REFAddChild: 2,
  REFAddFire: 1,
  REFAddItem: 2,
  REFAddMapObject: 2,
  REFAddNewAI: 16,
  REFAIToVehicle: 1,
  REFAlignProject: 5,
  REFAlignToLand: 1,
  REFAnimateTexture: 1,
  REFApplyForce: 7,
  REFAttack: 1,
  REFBackColor: 3,
  REFBunkerAttack: 1,
  REFCallScript_inst: 3,
  REFCallScript: 4, // variadic (3/4 + leading handler args) - resolved per-call in `reconstruct` (case 0x10)
  REFChangePlayer: 3,
  REFChangeVehicle: 2,
  REFDamageProject: 2,
  REFDeleteAI: 0,
  REFDestroy: 1,
  REFDisableVehicle: 1,
  REFDoneObjective: 2,
  REFDropItem: 0,
  REFDropNamedItem: 1,
  REFEnableVehicle: 1,
  REFEndGame: 1,
  REFError: 1,
  REFExplode: 1,
  REFFetchLandFace: 4,
  REFFindWorldProject: 2,
  REFGasMask: 2,
  REFGetArmor: 1,
  REFGetDataIndex: 2,
  REFGetDistance: 3,
  REFGetInstanceNr: 3,
  REFGetLength: 4,
  REFGetLocalNr: 2,
  REFGetMother: 2,
  REFGetMyProjectInx: 1,
  REFGetPartOfPower: 2,
  REFGetPlayerInx: 2,
  REFGetPlayerNr: 2,
  REFGetPlayerPro: 1,
  REFGetPosition: 4,
  REFGetProDataIndex: 2,
  REFGetProInstanceNr: 2,
  REFGetProject: 3,
  REFGetProjectExtNr: 2,
  REFGetProjectNr: 3,
  REFGetProVect: 5,
  REFGetTime: 1,
  REFGouraudOn: 1,
  REFInstanceNrExists: 3,
  REFIsDead: 1,
  REFIsTeamA: 2,
  REFKeepPlayback: 0,
  REFLightColor: 3,
  REFLightDirection: 3,
  REFLightMin: 3,
  REFLockCameraOnObj: 5,
  REFMoveProject: 4,
  REFNewVehicle: 9,
  REFParachute: 2,
  REFPatrolMode: 2,
  REFPitchProject: 2,
  REFPlayDlg: 6,
  REFPlayerHasItem: 3,
  REFPlayerHasVehicle: 2,
  REFPlayerItem: 3,
  REFPlayFX: 5,
  REFPlayRecorded: 1,
  REFPrintValue: 2,
  REFProIsVehicle: 2,
  REFProjectionPlane: 2,
  REFRandom: 1,
  REFRandomItem: 0,
  REFReadPlayer: 3,
  REFReadSpeed: 4,
  REFReadVehicleStat: 3,
  REFRebirthItem: 1,
  REFRemoveChild: 1,
  REFRemoveItem: 3,
  REFReplaceProject: 2,
  REFReplaceTextures: 3,
  REFRollProject: 2,
  REFSetAbsAngSpeed: 4,
  REFSetAIMoveTo: 4,
  REFSetAITargetTo: 4,
  REFSetAIVars: 3,
  REFSetAngularSpeed: 4,
  REFSetDrag: 4,
  REFSetGroundSounds: 2,
  REFSetItemTextureNr: 2,
  REFSetLandFace: 1,
  REFSetLandscape: 4,
  REFSetLight: 5,
  REFSetNoiceTexture: 4,
  REFSetPartOfPower: 2,
  REFSetPlanet: 2,
  REFSetPlayerFire: 0,
  REFSetPlayerFlags: 3,
  REFSetPosition: 4,
  REFSetProjectVars: 3,
  REFSetProVect: 5,
  REFSetRespawnMode: 1,
  REFSetSamePlayer: 1,
  REFSetScore: 3,
  REFSetSmoke: 8,
  REFSetSpeed: 4,
  REFSetSpeedVar: 3,
  REFSetTeam: 1,
  REFSetTTL: 2,
  REFSetVehicleStat: 3,
  REFSetViewMode: 4,
  REFSetWater: 2,
  REFSetWeatherType: 2,
  REFShowCutscene: 1,
  REFShowInfo: 1,
  REFShowMessage: 2,
  REFShowNumberInfo: 2,
  REFSpawnAI: 1,
  REFStopDlg: 2,
  REFStopFX: 2,
  REFTeamMate: 1,
  REFUseMapNumber: 1,
  REFYawProject: 2,
}

interface Expr {
  text: string
  /** Instruction index where this expression began (its anchor / statement position). */
  at: number
  /** Set when the expression is a bare `a - b` subtraction (for comparison synthesis). */
  sub?: [string, string]
  /** True for a string literal (engine type tag 1) - used to resolve variadic arity. */
  str?: boolean
  /** The numeric value, when this expression is a bare number literal (for arg symbolization). */
  num?: number
  /** For a call: the tentative statement emitted for it, marked `dead` if the result is consumed. */
  stmt?: {at: number; kind: 'line'; text: string; dead?: boolean}
}

type Stmt =
  | {at: number; kind: 'line'; text: string; dead?: boolean}
  | {at: number; kind: 'cjump'; cond: string; target: number}
  | {at: number; kind: 'jump'; target: number}

const literal = (v: number): string => (v === -1 ? 'MYSELF' : String(v))

/** value→name reverse of a constant enum; first name wins where a value has aliases. */
const reverse = (o: Record<string, number>): Map<number, string> => {
  const m = new Map<number, string>()
  for (const [k, v] of Object.entries(o)) if (!m.has(v)) m.set(v, k)
  return m
}
const PROJECT_VAR_R = reverse(PROJECT_VAR)
const AI_VAR_R = reverse(AI_VAR)
const AI_MODE_R = reverse(AI_MODE)
const PLAYER_STAT_R = reverse(PLAYER_STAT)
const SCORE_MODE_R = reverse(SCORE_MODE)
const VIEW_MODE_R = reverse(VIEW_MODE)
const PROVECT_TYPE_R = reverse(PROVECT_TYPE)
const WEATHER_TYPE_R = reverse(WEATHER_TYPE)
const BOOL_R = new Map([
  [0, 'OFF'],
  [1, 'ON'],
])

// REFSetProjectVars slots that toggle a boolean bit - their value arg reads as ON/OFF.
const BOOLEAN_PROJECT_SLOTS = new Set([1, 2, 3, 4, 5, 8, 11, 12, 13, 14, 16])

// Per-`REF*` argument enums, by position: which reverse map (if any) names each arg.
// `null` = leave as-is (a string, a plain number, or an object handle - the latter
// already renders as MYSELF via `literal`). Value args whose meaning depends on the
// selector arg (REFSetProjectVars/REFSetAIVars) are handled specially in symbolizeArgs.
const REF_ARG_ENUMS: Record<string, (Map<number, string> | null)[]> = {
  REFSetProjectVars: [null, PROJECT_VAR_R, null],
  REFSetAIVars: [null, AI_VAR_R, null],
  REFChangePlayer: [null, PLAYER_STAT_R, null],
  REFReadPlayer: [null, PLAYER_STAT_R, null],
  // arg0 is NOT auto-symbolized: the SDK header names it a team (TEAMA/TEAMB), but
  // shipped scripts pass a player handle there (e.g. flaga.scr's HitItem), so a
  // literal 0/1 is ambiguous. TEAMA/TEAMB stay compilable; only `mode` is emitted.
  REFSetScore: [null, SCORE_MODE_R, null],
  REFSetViewMode: [VIEW_MODE_R],
  REFGetProVect: [null, PROVECT_TYPE_R, null],
  REFSetWeatherType: [WEATHER_TYPE_R],
}

/**
 * Render a `REF*` call's arguments, replacing magic numbers with their SDK
 * constant names where the position is known (see `REF_ARG_ENUMS`). Only bare
 * numeric-literal args (those carrying `.num`) are eligible; variables, strings
 * and expressions pass through unchanged. The compiler resolves every name emitted
 * here back to the same number (`SCRIPT_CONSTANTS`), so round-trips stay
 * byte-identical.
 */
const symbolizeArgs = (name: string, args: Expr[]): string[] => {
  const enums = REF_ARG_ENUMS[name]
  return args.map((a, i) => {
    if (a.num === undefined) return a.text
    // Value args whose enum depends on the selector arg (args[1]).
    if (name === 'REFSetProjectVars' && i === 2) {
      const slot = args[1]?.num
      return slot !== undefined && BOOLEAN_PROJECT_SLOTS.has(slot)
        ? (BOOL_R.get(a.num) ?? a.text)
        : a.text
    }
    if (name === 'REFSetAIVars' && i === 2) {
      return args[1]?.num === AI_VAR.MODE ? (AI_MODE_R.get(a.num) ?? a.text) : a.text
    }
    return enums?.[i]?.get(a.num) ?? a.text
  })
}

/**
 * Whether a script destroys its own object the instant it spawns - its `startup` handler
 * calls `REFSetTTL(MYSELF, 0)` (TTL `0` = destroy immediately) or `REFDestroy(MYSELF)`.
 * Such objects are *placed* in a level's `data1.bin`/`World.dat` but never appear in-game
 * (eg No Man's Land's cacti/palms and `switch1` triggers), so a faithful level export
 * should skip them. `MYSELF` is the float `-1`.
 *
 * @param script - A {@link parseScript} result.
 */
export function selfDestructsAtSpawn(script: ParsedScript): boolean {
  const startup = script.handlers.find((h) => h.name.toLowerCase() === 'startup')
  if (!startup) return false
  const code = startup.code
  // 0x07 = pushf, 0x10 = call (see OPCODES). Args push left-to-right, so a call's operands
  // are the pushes immediately before it.
  const pushedValue = (index: number, value: number): boolean =>
    index >= 0 && code[index]!.opcode === 0x07 && code[index]!.arg === value
  for (let i = 0; i < code.length; i++) {
    if (code[i]!.opcode !== 0x10) continue
    const fn = typeof code[i]!.arg === 'string' ? (code[i]!.arg as string).toLowerCase() : ''
    if (fn === 'refsetttl' && pushedValue(i - 2, -1) && pushedValue(i - 1, 0)) return true
    if (fn === 'refdestroy' && pushedValue(i - 1, -1)) return true
  }
  return false
}

/**
 * Decompile a parsed script into readable C-like pseudocode. Reconstructs expressions off
 * the VM stack, groups each `REF*` call's arguments by its arity, folds `eqz`/`ltz`
 * comparisons (`sub`+`ltz` → `<`, etc.) and `0c`/`0d` jumps into `if`/`while`. Control
 * flow that doesn't fit those shapes falls back to `goto`/labels. Shared globals
 * render as `g0`, `g1`, … (emitted as leading `float g0;` declarations) and a handler's
 * params as `v0`, `v1`, … (original names aren't in the bytecode); `-1` → `MYSELF`.
 *
 * @param script - A {@link parseScript} result.
 */
export function decompileScript(script: ParsedScript): string {
  const totalSlots = Math.floor(script.paramBytes / 4)
  // The flat slot space is: globals, then each handler's params (declaration order).
  // We can separate globals from params only when every param count is known.
  const known = script.handlers.length > 0 && script.handlers.every((h) => h.paramCount >= 0)
  const totalParams = known ? script.handlers.reduce((n, h) => n + h.paramCount, 0) : 0
  const globalCount = known ? Math.max(0, totalSlots - totalParams) : 0

  let base = globalCount // running slot offset of the current handler's params
  const blocks = script.handlers.map((h) => {
    const params = known ? h.paramCount : totalSlots
    const myBase = base
    base += params
    // a slot is a global, this handler's own param, or (rarely) some other slot
    const nameVar = (slot: number): string =>
      slot < globalCount
        ? `g${slot}`
        : slot >= myBase && slot < myBase + params
          ? paramName(h.name, slot - myBase)
          : `v${slot - globalCount}`
    const sig = Array.from({length: params}, (_, i) => paramName(h.name, i)).join(', ')
    const body = structure(reconstruct(h.code, nameVar), h.code.length)
    return `${canonicalName(h.name)}(${sig}) {\n${body.map((l) => '  ' + l).join('\n')}\n}`
  })
  const decls = Array.from({length: globalCount}, (_, i) => `float g${i};`)
  return [...decls, ...blocks].join('\n\n')
}

/**
 * Stack-simulate one handler's instructions into a flat statement list (with jumps).
 *
 * Calls are emitted as statements **at the moment they're processed** (their natural
 * position), so a value-returning `REF*` whose result is discarded reads at its call
 * site rather than being mis-scoped at a later flush point. If the result is instead
 * consumed by a later operand, its tentative statement is marked dead and inlined.
 * Each expression carries the instruction index where it began so statements anchor
 * correctly for jump-target resolution.
 */
function reconstruct(
  code: ScriptInstruction[],
  nameVar: (slot: number) => string = (s) => `v${s}`,
): Stmt[] {
  const stack: Expr[] = []
  const stmts: Stmt[] = []
  // Pop an operand that is being *consumed* into a larger expression: drop its tentative
  // call-statement (it's now inlined), and return the expression.
  const take = (): Expr => {
    const e = stack.pop()
    if (e?.stmt) e.stmt.dead = true
    return e ?? {text: '?', at: 0}
  }
  const binop = (op: string): void => {
    const b = take(),
      a = take()
    stack.push({text: `(${a.text} ${op} ${b.text})`, at: a.at})
  }
  for (const ins of code) {
    switch (ins.opcode) {
      case 0x06:
        stack.push({text: nameVar(ins.arg as number), at: ins.index})
        break
      case 0x07:
        stack.push({text: literal(ins.arg as number), at: ins.index, num: ins.arg as number})
        break
      case 0x08:
        stack.push({text: `"${ins.arg}"`, at: ins.index, str: true})
        break
      case 0x01:
        binop('*')
        break
      case 0x02:
        binop('/')
        break
      case 0x03:
        binop('+')
        break
      case 0x0f:
        binop('%')
        break
      case 0x04: {
        const b = take(),
          a = take()
        stack.push({
          text: `(${a.text} - ${b.text})`,
          at: a.at,
          sub: [a.text, b.text],
        })
        break
      }
      case 0x09: {
        const x = take()
        stack.push({
          text: x.sub ? `(${x.sub[0]} == ${x.sub[1]})` : `!${x.text}`,
          at: x.at,
        })
        break
      }
      case 0x0a: {
        const x = take()
        stack.push({
          text: x.sub ? `(${x.sub[0]} < ${x.sub[1]})` : `(${x.text} < 0)`,
          at: x.at,
        })
        break
      }
      case 0x05: {
        const value = take(),
          target = take()
        stmts.push({
          at: target.at,
          kind: 'line',
          text: `${target.text} = ${value.text}`,
        })
        break
      }
      case 0x10: {
        const name = String(ins.arg)
        let n = REF_ARITY[name] ?? stack.length
        if (name === 'REFCallScript') {
          // Variadic (mirrors engine `FUN_00486bd0`). In evaluation (push) order the operands are
          //   [handlerArg1, handlerArg2, …], target(str), instance(num), handler(str), [delay(num)]
          // The engine pops from the top: an OPTIONAL trailing delay(num) - present iff the top
          // stack value is non-string - then handler(str), instance(num), target(str), and finally
          // the handler's own N declared params (the deepest-pushed values) as arguments.
          //
          // We don't know the target handler's param count at the call site (it may live in another
          // file), so we recover the leading args structurally: after the fixed
          // target/instance/handler/[delay] block, any deeper operand that is a bare pushed value
          // (a literal/var/nested expression, not a *leftover* prior call statement) belongs to this
          // call. Leftover results from a preceding discarded statement carry a `.stmt` marker, which
          // is exactly what separates them from real arguments - so we stop at the first such entry.
          // Emitting all operands positionally (args first, then target/instance/handler/[delay])
          // round-trips byte-for-byte: the compiler re-pushes them in the same order.
          const hasDelay = stack.length > 0 && !stack[stack.length - 1]!.str
          n = hasDelay ? 4 : 3
          for (let i = stack.length - 1 - n; i >= 0 && !stack[i]!.stmt; i--) n++
        }
        const args: Expr[] = []
        for (let i = 0; i < n; i++) args.unshift(take())
        const at = args[0]?.at ?? ins.index
        const text = `${name}(${symbolizeArgs(name, args).join(', ')})`
        const stmt = {at, kind: 'line' as const, text} // tentative statement…
        stmts.push(stmt)
        stack.push({text, at, stmt}) // …inlined (marked dead) if the result is consumed
        break
      }
      case 0x0b:
        // 0x0b is the handler terminator (return/halt), not a stack pop. The final one is the
        // implicit function end - emit nothing, so epilogue-targeting jumps still resolve to
        // `return;`. A mid-handler 0x0b is an early `return`: model it as a forward jump past
        // the last instruction so `structure` renders it as `return;`.
        if (ins !== code[code.length - 1]) {
          stmts.push({at: ins.index, kind: 'jump', target: code.length})
        }
        break
      case 0x0d: {
        const c = take()
        const cond = c.sub ? `(${c.sub[0]} != ${c.sub[1]})` : c.text
        stmts.push({
          at: c.at,
          kind: 'cjump',
          cond,
          target: ins.arg as number,
        })
        break
      }
      case 0x0c:
        stmts.push({at: ins.index, kind: 'jump', target: ins.arg as number})
        break
      default:
        break
    }
  }
  // Keep only live statements, in execution (anchor) order.
  return stmts.filter((s) => !(s.kind === 'line' && s.dead)).toSorted((a, b) => a.at - b.at)
}

/** Fold a statement list into structured `if`/`while`; fall back to `goto`/labels. */
function structure(stmts: Stmt[], instrCount: number): string[] {
  const at = (instr: number): number => {
    const i = stmts.findIndex((s) => s.at === instr)
    return i === -1 ? stmts.length : i
  }
  const gotos = new Set<number>()
  const emit = (lo: number, hi: number): string[] => {
    const out: string[] = []
    let i = lo
    while (i < hi) {
      const s = stmts[i]!
      if (s.kind === 'line') {
        out.push(`${s.text};`)
        i++
      } else if (s.kind === 'jump') {
        // A jump to the epilogue (past the last statement) is a `return`, not a goto.
        if (at(s.target) >= stmts.length) {
          out.push('return;')
        } else {
          gotos.add(s.target)
          out.push(`goto L${s.target};`)
        }
        i++
      } else {
        // cjump: jump-to-target-if-false → if/while
        const tIdx = at(s.target)
        const back = stmts.findIndex(
          (x, j) => j > i && j < tIdx && x.kind === 'jump' && x.target === s.at,
        )
        if (back !== -1) {
          out.push(`while (${s.cond}) {`)
          out.push(...emit(i + 1, back).map((l) => '  ' + l))
          out.push('}')
          i = back + 1
        } else {
          // A real `else` only exists when the body's trailing jump lands at a join point
          // *before* the end; a jump to the end is a `return`, leaving the rest as siblings.
          const prev = stmts[tIdx - 1]
          const hasElse =
            !!prev &&
            prev.kind === 'jump' &&
            prev.target > s.target &&
            at(prev.target) < stmts.length
          const bodyEnd = hasElse ? tIdx - 1 : tIdx
          out.push(`if (${s.cond}) {`)
          out.push(...emit(i + 1, bodyEnd).map((l) => '  ' + l))
          out.push('}')
          if (hasElse && prev.kind === 'jump') {
            const elseEnd = at(prev.target)
            out.push('else {')
            out.push(...emit(tIdx, elseEnd).map((l) => '  ' + l))
            out.push('}')
            i = elseEnd
          } else {
            i = tIdx
          }
        }
      }
    }
    return out
  }
  const lines = emit(0, stmts.length)
  while (lines[lines.length - 1] === 'return;') lines.pop() // trailing returns = the implicit function end
  if (gotos.size === 0) return lines
  // re-emit with labels prefixed where gotos land (rare fallback path)
  return labelize(stmts, instrCount, gotos)
}

/** Fallback: flat listing with `Lnn:` labels and `goto`s (used when control flow is irreducible). */
function labelize(stmts: Stmt[], instrCount: number, gotos: Set<number>): string[] {
  const out: string[] = []
  for (const s of stmts) {
    if (gotos.has(s.at)) out.push(`L${s.at}:`)
    if (s.kind === 'line') out.push(`${s.text};`)
    else if (s.kind === 'jump') out.push(`goto L${s.target};`)
    else out.push(`if (${s.cond}) {} else goto L${s.target};`)
  }
  if (gotos.has(instrCount)) out.push(`L${instrCount}:`)
  return out
}

/**
 * Render a parsed script as a readable disassembly listing - one line per
 * instruction with resolved jump targets and `REF*` call names.
 *
 * @param script - A {@link parseScript} result.
 */
export function disassembleScript(script: ParsedScript): string {
  const lines: string[] = []
  for (const handler of script.handlers) {
    lines.push(`${handler.name}:`)
    for (const ins of handler.code) {
      let text = ins.mnemonic
      if (ins.arg !== null) {
        if (ins.mnemonic === 'pushvar') text += ` $${ins.arg}`
        else if (ins.mnemonic === 'pushf') text += ` ${ins.arg}`
        else if (ins.mnemonic === 'pushs' || ins.mnemonic === 'call') text += ` "${ins.arg}"`
        else if (ins.mnemonic === 'jmp' || ins.mnemonic === 'jz') text += ` -> ${ins.arg}`
      }
      lines.push(`  ${String(ins.index).padStart(3)}: ${text}`)
    }
  }
  return lines.join('\n')
}
