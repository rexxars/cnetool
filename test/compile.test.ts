import {describe, expect, test} from 'vitest'

import {
  compileScript,
  compileSource,
  decompileScript,
  parse,
  parseScript,
  tokenize,
} from '../src/index.ts'

/** Compact "op(arg)" form, matching the diff harness, for asserting a stream. */
const stream = (code: {opcode: number; arg: number | string | null}[]): string[] =>
  code.map((i) => `${i.opcode.toString(16).padStart(2, '0')}${i.arg !== null ? `(${i.arg})` : ''}`)

describe('tokenize / parse', () => {
  test('tokenizes literals, idents, operators, and skips comments', () => {
    const toks = tokenize('a = b + 1; // note\nREFFoo("x");')
    expect(toks.map((t) => t.value)).toEqual([
      'a',
      '=',
      'b',
      '+',
      '1',
      ';',
      'REFFoo',
      '(',
      'x',
      ')',
      ';',
      '',
    ])
  })

  test('parses a handler with params and a call', () => {
    const {funcs} = parse(tokenize('startup(float a) { REFExplode(a); }'))
    expect(funcs).toHaveLength(1)
    expect(funcs[0]!.name).toBe('startup')
    expect(funcs[0]!.params).toEqual(['a'])
  })

  test('separates module-level globals from handlers', () => {
    const {globals, funcs} = parse(tokenize('float g; float h = 2; startup() { g = 1; }'))
    expect(globals).toEqual(['g', 'h'])
    expect(funcs.map((f) => f.name)).toEqual(['startup'])
  })
})

describe('compileSource - bytecode matches CPARSE (verified via the diff harness)', () => {
  test('call with arithmetic', () => {
    const [h] = compileSource('startup(float a, float b) { REFSetTTL(a + b, 0); }')
    expect(h!.name).toBe('startup')
    expect(stream(h!.code)).toEqual(['06(0)', '06(1)', '03', '07(0)', '10(REFSetTTL)', '0b'])
  })

  test('assignment (one epilogue pop, no per-statement pop)', () => {
    const [h] = compileSource('startup(float a, float b) { a = a * b; }')
    expect(stream(h!.code)).toEqual(['06(0)', '06(0)', '06(1)', '01', '05', '0b'])
  })

  test('`<` synthesized as subtract + ltz; `if` exit jumps to the epilogue', () => {
    const [h] = compileSource('startup(float a, float b) { if (a < b) REFSetTTL(a, 0); }')
    expect(stream(h!.code)).toEqual([
      '06(0)',
      '06(1)',
      '04',
      '0a',
      '0d(8)',
      '06(0)',
      '07(0)',
      '10(REFSetTTL)',
      '0b',
    ])
  })

  test('`while` loops back with 0c and exits with 0d to the trailing pop', () => {
    const [h] = compileSource('startup(float a, float b) { while (a < b) REFSetTTL(a, 0); }')
    expect(stream(h!.code)).toEqual([
      '06(0)',
      '06(1)',
      '04',
      '0a',
      '0d(9)',
      '06(0)',
      '07(0)',
      '10(REFSetTTL)',
      '0c(0)',
      '0b',
    ])
  })

  test('`>` swaps operands; MYSELF and unary `-` lower as float -1', () => {
    const [gt] = compileSource('startup(float a, float b) { if (a > b) REFSetTTL(MYSELF, 0); }')
    // a > b → push b, push a, sub, ltz
    expect(stream(gt!.code).slice(0, 4)).toEqual(['06(1)', '06(0)', '04', '0a'])
    expect(gt!.code.find((i) => i.opcode === 0x10 && i.arg === 'REFSetTTL')).toBeDefined()
    const [neg] = compileSource('startup(float a) { REFSetTTL(-a, 0); }')
    expect(stream(neg!.code)).toEqual(['06(0)', '07(-1)', '01', '07(0)', '10(REFSetTTL)', '0b'])
  })

  test('rejects operators outside the language (`<=`)', () => {
    expect(() => compileSource('startup(float a, float b) { a = a <= b; }')).toThrow()
  })

  test('globals take the low slots; params follow', () => {
    // float g → slot 0; param a → slot 1. `g = a` → push g, push a, store.
    const [h] = compileSource('float g; startup(float a) { g = a; REFSetTTL(g, 0); }')
    expect(h!.paramSlots).toEqual([1])
    expect(h!.varBytes).toBe(8) // (1 global + 1 param) × 4
    expect(stream(h!.code)).toEqual([
      '06(0)',
      '06(1)',
      '05',
      '06(0)',
      '07(0)',
      '10(REFSetTTL)',
      '0b',
    ])
  })

  test('globals are indexed in declaration order, shared, allocated even if unused', () => {
    const [h] = compileSource('float a; float b; float c; startup() { b = 5; }')
    expect(h!.varBytes).toBe(12) // 3 globals × 4
    expect(stream(h!.code)).toEqual(['06(1)', '07(5)', '05', '0b'])
  })

  test('rejects function-body locals (CPARSE emits an empty body for them)', () => {
    expect(() => compileSource('startup() { float x; x = 1; }')).toThrow(
      /local variables are not supported/,
    )
  })

  test('rejects an undeclared variable', () => {
    expect(() => compileSource('startup() { x = 1; }')).toThrow(/not declared/)
  })
})

describe('compileScript - full .scr emission (matches CPARSE byte-for-byte)', () => {
  const src = 'startup(float a, float b) { if (a < b) REFSetTTL(a, 0); }'

  test('emits a header with paramBytes and handler count', () => {
    const scr = compileScript(src)
    const dv = new DataView(scr.buffer, scr.byteOffset, scr.byteLength)
    expect(dv.getUint32(0, true)).toBe(8) // 2 params × 4
    expect(dv.getUint32(4, true)).toBe(1) // one handler
    expect(new TextDecoder().decode(scr.subarray(8, 15))).toBe('startup')
  })

  test('round-trips back through parseScript', () => {
    const parsed = parseScript(compileScript(src))
    expect(parsed.paramBytes).toBe(8)
    expect(parsed.handlers[0]!.name).toBe('startup')
    const expected = compileSource(src)[0]!.code
    expect(parsed.handlers[0]!.code.map((i) => [i.opcode, i.arg])).toEqual(
      expected.map((i) => [i.opcode, i.arg]),
    )
  })

  test('encodes globals: paramBytes covers globals + params, param slots follow', () => {
    const scr = compileScript('float g; startup(float a) { g = a; REFSetTTL(g, 0); }')
    const dv = new DataView(scr.buffer, scr.byteOffset, scr.byteLength)
    expect(dv.getUint32(0, true)).toBe(8) // (1 global + 1 param) × 4
    const parsed = parseScript(scr)
    expect(parsed.handlers[0]!.code.map((i) => [i.opcode, i.arg])).toEqual(
      compileSource('float g; startup(float a) { g = a; REFSetTTL(g, 0); }')[0]!.code.map((i) => [
        i.opcode,
        i.arg,
      ]),
    )
  })

  test('emits multiple handlers: declaration-order bytecode, all instructions present', () => {
    const scr = compileScript(
      'aaa() { REFExplode(1); } bbb() { REFExplode(2); } ccc() { REFExplode(3); }',
    )
    const dv = new DataView(scr.buffer, scr.byteOffset, scr.byteLength)
    expect(dv.getUint32(4, true)).toBe(3) // handler count
    const parsed = parseScript(scr)
    // 3 handlers × (pushf, call, pop) = 9 instructions in the combined stream
    expect(parsed.handlers.reduce((n, h) => n + h.code.length, 0)).toBe(9)
    const pushed = parsed.handlers.flatMap((h) =>
      h.code.filter((i) => i.opcode === 0x07).map((i) => i.arg),
    )
    expect(pushed).toEqual([1, 2, 3]) // bytecode is concatenated in declaration order
  })

  test('multi-handler jump targets are absolute on disk and round-trip back to local', () => {
    // foo = call+pop (2 instrs); bar's jz must be stored absolute (offset by foo), matching CPARSE.
    const scr = compileScript(
      'foo() { REFDeleteAI(); } bar(float a, float b) { if (a < b) REFExplode(a); }',
    )
    const dv = new DataView(scr.buffer, scr.byteOffset, scr.byteLength)
    // locate the jz (0x0d) operand in the raw bytecode and check it points past foo (>= 2)
    let jzTarget = -1
    for (let i = 8; i < scr.length - 7; i++) {
      if (scr[i] === 0x0d && dv.getUint16(i + 1, true) === 4) jzTarget = dv.getUint32(i + 3, true)
    }
    expect(jzTarget).toBeGreaterThanOrEqual(2) // absolute (would be < 2 if wrongly local)
    // parseScript rebases it to local; bar decompiles to a valid if (not garbage flow)
    const out = decompileScript(parseScript(scr))
    expect(out).toContain('bar(v0, v1)')
    expect(out).toMatch(/if \(\(v0 < v1\)\) \{\n\s*REFExplode\(v0\);\n\s*\}/)
  })

  test('shares the slot space across handlers (globals, then each handler’s params)', () => {
    const [aaa, bbb] = compileSource(
      'float g; aaa(float x) { g = x; } bbb(float y) { REFExplode(y); }',
    )
    expect(aaa!.paramSlots).toEqual([1]) // g=0, aaa.x=1
    expect(bbb!.paramSlots).toEqual([2]) // bbb.y=2
    expect(aaa!.varBytes).toBe(12) // (1 global + 2 params) × 4, shared by all handlers
    expect(bbb!.varBytes).toBe(12)
  })

  test('accepts handler names up to 27 chars (real callbacks like ItemActivated) and rejects longer', () => {
    // The descriptor reserves a wide leading region; the engine reads the name NUL-terminated.
    // Names ≤ 27 chars compile (many real callbacks exceed 7: ItemActivated, EnterVehicle, …).
    const bc = compileScript('ItemActivated() { REFDeleteAI(); }')
    expect(parseScript(bc).handlers[0]!.name).toBe('ItemActivated')
    expect(() => compileScript('aTwentyEightCharacterHandlerX() { REFDeleteAI(); }')).toThrow(
      /27 characters/,
    )
  })

  test('decompiling a compiled global script recovers the globals and signature', () => {
    const out = decompileScript(
      parseScript(compileScript('float g; startup(float a) { g = a; REFSetTTL(g, 0); }')),
    )
    expect(out).toContain('float g0;') // the shared global, declared up front
    expect(out).toContain('Startup(v0)') // one param; name normalized to canonical casing
    expect(out).toContain('g0 = v0') // global assigned the param
  })

  test('REFCallScript variadic args + delay survive decompile→recompile byte-for-byte', () => {
    // REFCallScript is variadic: [handlerArg…], target(str), instance(num), handler(str), [delay(num)].
    // The decompiler used to drop the leading handler args (it popped a fixed 3/4 operands), making
    // the round-trip lossy. Exercise every shape - with/without leading args, with/without delay -
    // and assert the bytecode is byte-identical after decompile→recompile (both paths share cetool's
    // compiler, so the descriptor layout matches and any difference is a genuine args/delay loss).
    const callScriptSrc = [
      'Trig() {',
      '  REFCallScript(1, "RedLower", 0, "ChangeClothes", 0.5);', // 1 arg + delay (the red.scr repro)
      '  REFCallScript(1, "mainscr", 0, "SetIsGuard");', // 1 arg, no delay (string handler on top)
      '  REFCallScript("", 0, "Show", 0.25);', // 0 args + delay
      '  REFCallScript("door", 1, "Open");', // 0 args, no delay
      '  REFCallScript(5, 7, "npc", 0, "Poke", 2);', // 2 args + delay
      '}',
    ].join('\n')
    const first = compileScript(callScriptSrc)
    const decompiled = decompileScript(parseScript(first))
    // The leading handler args are preserved (not stripped) in every form.
    expect(decompiled).toContain('REFCallScript(1, "RedLower", 0, "ChangeClothes", 0.5);')
    expect(decompiled).toContain('REFCallScript(1, "mainscr", 0, "SetIsGuard");')
    expect(decompiled).toContain('REFCallScript(5, 7, "npc", 0, "Poke", 2);')
    // …and no args are invented for the plain 3/4-operand forms.
    expect(decompiled).toContain('REFCallScript("door", 1, "Open");')
    expect(decompiled).toMatch(/REFCallScript\("", 0, "Show", [\d.]+\);/)
    const second = compileScript(decompiled)
    expect([...second]).toEqual([...first]) // byte-for-byte
  })

  test('symbolic REF constants decompile with names and recompile byte-for-byte', () => {
    // Selector args and their (context-dependent) value args decompile to SDK
    // constant names; the compiler resolves them back to the same numbers, so the
    // bytecode is identical. Value args on non-boolean slots stay numeric.
    const symbolicSrc = [
      'Startup(p) {',
      '  REFSetProjectVars(MYSELF, VISIBLE, ON);',
      '  REFSetProjectVars(MYSELF, MASS, 800);',
      '  REFSetAIVars("", MODE, PATROL);',
      '  REFSetAIVars("", SEERADIUS, 2000);',
      '  REFChangePlayer(p, HEALTH, -10);',
      '  REFSetScore(TEAMA, FLAG_SCORE, 1);', // TEAMA is compilable; arg0 isn't auto-symbolized back
      '}',
    ].join('\n')
    const first = compileScript(symbolicSrc)
    const decompiled = decompileScript(parseScript(first))
    expect(decompiled).toContain('REFSetProjectVars(MYSELF, VISIBLE, ON);')
    expect(decompiled).toContain('REFSetProjectVars(MYSELF, MASS, 800);') // slot 9 isn't boolean → numeric value
    expect(decompiled).toContain('REFSetAIVars("", MODE, PATROL);')
    expect(decompiled).toContain('REFSetAIVars("", SEERADIUS, 2000);')
    expect(decompiled).toMatch(/REFChangePlayer\(\w+, HEALTH, -10\);/)
    expect(decompiled).toContain('REFSetScore(0, FLAG_SCORE, 1);') // mode named; team arg left numeric (see note)
    const second = compileScript(decompiled)
    expect([...second]).toEqual([...first]) // byte-for-byte
  })

  test('compiler treats symbolic and numeric REF args identically', () => {
    const numeric = compileScript('S() {\n  REFSetProjectVars(-1, 12, 1);\n}')
    const symbolic = compileScript('S() {\n  REFSetProjectVars(MYSELF, VISIBLE, ON);\n}')
    expect([...symbolic]).toEqual([...numeric])
  })

  test('multi-handler round-trip recovers names in declaration order, globals, and per-handler params', () => {
    const source =
      'float g; aaa(float x) { g = x; } bbb(float y) { REFExplode(y); } ccc() { REFExplode(g); }'
    const parsed = parseScript(compileScript(source))
    expect(parsed.handlers.map((h) => h.name)).toEqual(['aaa', 'bbb', 'ccc']) // declaration order, not the file's reverse order
    expect(parsed.handlers.map((h) => h.paramCount)).toEqual([1, 1, 0])
    const out = decompileScript(parsed)
    expect(out).toContain('float g0;')
    expect(out).toContain('aaa(v0) {\n  g0 = v0;') // x is the handler's own param → v0
    expect(out).toContain('bbb(v0) {\n  REFExplode(v0);') // y → v0 within bbb
    expect(out).toContain('ccc() {\n  REFExplode(g0);') // references the shared global
  })
})
