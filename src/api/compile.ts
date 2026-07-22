/**
 * A compiler for the Codename Eagle `.scr` C-subset source language, targeting the
 * stack-machine bytecode. This is the inverse of
 * `parseScript`/`decompileScript`. It emits a **complete, loadable `.scr`** (header +
 * per-handler descriptors + bytecode); the instruction stream is byte-identical to
 * `CPARSE.EXE` output, and the files load and run in the real engine (verified in-game:
 * cnetool-compiled overrides for `palm`/`fueltank` behave as authored).
 *
 * The language is small: `float`-only values and string literals (as `REF*` call
 * arguments), functions (event handlers) with parameters, `if`/`else`/`while`/`return`,
 * the operators `+ - * / %`, `< > == !=`, unary `- !`, and `REF*` builtin calls. There
 * is no `<= >= && ||` (the original compiler rejects them).
 *
 * Variables: module-level `float g;` declarations are **globals** - persistent slots
 * shared across all handlers and indexed in declaration order. Parameters occupy the
 * slots after the globals. Function-body locals don't exist (CPARSE silently emits an
 * empty body for them), so `float x;` inside a handler is a compile error here. Global
 * initializers (`float g = 3;`) are accepted but dropped - CPARSE zero-inits globals.
 */

import {SCRIPT_CONSTANTS} from './constants.ts'

// ---- tokens ----

type TokenKind = 'num' | 'ident' | 'str' | 'punct' | 'eof'
interface Token {
  kind: TokenKind
  value: string
  pos: number
}

// binary-operator precedence, lowest first (no `<= >= && ||` - not in the language)
const LEVELS = [
  ['==', '!='],
  ['<', '>'],
  ['+', '-'],
  ['*', '/', '%'],
]
// multi-char punctuators first so they win over their single-char prefixes
const PUNCT = [
  '==',
  '!=',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '=',
  '!',
  '(',
  ')',
  '{',
  '}',
  ',',
  ';',
]

/** Tokenize `.scr.c` source. Throws on an unexpected character. */
export function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
    } else if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
    } else if (c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== '"') j++
      tokens.push({kind: 'str', value: src.slice(i + 1, j), pos: i})
      i = j + 1
    } else if (isDigit(c) || (c === '.' && isDigit(src[i + 1] ?? ''))) {
      let j = i
      while (j < src.length && (isDigit(src[j]!) || src[j] === '.')) j++
      tokens.push({kind: 'num', value: src.slice(i, j), pos: i})
      i = j
    } else if (isIdentStart(c)) {
      let j = i
      while (j < src.length && isIdent(src[j]!)) j++
      tokens.push({kind: 'ident', value: src.slice(i, j), pos: i})
      i = j
    } else {
      const p = PUNCT.find((op) => src.startsWith(op, i))
      if (!p) throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`)
      tokens.push({kind: 'punct', value: p, pos: i})
      i += p.length
    }
  }
  tokens.push({kind: 'eof', value: '', pos: i})
  return tokens
}

const isDigit = (c: string): boolean => c >= '0' && c <= '9'
const isIdentStart = (c: string): boolean =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'
const isIdent = (c: string): boolean => isIdentStart(c) || isDigit(c)

// ---- AST ----

type Expr =
  | {t: 'num'; value: number}
  | {t: 'str'; value: string}
  | {t: 'var'; name: string}
  | {t: 'call'; name: string; args: Expr[]}
  | {t: 'bin'; op: string; l: Expr; r: Expr}
  | {t: 'unary'; op: string; e: Expr}

type Stmt =
  | {t: 'expr'; e: Expr}
  | {t: 'assign'; name: string; e: Expr}
  | {t: 'if'; cond: Expr; thenBody: Stmt[]; else: Stmt[] | null}
  | {t: 'while'; cond: Expr; body: Stmt[]}
  | {t: 'return'}

interface Func {
  name: string
  params: string[]
  body: Stmt[]
}

/** A parsed program: module-level global variables and event-handler functions. */
export interface Program {
  /** Global variable names, in declaration order; each occupies one persistent slot. */
  globals: string[]
  funcs: Func[]
}

// ---- parser (recursive descent) ----

/** Parse tokens into module-level globals and function (event-handler) definitions. */
export function parse(tokens: Token[]): Program {
  let p = 0
  const peek = (): Token => tokens[p]!
  const next = (): Token => tokens[p++]!
  const isPunct = (v: string): boolean => peek().kind === 'punct' && peek().value === v
  const eat = (v: string): void => {
    if (!isPunct(v))
      throw new Error(
        `expected ${JSON.stringify(v)} at ${peek().pos}, got ${JSON.stringify(peek().value)}`,
      )
    p++
  }

  const funcs: Func[] = []
  const globals: string[] = []
  while (peek().kind !== 'eof') {
    if (isGlobalDecl()) globals.push(parseGlobal())
    else funcs.push(parseFunc())
  }
  return {globals, funcs}

  // A top-level declaration is a global unless an identifier is followed by `(`
  // (which makes it a function), ignoring a leading `float`/`void` return type.
  function isGlobalDecl(): boolean {
    let k = p
    if (tokens[k]!.value === 'float' || tokens[k]!.value === 'void') k++
    const after = tokens[k + 1]
    return !(after?.kind === 'punct' && after.value === '(')
  }

  function parseGlobal(): string {
    if (peek().value === 'float') next()
    const name = next().value
    if (isPunct('=')) {
      next()
      parseExpr() // initializer is parsed for validity but dropped - CPARSE zero-inits globals
    }
    eat(';')
    return name
  }

  function parseFunc(): Func {
    if (peek().kind === 'ident' && (peek().value === 'void' || peek().value === 'float')) next() // optional return type
    const name = next().value
    eat('(')
    const params: string[] = []
    while (!isPunct(')')) {
      if (peek().kind === 'ident' && peek().value === 'float') next() // 'float' before param
      params.push(next().value)
      if (isPunct(',')) next()
    }
    eat(')')
    return {name, params, body: parseBlock()}
  }

  function parseBlock(): Stmt[] {
    const stmts: Stmt[] = []
    if (isPunct('{')) {
      eat('{')
      while (!isPunct('}')) {
        const s = parseStmt()
        if (s) stmts.push(s)
      }
      eat('}')
    } else {
      const s = parseStmt()
      if (s) stmts.push(s)
    }
    return stmts
  }

  function parseStmt(): Stmt | null {
    const tk = peek()
    if (tk.kind === 'ident' && tk.value === 'float') {
      // Function-body locals don't exist: CPARSE silently compiles such a body to an
      // empty handler. Reject them so the footgun surfaces - use a global instead.
      throw new Error(
        `local variables are not supported at ${tk.pos}; declare a module-level global instead`,
      )
    }
    if (tk.kind === 'ident' && tk.value === 'if') {
      next()
      eat('(')
      const cond = parseExpr()
      eat(')')
      const thenBody = parseBlock()
      let els: Stmt[] | null = null
      if (peek().kind === 'ident' && peek().value === 'else') {
        next()
        els = parseBlock()
      }
      return {t: 'if', cond, thenBody, else: els}
    }
    if (tk.kind === 'ident' && tk.value === 'while') {
      next()
      eat('(')
      const cond = parseExpr()
      eat(')')
      return {t: 'while', cond, body: parseBlock()}
    }
    if (tk.kind === 'ident' && tk.value === 'return') {
      next()
      eat(';')
      return {t: 'return'}
    }
    // assignment or expression-statement
    if (tk.kind === 'ident' && tokens[p + 1]?.value === '=' && tokens[p + 1]?.kind === 'punct') {
      const name = next().value
      eat('=')
      const e = parseExpr()
      eat(';')
      return {t: 'assign', name, e}
    }
    const e = parseExpr()
    eat(';')
    return {t: 'expr', e}
  }

  // expression precedence: equality < relational < additive < multiplicative < unary < primary
  function parseExpr(): Expr {
    return parseBinary(0)
  }
  function parseBinary(level: number): Expr {
    if (level >= LEVELS.length) return parseUnary()
    let left = parseBinary(level + 1)
    while (peek().kind === 'punct' && LEVELS[level]!.includes(peek().value)) {
      const op = next().value
      left = {t: 'bin', op, l: left, r: parseBinary(level + 1)}
    }
    return left
  }
  function parseUnary(): Expr {
    if (isPunct('-') || isPunct('!')) {
      const op = next().value
      const e = parseUnary()
      if (op === '-' && e.t === 'num') return {t: 'num', value: -e.value} // fold `-1` → literal
      return {t: 'unary', op, e}
    }
    return parsePrimary()
  }
  function parsePrimary(): Expr {
    const tk = peek()
    if (isPunct('(')) {
      eat('(')
      const e = parseExpr()
      eat(')')
      return e
    }
    if (tk.kind === 'num') {
      next()
      return {t: 'num', value: Number(tk.value)}
    }
    if (tk.kind === 'str') {
      next()
      return {t: 'str', value: tk.value}
    }
    if (tk.kind === 'ident') {
      next()
      if (isPunct('(')) {
        eat('(')
        const args: Expr[] = []
        while (!isPunct(')')) {
          args.push(parseExpr())
          if (isPunct(',')) next()
        }
        eat(')')
        return {t: 'call', name: tk.value, args}
      }
      // A named script constant (MYSELF, VISIBLE, ON, PATROL, …) resolves to its
      // number - the inverse of the decompiler's symbolization. Checked after the
      // call test (a constant is never called) and before treating it as a variable.
      const constant = SCRIPT_CONSTANTS[tk.value]
      if (constant !== undefined) return {t: 'num', value: constant}
      return {t: 'var', name: tk.value}
    }
    throw new Error(`unexpected token ${JSON.stringify(tk.value)} at ${tk.pos}`)
  }
}

// ---- codegen ----

/** One emitted instruction; `arg` is a variable index, float, string, or jump target. */
export interface CompiledInstruction {
  opcode: number
  arg: number | string | null
}

/** A compiled handler: its name, parameters, and emitted instruction stream. */
export interface CompiledHandler {
  name: string
  params: string[]
  /** Slot index of each parameter (params follow the shared globals). */
  paramSlots: number[]
  /** Total variable storage in bytes: `(globals + params) × 4`. */
  varBytes: number
  code: CompiledInstruction[]
}

const OP = {
  mul: 0x01,
  div: 0x02,
  add: 0x03,
  sub: 0x04,
  store: 0x05,
  pushvar: 0x06,
  pushf: 0x07,
  pushs: 0x08,
  eqz: 0x09,
  ltz: 0x0a,
  pop: 0x0b,
  jmp: 0x0c,
  jz: 0x0d,
  mod: 0x0f,
  call: 0x10,
}

/**
 * Compile source to per-handler instruction streams (the verifiable bytecode core).
 * Jump targets are resolved to instruction indices, matching the on-disk encoding.
 *
 * @param src - `.scr.c` source text.
 */
export function compileSource(src: string): CompiledHandler[] {
  const {globals, funcs} = parse(tokenize(src))
  // One flat slot space per script: globals first, then every handler's params in
  // declaration order. `varBytes` (shared by all handlers) covers the whole space.
  let nextSlot = globals.length
  const alloc = funcs.map((fn) => ({fn, paramSlots: fn.params.map(() => nextSlot++)}))
  const varBytes = nextSlot * 4
  return alloc.map(({fn, paramSlots}) => ({
    name: fn.name,
    params: fn.params,
    paramSlots,
    varBytes,
    code: emitHandler(fn, globals, paramSlots),
  }))
}

// Deterministic pointer slots CPARSE bakes into the handler descriptor; the engine
// relocates them at load (BindScript), so the values are placeholders. PTR1 is a
// true constant across CPARSE versions; PTR2/PTR3 are our CPARSE build's addresses
// (kept here so output matches it byte-for-byte).
const PTR1 = 0x439868
const PTR2 = 0x22f9e8
const PTR3 = 0x4048a1

/** Serialize an instruction stream to bytes: `[u8 op][u16 operandLen][operand]`. */
function serializeBytecode(code: CompiledInstruction[]): number[] {
  const out: number[] = []
  const u16 = (v: number): void => void out.push(v & 0xff, (v >> 8) & 0xff)
  const f32 = (v: number): void => {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setFloat32(0, v, true)
    out.push(...b)
  }
  const cstr = (s: string): void => {
    const bytes = [...new TextEncoder().encode(s), 0]
    u16(bytes.length)
    out.push(...bytes)
  }
  for (const ins of code) {
    out.push(ins.opcode)
    if (ins.opcode === 0x06) {
      u16(2)
      u16(ins.arg as number)
    } // pushvar: u16 index
    else if (ins.opcode === 0x07) {
      u16(4)
      f32(ins.arg as number)
    } // pushf: f32
    else if (ins.opcode === 0x08 || ins.opcode === 0x10)
      cstr(ins.arg as string) // pushs / call
    else if (ins.opcode === 0x0c || ins.opcode === 0x0d) {
      u16(4)
      const t = ins.arg as number
      out.push(t & 0xff, (t >> 8) & 0xff, (t >> 16) & 0xff, (t >>> 24) & 0xff)
    } // jump: u32 target
    else u16(0) // operand-less
  }
  return out
}

/**
 * Compile source to a complete, loadable `.scr` file (header + per-handler
 * descriptors + bytecode). Supports any number of handlers, parameters, and
 * module-level globals - reproducing `CPARSE.EXE` output byte-for-byte (verified by
 * the diff harness). Handler names must be ≤ 7 characters (CPARSE stores them in a
 * fixed 8-byte buffer and overflows longer names - a bug we refuse to reproduce).
 *
 * Layout: descriptors are emitted in **reverse** declaration order; each carries the
 * instruction index where its bytecode begins in the combined stream, and the last
 * descriptor additionally carries the total instruction count. The handlers' bytecode
 * follows, concatenated in **declaration** order.
 *
 * @param src - `.scr.c` source text.
 */
export function compileScript(src: string): Uint8Array {
  const handlers = compileSource(src)
  if (handlers.length === 0) throw new Error('compileScript: no handlers to compile')
  const varBytes = handlers[0]!.varBytes // the shared slot-space size (same for all handlers)
  const out: number[] = []
  const u16 = (v: number): void => void out.push(v & 0xff, (v >> 8) & 0xff)
  const u32 = (v: number): void => {
    u16(v & 0xffff)
    u16((v >>> 16) & 0xffff)
  }

  // The instruction index where each handler's bytecode begins in the combined stream.
  const startIndex: number[] = []
  let total = 0
  for (const h of handlers) {
    startIndex.push(total)
    total += h.code.length
  }

  u32(varBytes)
  u32(handlers.length)
  // Descriptors run in reverse declaration order; the final one (the first-declared
  // handler) carries the total instruction count just before the bytecode.
  for (let di = 0; di < handlers.length; di++) {
    const hi = handlers.length - 1 - di
    const h = handlers[hi]!
    writeDescriptorPrefix(out, h.name, varBytes)
    u16(startIndex[hi]!)
    u16(h.params.length)
    u32(4)
    for (const slot of h.paramSlots) u16(slot)
    if (di === handlers.length - 1) u32(total)
  }
  // Jump targets are stored absolute (combined-stream indices), so shift each handler's
  // local targets by its start offset before serializing.
  for (let hi = 0; hi < handlers.length; hi++) {
    const off = startIndex[hi]!
    const code =
      off === 0
        ? handlers[hi]!.code
        : handlers[hi]!.code.map((ins) =>
            ins.opcode === 0x0c || ins.opcode === 0x0d
              ? {...ins, arg: (ins.arg as number) + off}
              : ins,
          )
    out.push(...serializeBytecode(code))
  }
  return Uint8Array.from(out)
}

/**
 * Write a handler descriptor's leading **32 bytes**: the name (NUL-terminated) over CPARSE's
 * pointer/constant template - `u32 [4, 0, PTR1, varBytes, PTR2, PTR3]` after an 8-byte name
 * slot, with `startIndex`/`nParams`/slots following at +32. CPARSE keeps names in the first 8
 * bytes, but the descriptor reserves the whole leading region and the engine reads the name
 * NUL-terminated, recomputing the (don't-care) baked pointers at load - so a longer name (up to
 * **27 chars**, NUL within the 28-byte region the loader scans) simply overwrites those pointer
 * fields. This is byte-identical to CPARSE for names ≤ 7 chars, and unlocks the many real
 * callbacks that are longer (`seeplayer`, `Destroyed`, `EnterVehicle`, `ItemActivated`, …).
 */
const le32 = (v: number): number[] => [
  v & 0xff,
  (v >> 8) & 0xff,
  (v >> 16) & 0xff,
  (v >>> 24) & 0xff,
]

function writeDescriptorPrefix(out: number[], name: string, varBytes: number): void {
  const bytes = new TextEncoder().encode(name)
  if (bytes.length > 27) throw new Error(`handler name "${name}" exceeds 27 characters`)
  const buf = [
    0,
    0,
    0,
    0,
    0xf0,
    0x76,
    0x43,
    0x00, // 8-byte name slot (CPARSE high constant 0x004376f0)
    ...le32(4),
    ...le32(0),
    ...le32(PTR1), // +8, +12, +16
    ...le32(varBytes),
    ...le32(PTR2),
    ...le32(PTR3), // +20, +24, +28  (→ 32 bytes total)
  ]
  for (let i = 0; i < bytes.length; i++) buf[i] = bytes[i]!
  buf[bytes.length] = 0 // NUL terminator
  out.push(...buf)
}

function emitHandler(fn: Func, globals: string[], paramSlots: number[]): CompiledInstruction[] {
  const out: CompiledInstruction[] = []
  // labels are recorded as instruction indices and patched after layout
  const fixups: Array<{at: number; label: number}> = []
  const labels: number[] = []
  const emit = (opcode: number, arg: number | string | null = null): number =>
    out.push({opcode, arg}) - 1
  const newLabel = (): number => labels.push(-1) - 1
  const mark = (label: number): void => {
    labels[label] = out.length
  }
  const emitJump = (opcode: number, label: number): void => {
    fixups.push({at: emit(opcode, 0), label})
  }

  // Globals occupy the low slots (shared across handlers); this handler's params sit
  // at the slots allocated to it (after the globals and any earlier handlers' params).
  const varIndex = (name: string): number => {
    const g = globals.indexOf(name)
    if (g >= 0) return g
    const pi = fn.params.indexOf(name)
    if (pi >= 0) return paramSlots[pi]!
    throw new Error(`variable "${name}" not declared`)
  }

  const expr = (e: Expr): void => {
    switch (e.t) {
      case 'num':
        emit(OP.pushf, e.value)
        break
      case 'str':
        emit(OP.pushs, e.value)
        break
      case 'var':
        emit(OP.pushvar, varIndex(e.name))
        break
      case 'call':
        for (const a of e.args) expr(a)
        emit(OP.call, e.name)
        break
      case 'unary':
        if (e.op === '-') {
          expr(e.e)
          emit(OP.pushf, -1)
          emit(OP.mul)
        } // -x → x * -1
        else {
          expr(e.e)
          emit(OP.eqz)
        } // !x → (x == 0)
        break
      case 'bin':
        emitBinary(e)
        break
    }
  }
  const emitBinary = (e: {op: string; l: Expr; r: Expr}): void => {
    const arith: Record<string, number> = {
      '+': OP.add,
      '-': OP.sub,
      '*': OP.mul,
      '/': OP.div,
      '%': OP.mod,
    }
    if (e.op in arith) {
      expr(e.l)
      expr(e.r)
      emit(arith[e.op]!)
      return
    }
    // comparisons synthesize from subtract: '>' swaps operands; '==' adds eqz; '<' adds ltz
    if (e.op === '>') {
      expr(e.r)
      expr(e.l)
      emit(OP.sub)
      emit(OP.ltz)
      return
    }
    expr(e.l)
    expr(e.r)
    emit(OP.sub)
    if (e.op === '<') emit(OP.ltz)
    else if (e.op === '==') emit(OP.eqz)
    // '!=' leaves the raw subtract (non-zero = true)
  }

  // CPARSE emits no per-statement pop; one epilogue `pop` at the end discards the
  // final leftover, and `if`/`while` exits and `return` all target it.
  const functionEnd = newLabel()
  const stmt = (s: Stmt): void => {
    switch (s.t) {
      case 'expr':
        expr(s.e)
        break
      case 'assign':
        emit(OP.pushvar, varIndex(s.name))
        expr(s.e)
        emit(OP.store)
        break
      case 'return':
        emitJump(OP.jmp, functionEnd)
        break
      case 'if': {
        const end = newLabel()
        expr(s.cond)
        const elseL = s.else ? newLabel() : end
        emitJump(OP.jz, elseL)
        for (const b of s.thenBody) stmt(b)
        if (s.else) {
          emitJump(OP.jmp, end)
          mark(elseL)
          for (const b of s.else) stmt(b)
        }
        mark(end)
        break
      }
      case 'while': {
        const top = newLabel(),
          end = newLabel()
        mark(top)
        expr(s.cond)
        emitJump(OP.jz, end)
        for (const b of s.body) stmt(b)
        emitJump(OP.jmp, top)
        mark(end)
        break
      }
    }
  }

  for (const s of fn.body) stmt(s)
  mark(functionEnd)
  emit(OP.pop) // epilogue
  for (const f of fixups) out[f.at]!.arg = labels[f.label]!
  return out
}
