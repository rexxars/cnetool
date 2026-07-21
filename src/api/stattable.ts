import type {ConfigEntry} from './types.ts'
import {groupRecords} from './config.ts'
import {deobfuscate, obfuscate} from './obfuscation.ts'

/**
 * Size of one field record in the obfuscated fixed-chunk stat tables
 * (`data4.bin` weapon stats, `data3.bin`). The whole file is a run of these
 * chunks and its length is always a multiple of this.
 */
export const STAT_CHUNK_SIZE = 0x7f

const decoder = new TextDecoder('latin1')

/** A single field of a stat table, plus the index of the chunk it came from. */
export interface StatField extends ConfigEntry {
  /** 0-based chunk index in the file (needed to write the value back). */
  chunk: number
}

// Encode a string as Latin-1 bytes (the tables are Latin-1; `TextEncoder` is
// UTF-8 only, so do it by hand - every stat value is single-byte anyway).
function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff
  return out
}

// The leading `Key:Value` line of a deobfuscated chunk (up to the first newline;
// a trailing CR is dropped). Everything after the newline is ignored filler.
function chunkLine(plain: Uint8Array, chunk: number): string {
  const start = chunk * STAT_CHUNK_SIZE
  const text = decoder.decode(plain.subarray(start, start + STAT_CHUNK_SIZE))
  const nl = text.indexOf('\n')
  const line = nl === -1 ? text : text.slice(0, nl)
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/**
 * Parse an obfuscated fixed-chunk stat table (`data4.bin` / `mdata4.bin` /
 * `data3.bin`). The engine stores each field as its own {@link STAT_CHUNK_SIZE}
 * -byte chunk: an obfuscated `Key:Value` line followed by ignored filler, which
 * it deobfuscates and `sscanf`s as text. This returns one {@link StatField} per
 * chunk (in file order), carrying the chunk index so a value can be written back
 * with {@link setStatValue}.
 *
 * Use {@link groupRecords}(fields, 'Name') to split the weapon table into one
 * record per weapon (the leading `Armor`/`gas`/`bullet`/`shell` header chunks
 * sort before the first `Name` and are dropped by that grouping). The weapon's
 * class index equals its position in that grouped list.
 *
 * @param data - The raw (obfuscated) file bytes.
 */
export function parseStatTable(data: Uint8Array): StatField[] {
  const plain = deobfuscate(data)
  const chunks = Math.floor(plain.length / STAT_CHUNK_SIZE)
  const fields: StatField[] = []
  for (let chunk = 0; chunk < chunks; chunk++) {
    const line = chunkLine(plain, chunk)
    const sep = line.indexOf(':')
    if (sep === -1) continue // not a Key:Value chunk (shouldn't occur in these files)
    fields.push({key: line.slice(0, sep), value: line.slice(sep + 1), chunk})
  }
  return fields
}

/**
 * Return a copy of `data` with the chunk at `chunk` rewritten so its leading line
 * is `key:value` (newline-terminated), re-obfuscated. Only the line is overwritten;
 * the chunk's trailing filler (and every other chunk) is preserved byte-for-byte,
 * so a same-length change is a minimal diff. The engine reads the field by `sscanf`
 * on the deobfuscated chunk, so the value may be any length that fits in one chunk
 * (a shorter value simply leaves a harmless remnant of the old line after the new
 * newline, which the engine ignores).
 *
 * @throws RangeError if `chunk` is out of range or the `key:value` line does not
 *   fit in a chunk (including the newline).
 */
export function setStatField(
  data: Uint8Array,
  chunk: number,
  key: string,
  value: string,
): Uint8Array {
  const plain = deobfuscate(data)
  const chunks = Math.floor(plain.length / STAT_CHUNK_SIZE)
  if (!Number.isInteger(chunk) || chunk < 0 || chunk >= chunks) {
    throw new RangeError(`chunk ${chunk} out of range (0..${chunks - 1})`)
  }
  const bytes = latin1Bytes(`${key}:${value}\n`)
  if (bytes.length > STAT_CHUNK_SIZE) {
    throw new RangeError(
      `field "${key}:${value}" is ${bytes.length} bytes, exceeds the ${STAT_CHUNK_SIZE}-byte chunk`,
    )
  }
  plain.set(bytes, chunk * STAT_CHUNK_SIZE)
  return obfuscate(plain)
}

/**
 * Like {@link setStatField} but keeps the chunk's existing key, replacing only
 * its value. Convenience for retuning a stat (e.g. a weapon's `Damage`).
 *
 * @throws RangeError if `chunk` is out of range or does not hold a `Key:Value`
 *   line, or the new line does not fit in a chunk.
 */
export function setStatValue(data: Uint8Array, chunk: number, value: string): Uint8Array {
  const line = chunkLine(deobfuscate(data), chunk)
  const sep = line.indexOf(':')
  if (sep === -1) throw new RangeError(`chunk ${chunk} is not a Key:Value field`)
  return setStatField(data, chunk, line.slice(0, sep), value)
}

/**
 * Pack one record's `key:value` text (without a trailing newline - this appends
 * it) into a single {@link STAT_CHUNK_SIZE}-byte slot, laid out exactly as the
 * engine's stock tables store it: the obfuscated line (`key:value\n`, +0x78 per
 * byte) followed by a single **literal** `0x00` terminator, then zero filler to
 * {@link STAT_CHUNK_SIZE} bytes.
 *
 * Only the text is obfuscated; the terminator stays a raw `0x00`. This matters
 * because the engine's deobfuscator walks the slot `while (byte !== 0)` with no
 * length bound, so a slot with no `0x00` byte would read off the end. The line
 * (including its newline) must fit in the first {@link STAT_CHUNK_SIZE}`- 1`
 * bytes to leave room for that terminator.
 *
 * @throws RangeError if the `key:value` line does not fit alongside the terminator.
 */
export function packStatSlot(text: string): Uint8Array {
  const line = latin1Bytes(`${text}\n`)
  if (line.length > STAT_CHUNK_SIZE - 1) {
    throw new RangeError(
      `stat record "${text}" is ${line.length} bytes with its newline, exceeds the ${
        STAT_CHUNK_SIZE - 1
      }-byte limit (one byte is reserved for the NUL terminator)`,
    )
  }
  const obfuscated = obfuscate(line)
  // A text byte of 0x88 obfuscates to 0x00, which the engine's unbounded scan
  // would mistake for the terminator and stop mid-line. It can't happen for
  // ASCII `key:value` text, but this is the reusable base for the serializers,
  // so make the guarantee airtight.
  for (let i = 0; i < obfuscated.length; i++) {
    if (obfuscated[i] === 0x00) {
      throw new RangeError(
        `stat record "${text}" has a byte at index ${i} that obfuscates to 0x00, which would terminate the slot mid-line`,
      )
    }
  }
  const slot = new Uint8Array(STAT_CHUNK_SIZE)
  // Obfuscate only the text; the terminator (slot[line.length]) and the filler
  // stay a literal 0x00 (the array is already zero-initialised).
  slot.set(obfuscated, 0)
  return slot
}

/**
 * Rebuild a whole obfuscated stat table from fields, one {@link STAT_CHUNK_SIZE}
 * -byte chunk each via {@link packStatSlot} (obfuscated `Key:Value` line, a literal
 * `0x00` terminator, then zero filler), in the given order. The inverse of
 * {@link parseStatTable} at the field level - but note the original files carry
 * non-zero filler after each line, so this is a *functional* rebuild (the engine
 * ignores the filler), not necessarily byte-identical to the input. For an
 * in-place value change that preserves the rest of the file exactly, use
 * {@link setStatValue} instead.
 *
 * @throws RangeError if any `key:value` line does not fit in a chunk.
 */
export function formatStatTable(fields: Iterable<ConfigEntry>): Uint8Array {
  const list = [...fields]
  const out = new Uint8Array(list.length * STAT_CHUNK_SIZE)
  list.forEach((field, i) => {
    out.set(packStatSlot(`${field.key}:${field.value}`), i * STAT_CHUNK_SIZE)
  })
  return out
}

// --- Shared number helpers (used by both the unit and weapon codecs) ---

// Parse an integer field value. `Number.parseInt(value, 10)` intentionally
// mirrors the engine's `sscanf("%d")` leniency: leading whitespace and a sign
// are tolerated and any trailing garbage is ignored (it stops at the first
// non-digit). Throws with a clear, context-tagged message on no leading digits.
function parseIntField(value: string, context: string): number {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    throw new Error(`${context} is not an integer ("${value.trim()}")`)
  }
  return parsed
}

// Parse a float field value. `Number.parseFloat(value)` intentionally mirrors
// the engine's `sscanf("%f")` leniency: leading whitespace/sign are tolerated
// and trailing garbage is ignored. Throws with a context-tagged message when no
// number is present.
function parseFloatField(value: string, context: string): number {
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`${context} is not a number ("${value.trim()}")`)
  }
  return parsed
}

// Format a number for serialization, rejecting non-finite input so a NaN/Infinity
// never silently becomes a broken `Damage:NaN` slot the engine can't parse.
function formatNumber(value: number, context: string): string {
  if (!Number.isFinite(value)) {
    throw new Error(`${context} must be a finite number (got ${value})`)
  }
  return String(value)
}

/** Armor class of a {@link Unit}, lowercased. */
export type UnitArmor = 'heavy' | 'light' | 'none'

/**
 * One unit's stats from the obfuscated unit table (`data3.bin` / `mdata3.bin`).
 * The engine stores each unit as a run of fixed slots delimited by a `Name` line;
 * see {@link parseUnitTable}.
 */
export interface Unit {
  /** Unit name (the `Name` field), eg `airplane`. */
  name: string
  /**
   * Armor class (`Armor` field), lowercased. Optional: some units omit the slot
   * entirely, and the engine defaults such units to `none`.
   */
  armor?: UnitArmor
  /** Hit points (the `Health` field, parsed `%d`). */
  health: number
  /** Refire delay (the `Firedelay` field - lowercase `d` - parsed `%f`). */
  fireDelay: number
}

// The engine `stricmp`s the Armor value case-insensitively; "No" is an accepted
// spelling of "None". Values map to the lowercased union.
const ARMOR_BY_VALUE = new Map<string, UnitArmor>([
  ['heavy', 'heavy'],
  ['light', 'light'],
  ['none', 'none'],
  ['no', 'none'],
])

// Stock capitalization for each armor class, as written in the shipped tables.
const ARMOR_LABEL: Record<UnitArmor, string> = {heavy: 'Heavy', light: 'Light', none: 'None'}

/** The canonical {@link UnitArmor} classes, in stock order — the single source of
 * truth for the armor set (consumers validating JSON should narrow against this). */
export const UNIT_ARMORS: readonly UnitArmor[] = ['heavy', 'light', 'none']

function parseArmor(value: string, name: string): UnitArmor {
  const armor = ARMOR_BY_VALUE.get(value.trim().toLowerCase())
  if (armor === undefined) {
    throw new Error(
      `unit "${name}" has an unrecognized Armor value "${value.trim()}" (expected Heavy, Light, or None)`,
    )
  }
  return armor
}

// Read the single field expected at `pos`, asserting its key. Returns the trimmed
// value, or throws a clear error naming the record (`context`) and the mismatch.
function expectField(record: StatField[], pos: number, key: string, context: string): string {
  const field = record[pos]
  if (field === undefined || field.key !== key) {
    throw new Error(
      `${context} is missing a "${key}" field (found "${field?.key ?? '<end of record>'}" at position ${pos})`,
    )
  }
  return field.value.trim()
}

function parseUnitRecord(record: StatField[], index: number): Unit {
  const nameField = record[0]
  if (nameField === undefined || nameField.key !== 'Name') {
    throw new Error(`unit record ${index} does not start with a Name field`)
  }
  const name = nameField.value.trim()
  const context = `unit "${name}"`

  // Armor is optional and, when present, immediately follows Name.
  let pos = 1
  let armor: UnitArmor | undefined
  const maybeArmor = record[pos]
  if (maybeArmor !== undefined && maybeArmor.key === 'Armor') {
    armor = parseArmor(maybeArmor.value, name)
    pos++
  }

  const health = parseIntField(expectField(record, pos, 'Health', context), `${context} Health`)
  pos++

  const fireDelay = parseFloatField(
    expectField(record, pos, 'Firedelay', context),
    `${context} Firedelay`,
  )
  pos++

  if (pos !== record.length) {
    throw new Error(
      `unit "${name}" has an unexpected trailing field "${record[pos]!.key}" (expected only Name, Armor?, Health, Firedelay)`,
    )
  }

  const unit: Unit = {name, health, fireDelay}
  if (armor !== undefined) unit.armor = armor
  return unit
}

/**
 * Parse an obfuscated **unit** stat table (`data3.bin` / `mdata3.bin`) into typed
 * {@link Unit} records. The engine stores each unit as a run of fixed slots
 * delimited by a `Name` line, in the order `Name`, optional `Armor`, `Health`,
 * `Firedelay` (note the lowercase `d`); this reads them in that strict sequence.
 *
 * @param data - The raw (obfuscated) file bytes.
 * @throws Error if a record is missing a required field, has an unexpected key
 *   sequence, or carries an unrecognized `Armor` value.
 */
export function parseUnitTable(data: Uint8Array): Unit[] {
  const records = groupRecords(parseStatTable(data), 'Name')
  return records.map((record, index) => parseUnitRecord(record, index))
}

/**
 * Serialize typed {@link Unit} records back into an obfuscated, engine-loadable
 * unit table. Each unit emits slots via {@link packStatSlot} in the fixed order
 * `Name`, `Armor` (only when set, capitalized to the stock `Heavy`/`Light`/`None`),
 * `Health`, `Firedelay`. Numbers are written as plain JS (`75`, `0.5`). The result
 * length is always a multiple of {@link STAT_CHUNK_SIZE}.
 *
 * @throws RangeError if any field does not fit in one slot (see {@link packStatSlot}).
 */
export function serializeUnitTable(units: Unit[]): Uint8Array {
  const slots: Uint8Array[] = []
  for (const unit of units) {
    slots.push(packStatSlot(`Name:${unit.name}`))
    if (unit.armor !== undefined) slots.push(packStatSlot(`Armor:${ARMOR_LABEL[unit.armor]}`))
    slots.push(packStatSlot(`Health:${formatNumber(unit.health, `unit "${unit.name}" Health`)}`))
    slots.push(
      packStatSlot(`Firedelay:${formatNumber(unit.fireDelay, `unit "${unit.name}" Firedelay`)}`),
    )
  }
  const out = new Uint8Array(slots.length * STAT_CHUNK_SIZE)
  slots.forEach((slot, i) => out.set(slot, i * STAT_CHUNK_SIZE))
  return out
}

/** Ammo category of a {@link Weapon}, lowercased (the engine `stricmp`s these). */
export type AmmoType = 'bullet' | 'gas' | 'shell'

/**
 * One row of the weapon table's damage-vs-armor matrix: the percentage of a
 * weapon's `Damage` dealt to a target of each armor class. The engine multiplies
 * these by 0.01 at load, so they are stored (and modeled here) as percentages
 * (e.g. `{heavy: 11, light: 21, none: 100}`).
 */
export interface ArmorDamage {
  /** Damage % dealt to a Heavy-armor target. */
  heavy: number
  /** Damage % dealt to a Light-armor target. */
  light: number
  /** Damage % dealt to an unarmored (None) target. */
  none: number
}

/**
 * One weapon's stats from the obfuscated weapon table (`data4.bin` / `mdata4.bin`).
 * The engine selects a weapon by its **index** (position in the file), so `name`
 * is a cosmetic label; see {@link parseWeaponTable}.
 */
export interface Weapon {
  /** 0-based position of the record in the table (how the engine selects it). */
  index: number
  /** Cosmetic weapon label (the `Name` field), eg `0-GUN`. */
  name: string
  /** Base damage (the `Damage` field, `%f`), scaled per target by {@link ArmorDamage}. */
  damage: number
  /** Which damage matrix row applies (the `AmmoType` field; case-insensitive). */
  ammoType: AmmoType
  /** Projectile speed (the `AmmoSpeed` field, `%f`). */
  ammoSpeed: number
  /** Refire delay (the `FireDelay` field - note the capital `D` - `%f`). */
  fireDelay: number
  /** Muzzle length used to place the projectile spawn (the `WeaponLength` field, `%f`). */
  weaponLength: number
  /** Firing sound path (the `Sound` field). */
  sound: string
}

/**
 * A parsed weapon table: the shared damage-vs-armor matrix (`gas`/`bullet`/`shell`
 * rows) plus the ordered list of weapons. Order is truth - the engine selects a
 * weapon by its position, exposed as {@link Weapon.index}.
 */
export interface WeaponTable {
  ammoDamage: Record<AmmoType, ArmorDamage>
  weapons: Weapon[]
}

// Two distinct orderings, kept separate on purpose: AMMO_TYPES is the match set
// for case-insensitive key/value lookup and the header completeness check (which
// is order-independent), while AMMO_HEADER_ORDER is the stock *file* order the
// serializer must emit. Don't collapse them - alphabetical here, stock there.
/** The canonical {@link AmmoType} categories, alphabetical — the single source of
 * truth for the ammo set (consumers validating JSON should narrow against this). */
export const AMMO_TYPES: readonly AmmoType[] = ['bullet', 'gas', 'shell']

// Stock file order of the header damage rows (gas, bullet, shell) - preserved on
// serialize to keep a minimal, faithful diff against the shipped tables.
const AMMO_HEADER_ORDER: AmmoType[] = ['gas', 'bullet', 'shell']

// The leading header comment slot. The engine never `sscanf`s this line (armor
// columns are hardcoded Heavy=0/Light=1/None=2); it exists purely as a human
// column legend. This reproduces the stock text.
const ARMOR_HEADER_LINE = 'Armor:  Heavy Light No'

// Match a header/weapon `AmmoType` key or value to a canonical union member,
// case-insensitively (the engine `stricmp`s), or undefined if unrecognized.
function matchAmmoType(value: string): AmmoType | undefined {
  const needle = value.trim().toLowerCase()
  return AMMO_TYPES.find((type) => type === needle)
}

// Parse a `<heavy>,<light>,<none>` damage row into an {@link ArmorDamage}.
function parseArmorDamage(value: string, type: AmmoType): ArmorDamage {
  const parts = value.split(',')
  if (parts.length !== 3) {
    throw new Error(
      `ammo "${type}" damage row must be three comma-separated numbers (got "${value.trim()}")`,
    )
  }
  return {
    heavy: parseFloatField(parts[0]!, `ammo "${type}" heavy damage`),
    light: parseFloatField(parts[1]!, `ammo "${type}" light damage`),
    none: parseFloatField(parts[2]!, `ammo "${type}" none damage`),
  }
}

// Parse the 4-slot header block: an ignored `Armor` comment, then the three
// `gas`/`bullet`/`shell` damage rows (in any order; all three required).
function parseWeaponHeader(header: StatField[]): Record<AmmoType, ArmorDamage> {
  if (header[0] === undefined || header[0].key !== 'Armor') {
    throw new Error(
      `weapon table is missing the leading Armor header slot (found "${header[0]?.key ?? '<empty>'}")`,
    )
  }

  const rows: Partial<Record<AmmoType, ArmorDamage>> = {}
  for (let i = 1; i < header.length; i++) {
    const field = header[i]!
    const type = matchAmmoType(field.key)
    if (type === undefined) {
      throw new Error(
        `unexpected weapon header field "${field.key}" (expected gas, bullet, or shell)`,
      )
    }
    rows[type] = parseArmorDamage(field.value, type)
  }

  for (const type of AMMO_TYPES) {
    if (rows[type] === undefined) {
      throw new Error(`weapon table header is missing the "${type}" damage row`)
    }
  }
  return {bullet: rows.bullet!, gas: rows.gas!, shell: rows.shell!}
}

// Parse one 7-slot weapon record in its fixed field order.
function parseWeaponRecord(record: StatField[], index: number): Weapon {
  const nameField = record[0]
  if (nameField === undefined || nameField.key !== 'Name') {
    throw new Error(`weapon record ${index} does not start with a Name field`)
  }
  const name = nameField.value.trim()
  const context = `weapon "${name}" (record ${index})`

  const ammoSpeed = parseFloatField(
    expectField(record, 1, 'AmmoSpeed', context),
    `${context} AmmoSpeed`,
  )
  const fireDelay = parseFloatField(
    expectField(record, 2, 'FireDelay', context),
    `${context} FireDelay`,
  )
  const damage = parseFloatField(expectField(record, 3, 'Damage', context), `${context} Damage`)

  const ammoTypeText = expectField(record, 4, 'AmmoType', context)
  const ammoType = matchAmmoType(ammoTypeText)
  if (ammoType === undefined) {
    throw new Error(
      `${context} has an unrecognized AmmoType "${ammoTypeText}" (expected bullet, gas, or shell)`,
    )
  }

  const weaponLength = parseFloatField(
    expectField(record, 5, 'WeaponLength', context),
    `${context} WeaponLength`,
  )
  const sound = expectField(record, 6, 'Sound', context)

  if (record.length !== 7) {
    throw new Error(
      `${context} has ${record.length} fields (expected 7: Name, AmmoSpeed, FireDelay, Damage, AmmoType, WeaponLength, Sound)`,
    )
  }

  return {index, name, damage, ammoType, ammoSpeed, fireDelay, weaponLength, sound}
}

/**
 * Parse an obfuscated **weapon** stat table (`data4.bin` / `mdata4.bin`) into a
 * typed {@link WeaponTable}. The file layout is a 4-slot header block first - an
 * ignored `Armor` comment then the `gas`/`bullet`/`shell` damage-vs-armor rows -
 * followed by weapon records of 7 slots each in the fixed order `Name`,
 * `AmmoSpeed`, `FireDelay` (capital `D`), `Damage`, `AmmoType`, `WeaponLength`,
 * `Sound`. Each weapon's {@link Weapon.index} is its position (how the engine
 * selects it). `AmmoType` is matched case-insensitively.
 *
 * @param data - The raw (obfuscated) file bytes.
 * @throws Error if the header is malformed or a weapon record has an unexpected
 *   key sequence or an unrecognized `AmmoType`.
 */
export function parseWeaponTable(data: Uint8Array): WeaponTable {
  const fields = parseStatTable(data)
  // Match the header boundary case-insensitively to stay consistent with
  // `groupRecords(fields, 'Name')` below, which also lowercases the start key.
  const firstName = fields.findIndex((field) => field.key.toLowerCase() === 'name')
  const header = firstName === -1 ? fields : fields.slice(0, firstName)

  const ammoDamage = parseWeaponHeader(header)
  const weapons = groupRecords(fields, 'Name').map((record, index) =>
    parseWeaponRecord(record, index),
  )
  return {ammoDamage, weapons}
}

/**
 * Serialize a typed {@link WeaponTable} back into an obfuscated, engine-loadable
 * weapon table. Emits the 4-slot header (the fixed `Armor` comment, then the
 * `gas`/`bullet`/`shell` rows in stock file order) followed by each weapon's 7
 * slots in the fixed order via {@link packStatSlot}, with keys exactly as the
 * engine expects (`FireDelay` capital `D`). Weapons are emitted in **array
 * order** - {@link Weapon.index} is ignored for the byte layout, since position
 * is what the engine reads. The result length is a multiple of
 * {@link STAT_CHUNK_SIZE}.
 *
 * @throws Error if any number is non-finite, or RangeError if a field does not
 *   fit in one slot (see {@link packStatSlot}).
 */
export function serializeWeaponTable(table: WeaponTable): Uint8Array {
  const slots: Uint8Array[] = [packStatSlot(ARMOR_HEADER_LINE)]

  for (const type of AMMO_HEADER_ORDER) {
    const row = table.ammoDamage[type]
    const heavy = formatNumber(row.heavy, `ammo "${type}" heavy damage`)
    const light = formatNumber(row.light, `ammo "${type}" light damage`)
    const none = formatNumber(row.none, `ammo "${type}" none damage`)
    slots.push(packStatSlot(`${type}:${heavy},${light},${none}`))
  }

  for (const weapon of table.weapons) {
    const label = `weapon "${weapon.name}"`
    slots.push(packStatSlot(`Name:${weapon.name}`))
    slots.push(packStatSlot(`AmmoSpeed:${formatNumber(weapon.ammoSpeed, `${label} AmmoSpeed`)}`))
    slots.push(packStatSlot(`FireDelay:${formatNumber(weapon.fireDelay, `${label} FireDelay`)}`))
    slots.push(packStatSlot(`Damage:${formatNumber(weapon.damage, `${label} Damage`)}`))
    slots.push(packStatSlot(`AmmoType:${weapon.ammoType}`))
    slots.push(
      packStatSlot(`WeaponLength:${formatNumber(weapon.weaponLength, `${label} WeaponLength`)}`),
    )
    slots.push(packStatSlot(`Sound:${weapon.sound}`))
  }

  const out = new Uint8Array(slots.length * STAT_CHUNK_SIZE)
  slots.forEach((slot, i) => out.set(slot, i * STAT_CHUNK_SIZE))
  return out
}
