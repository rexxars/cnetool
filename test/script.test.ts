import {describe, expect, test} from 'vitest'

import {
  decompileScript,
  disassembleScript,
  parseScript,
  selfDestructsAtSpawn,
} from '../src/index.ts'

const le16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff]
const le32 = (v: number): number[] => [
  v & 0xff,
  (v >> 8) & 0xff,
  (v >> 16) & 0xff,
  (v >>> 24) & 0xff,
]
const f32 = (v: number): number[] => {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setFloat32(0, v, true)
  return [...b]
}
const str = (s: string): number[] => [...new TextEncoder().encode(s), 0]
/** One instruction: opcode + u16 operand length + operand bytes. */
const ins = (op: number, operand: number[] = []): number[] => [
  op,
  ...le16(operand.length),
  ...operand,
]

/** A single-handler `.scr`: header + name + undecodable metadata + the given bytecode. */
const scriptWith = (paramBytes: number, name: string, bytecode: number[]): Uint8Array =>
  Uint8Array.from([
    ...le32(paramBytes),
    ...le32(1),
    ...str(name),
    0xff,
    0xff,
    0xff,
    0xff,
    ...bytecode,
  ])

/**
 * A minimal `.scr`: header + one handler "startup", a metadata block whose bytes
 * are `> 0x10` (so it can't decode as bytecode - mirrors the real baked-pointer
 * descriptor), then the bytecode. Body: `if (a < 0) 1.5;` →
 * pushvar $0, ltz, jz->3, pushf 1.5, then call + pop.
 */
function buildScript(): Uint8Array {
  const bytecode = [
    ...ins(0x06, le16(0)), // pushvar $0
    ...ins(0x0a), // ltz
    ...ins(0x0d, le32(3)), // jz -> instruction 3
    ...ins(0x07, f32(1.5)), // pushf 1.5
    ...ins(0x10, str('REFSetTTL')), // call
    ...ins(0x0b), // pop
  ]
  return Uint8Array.from([
    ...le32(4), // paramBytes
    ...le32(1), // handlerCount
    ...str('startup'), // handler name
    0xff,
    0xff,
    0xff,
    0xff, // metadata (undecodable, like baked pointers)
    ...bytecode,
  ])
}

describe('parseScript', () => {
  const script = parseScript(buildScript())

  test('parses the header and handler name', () => {
    expect(script.paramBytes).toBe(4)
    expect(script.handlers).toHaveLength(1)
    expect(script.handlers[0]!.name).toBe('startup')
  })

  test('decodes opcodes, operands, and a synthesized comparison', () => {
    const code = script.handlers[0]!.code
    expect(code.map((i) => i.mnemonic)).toEqual(['pushvar', 'ltz', 'jz', 'pushf', 'call', 'ret'])
    expect(code[0]!.arg).toBe(0) // variable index
    expect(code[3]!.arg).toBe(1.5) // float literal
    expect(code[4]!.arg).toBe('REFSetTTL') // call resolves the REF name
  })

  test('resolves a jump target to an instruction index', () => {
    const jz = script.handlers[0]!.code.find((i) => i.mnemonic === 'jz')!
    expect(jz.arg).toBe(3)
    expect(script.handlers[0]!.code[3]!.mnemonic).toBe('pushf') // index 3 is the jump target
  })

  test('disassembles to a readable listing', () => {
    const text = disassembleScript(script)
    expect(text).toContain('startup:')
    expect(text).toContain('jz -> 3')
    expect(text).toContain('call "REFSetTTL"')
  })

  test('tolerates a too-small blob', () => {
    expect(parseScript(Uint8Array.from([0, 0]))).toEqual({paramBytes: 0, handlers: []})
  })

  test('parses the shipped-game descriptor variant (28-byte name region, two pointers)', () => {
    // Descriptor: [name in a 28-byte region][u32 ptr_a][u16 startIndex][u16 nParams]
    // [u32 ptr_b][u16 slots…]; the last descriptor carries the total instruction count.
    const desc = (
      name: string,
      startIndex: number,
      nParams: number,
      last: boolean,
      total: number,
    ): number[] => {
      const region = new Uint8Array(28)
      region.set(new TextEncoder().encode(name)) // NUL-terminated, rest zero
      new DataView(region.buffer).setUint32(20, 4, true) // the constant '4' dword seen in real files
      return [
        ...region,
        ...le32(0x42bc44), // ptr_a (baked, ignored)
        ...le16(startIndex),
        ...le16(nParams),
        ...le32(0x66f978), // ptr_b (baked, ignored)
        ...(last ? le32(total) : []),
      ]
    }
    const code = [...ins(0x10, str('REFDeleteAI')), ...ins(0x0b)] // call + pop = 2 instructions
    const blob = Uint8Array.from([
      ...le32(0), // word0
      ...le32(2), // handlerCount
      ...desc('Touched', 2, 0, false, 0), // declared 2nd → appears 1st (reverse order)
      ...desc('startup', 0, 0, true, 4), // declared 1st → last descriptor, carries the total
      ...code, // bytecode in declaration order: startup …
      ...code, // … then Touched
    ])
    const p = parseScript(blob)
    expect(p.handlers.map((h) => h.name)).toEqual(['startup', 'Touched']) // declaration order recovered from startIndex
    expect(p.handlers.map((h) => h.paramCount)).toEqual([0, 0])
    expect(p.handlers.map((h) => h.code.length)).toEqual([2, 2])
  })
})

describe('decompileScript', () => {
  test('reconstructs an assignment and a REF call (args grouped by arity)', () => {
    const out = decompileScript(
      parseScript(
        scriptWith(8, 'startup', [
          ...ins(0x06, le16(0)), // l-value v0
          ...ins(0x06, le16(0)),
          ...ins(0x06, le16(1)),
          ...ins(0x03), // v0 + v1
          ...ins(0x05), // store
          ...ins(0x06, le16(0)),
          ...ins(0x07, f32(0)),
          ...ins(0x10, str('REFSetTTL')),
          ...ins(0x0b),
        ]),
      ),
    )
    expect(out).toContain('Startup(v0, v1)')
    expect(out).toContain('v0 = (v0 + v1);')
    expect(out).toContain('REFSetTTL(v0, 0);')
  })

  test('folds a jz into an `if` with a synthesized `<` comparison', () => {
    const out = decompileScript(
      parseScript(
        scriptWith(8, 'startup', [
          ...ins(0x06, le16(0)),
          ...ins(0x06, le16(1)),
          ...ins(0x04),
          ...ins(0x0a), // v0 < v1
          ...ins(0x0d, le32(8)), // jz -> instruction 8 (past the body)
          ...ins(0x06, le16(0)),
          ...ins(0x07, f32(0)),
          ...ins(0x10, str('REFSetTTL')),
          ...ins(0x0b),
        ]),
      ),
    )
    expect(out).toContain('if ((v0 < v1)) {')
    expect(out).toContain('REFSetTTL(v0, 0);')
  })

  test('folds an `if`-then-return chain into sibling ifs (no nested dead code, no goto)', () => {
    // if (v0 == 1) { REFDeleteAI(); return; } REFDropItem();
    const out = decompileScript(
      parseScript(
        scriptWith(4, 'startup', [
          ...ins(0x06, le16(0)),
          ...ins(0x07, f32(1)),
          ...ins(0x04),
          ...ins(0x09), // (v0 == 1)
          ...ins(0x0d, le32(7)), // jz -> 7 (skip body if false)
          ...ins(0x10, str('REFDeleteAI')), // index 5
          ...ins(0x0c, le32(8)), // jmp -> 8 (the epilogue) = return; (index 6)
          ...ins(0x10, str('REFDropItem')), // index 7 - sibling, runs when v0 != 1
          ...ins(0x0b), // pop (index 8)
        ]),
      ),
    )
    expect(out).not.toContain('goto')
    expect(out).toMatch(/if \(\(v0 == 1\)\) \{\n\s*REFDeleteAI\(\);\n\s*return;\n\s*\}/)
    expect(out).toContain('\n  REFDropItem();') // sibling at the handler's top level (2-space indent)
    expect(out).not.toContain('\n    REFDropItem();') // NOT nested (4-space) as dead code inside the if
  })

  test('renders a mid-handler `ret` (0x0b) as an early `return`, not a dropped empty body', () => {
    // if (v0 == 1) return; REFDropItem();  - the early return is a bare 0x0b (not a jmp).
    // Regression: 0x0b was mishandled as a stack pop, so the return vanished → empty `if {}`.
    const out = decompileScript(
      parseScript(
        scriptWith(4, 'startup', [
          ...ins(0x06, le16(0)),
          ...ins(0x07, f32(1)),
          ...ins(0x04),
          ...ins(0x09), // (v0 == 1)
          ...ins(0x0d, le32(6)), // jz -> 6 (skip the return when false)
          ...ins(0x0b), // index 5: mid-handler ret = early return
          ...ins(0x10, str('REFDropItem')), // index 6: runs only when v0 != 1
          ...ins(0x0b), // index 7: final terminator (implicit function end)
        ]),
      ),
    )
    expect(out).toMatch(/if \(\(v0 == 1\)\) \{\n\s*return;\n\s*\}/)
    expect(out).toContain('\n  REFDropItem();')
    expect(out).not.toContain('goto')
  })

  test('REFCallScript is variadic (3 or 4 args) and never swallows the previous statement', () => {
    // 4-arg (trailing delay): REFAddFire(v0); REFCallScript("", 0, "Show", 0.5);
    // The void REFAddFire leaves a phantom on the stack; a fixed arity of 5 used to pop it as a
    // phantom first arg → REFCallScript(REFAddFire(...), …). A number on top = delay = 4-arg.
    const withDelay = decompileScript(
      parseScript(
        scriptWith(4, 'startup', [
          ...ins(0x06, le16(0)), // v0
          ...ins(0x10, str('REFAddFire')), // void call → phantom stack result
          ...ins(0x08, str('')), // "" target
          ...ins(0x07, f32(0)), // 0 instance
          ...ins(0x08, str('Show')), // "Show" handler
          ...ins(0x07, f32(0.5)), // 0.5 delay (number on top ⇒ 4-arg)
          ...ins(0x10, str('REFCallScript')),
          ...ins(0x0b),
        ]),
      ),
    )
    expect(withDelay).toContain('REFAddFire(v0);') // a separate statement, not swallowed
    expect(withDelay).toMatch(/REFCallScript\("", 0, "Show", [\d.]+\);/)
    expect(withDelay).not.toContain('REFCallScript(REFAddFire') // the old quirk

    // 3-arg (no delay): a string handler on top ⇒ 3 args, not 4.
    const noDelay = decompileScript(
      parseScript(
        scriptWith(4, 'startup', [
          ...ins(0x08, str('door')), // target
          ...ins(0x07, f32(1)), // instance
          ...ins(0x08, str('Open')), // handler (string on top ⇒ 3-arg)
          ...ins(0x10, str('REFCallScript')),
          ...ins(0x0b),
        ]),
      ),
    )
    expect(noDelay).toContain('REFCallScript("door", 1, "Open");')
  })

  test('a discarded value-returning call stays at its call site (not scoped into a later if)', () => {
    // REFGetTime(v0)'s result lingers on the stack; the if compares unrelated vars.
    const out = decompileScript(
      parseScript(
        scriptWith(8, 'startup', [
          ...ins(0x06, le16(0)),
          ...ins(0x10, str('REFGetTime')), // REFGetTime(v0) - result discarded
          ...ins(0x06, le16(0)),
          ...ins(0x06, le16(1)),
          ...ins(0x04),
          ...ins(0x0a), // (v0 < v1)
          ...ins(0x0d, le32(8)), // jz -> 8 (skip body)
          ...ins(0x10, str('REFDeleteAI')), // body (index 7)
          ...ins(0x0b), // pop / epilogue (index 8)
        ]),
      ),
    )
    // REFGetTime appears before the if (top level), REFDeleteAI is the if body
    expect(out).toMatch(/REFGetTime\(v0\);\n\s*if \(\(v0 < v1\)\) \{\n\s*REFDeleteAI\(\);\n\s*\}/)
    expect(out).not.toMatch(/if \(\(v0 < v1\)\) \{\n\s*REFGetTime/) // not mis-scoped inside the if
  })

  test('folds a back-jump into a `while`', () => {
    const out = decompileScript(
      parseScript(
        scriptWith(8, 'startup', [
          ...ins(0x06, le16(0)),
          ...ins(0x06, le16(1)),
          ...ins(0x04),
          ...ins(0x0a), // v0 < v1
          ...ins(0x0d, le32(9)), // jz -> 9 (exit)
          ...ins(0x06, le16(0)),
          ...ins(0x07, f32(0)),
          ...ins(0x10, str('REFSetTTL')), // body
          ...ins(0x0c, le32(0)), // jmp -> 0 (loop top)
          ...ins(0x0b), // exit (index 9)
        ]),
      ),
    )
    expect(out).toContain('while ((v0 < v1)) {')
    expect(out).toContain('REFSetTTL(v0, 0);')
  })

  test('renders -1 as MYSELF', () => {
    const out = decompileScript(
      parseScript(
        scriptWith(0, 'startup', [
          ...ins(0x07, f32(-1)),
          ...ins(0x07, f32(0)),
          ...ins(0x10, str('REFSetTTL')),
          ...ins(0x0b),
        ]),
      ),
    )
    expect(out).toContain('REFSetTTL(MYSELF, 0);')
  })

  test('names known callback parameters (HitItem → object, type, player)', () => {
    const out = decompileScript(
      parseScript(
        scriptWith(12, 'HitItem', [
          ...ins(0x06, le16(2)), // v2 -> player
          ...ins(0x07, f32(1)),
          ...ins(0x07, f32(40)),
          ...ins(0x10, str('REFChangePlayer')),
          ...ins(0x0b),
        ]),
      ),
    )
    expect(out).toContain('HitItem(object, type, player)')
    expect(out).toContain('REFChangePlayer(player, AMMO, 40);')
  })

  test('supports the InWater callback (named param + canonical casing)', () => {
    const out = decompileScript(
      parseScript(
        scriptWith(4, 'inwater', [
          ...ins(0x06, le16(0)), // v0 -> object
          ...ins(0x06, le16(0)),
          ...ins(0x10, str('REFGetPlayerNr')),
          ...ins(0x0b),
        ]),
      ),
    )
    expect(out).toContain('InWater(object)')
    expect(out).toContain('REFGetPlayerNr(object, object)')
  })

  test('matches callback names case-insensitively (params + canonical casing)', () => {
    const out = decompileScript(
      parseScript(scriptWith(4, 'seeplayer', [...ins(0x06, le16(0)), ...ins(0x0b)])),
    )
    expect(out).toContain('SeePlayer(player)')
  })

  test('normalizes known callback names to canonical casing', () => {
    const variants: [string, string][] = [
      ['STARTUP', 'Startup'],
      ['StartUp', 'Startup'],
      ['heardfiring', 'HeardFiring'],
      ['activate', 'Activate'],
    ]
    const body = [...ins(0x07, f32(0)), ...ins(0x10, str('REFDropItem')), ...ins(0x0b)]
    for (const [input, canonical] of variants) {
      const out = decompileScript(parseScript(scriptWith(0, input, body)))
      expect(out).toContain(`${canonical}(`)
    }
  })

  test('leaves unknown handlers and unnamed params as written', () => {
    const out = decompileScript(
      parseScript(scriptWith(8, 'CustomThing', [...ins(0x06, le16(0)), ...ins(0x0b)])),
    )
    expect(out).toContain('CustomThing(v0, v1)')
  })
})

describe('selfDestructsAtSpawn', () => {
  const ttl = (obj: number, value: number): number[] => [
    ...ins(0x07, f32(obj)),
    ...ins(0x07, f32(value)),
    ...ins(0x10, str('REFSetTTL')),
    ...ins(0x0b),
  ]

  test('detects REFSetTTL(MYSELF, 0) in startup', () => {
    expect(selfDestructsAtSpawn(parseScript(scriptWith(0, 'startup', ttl(-1, 0))))).toBe(true)
  })

  test('detects REFDestroy(MYSELF) in startup', () => {
    const code = [...ins(0x07, f32(-1)), ...ins(0x10, str('REFDestroy')), ...ins(0x0b)]
    expect(selfDestructsAtSpawn(parseScript(scriptWith(0, 'startup', code)))).toBe(true)
  })

  test('a positive TTL is not a self-destruct (the object lives, then dies later)', () => {
    expect(selfDestructsAtSpawn(parseScript(scriptWith(0, 'startup', ttl(-1, 10))))).toBe(false)
  })

  test('REFSetTTL(MYSELF, 0) outside startup (eg Killed) does not count', () => {
    expect(selfDestructsAtSpawn(parseScript(scriptWith(0, 'Killed', ttl(-1, 0))))).toBe(false)
  })
})
