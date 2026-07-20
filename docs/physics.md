# Vehicle physics & controllables

How Codename Eagle drives its vehicles. Everything here is traced from the
Ghidra decompile of `ce.exe` 1.41 (image base `0x400000`), cross-checked against
the `REFSetProjectVars` slot table in [`scripts.md`](./scripts.md). Object field
offsets are **runtime-struct** offsets (the live object record, base pointer
`DAT_0053fa98[index]`), not file offsets.

## The model: everything is a rigid body

There is no separate "vehicle physics" system. Every world object is a rigid
body with the same set of physics fields (mass, per-axis drag, velocity,
inertia, a flags word). A **vehicle is just an ordinary object** whose fields are
set to driving-friendly values and which has a per-frame **drive handler**
installed. The generic integrator `FUN_0046c0c0` steps every movable/rotatable
object the same way; the only per-type behaviour is (a) the constant values
seeded at spawn and (b) the installed handler.

There is **no stored "speed" or "max speed" field.** Top speed is emergent -
throttle feeds velocity, drag damps it, mass sets how quickly forces change it,
and a global clamp (`_DAT_004a1834` = `1000.0`) caps the magnitude. Two vehicles
can reach the same top speed from very different mass/drag combinations.

## Object physics fields

Confirmed fields on the object record. "Set by" = the per-type setup function
(hardcoded float immediate); "Script" = the `REF*` builtin that overwrites it at
runtime (see [`scripts.md`](./scripts.md)).

| Offset               | Field                            | Type      | Set by     | Script                                            |
| -------------------- | -------------------------------- | --------- | ---------- | ------------------------------------------------- |
| `+0x120..0x128`      | linear velocity (x,y,z)          | 3×f32     | integrator | `REFSetSpeed` / `REFReadSpeed` / `REFSetSpeedVar` |
| `+0x130..0x134`      | angular velocity                 | 2×f32     | integrator | `REFSetAngularSpeed` / `REFSetAbsAngSpeed`        |
| `+0x240`             | physics scalar (1.0-2.0 seen)    | f32       | setup      | -                                                 |
| `+0x258`             | turn coefficient                 | f32       | setup      | -                                                 |
| `+0x260`             | physics scalar (buoyancy/lift?)  | f32       | setup      | -                                                 |
| `+0x264/0x268/0x26c` | **per-axis drag** (x,y,z)        | 3×f32     | setup      | `REFSetDrag` (`0` = frictionless)                 |
| `+0x270`             | **mass**                         | f32       | setup      | `REFSetProjectVars(MASS)` (slot 9)                |
| `+0x274 / +0x288`    | inertia terms (`0x288²·0x274`)   | f32 / u16 | setup      | -                                                 |
| `+0x278`             | damping scalar (0 or ~0.001)     | f32       | setup      | -                                                 |
| `+0x280`             | gravity                          | f32       | setup      | `REFSetProjectVars(GRAVITY)` (slot 0)             |
| `+0x2a8`             | **property/flags word**          | bitfield  | setup      | `REFSetProjectVars` (MOVE `0x4`, ROTATE `0x8`, …) |
| `+0x2f0`             | health                           | u16       | setup      | `REFChangePlayer` / slot 21 `PROJHEALTH`          |
| `+0x30c`             | contact / damage handler         | fn ptr    | setup      | - (hardcoded)                                     |
| `+0x310`             | per-frame drive / camera handler | fn ptr    | setup      | - (hardcoded)                                     |

The integrator (`FUN_0046c0c0`) runs the linear branch only when the flags word
`+0x2a8` has **MOVE** (`0x4`) set and the angular branch only with **ROTATE**
(`0x8`) - the same bits scripts toggle via `REFSetProjectVars` slots 1/2. It
asserts on zero inertia (`"Interia 0 in UpdateSingle"`), so `+0x288`/`+0x274`
must be non-zero for a movable body.

The fields `+0x240`, `+0x258`, `+0x260`, `+0x278`, `+0x288` are read by the
integrator but their exact roles aren't fully pinned; the values below are
recorded as observed.

## Where the values are set: per-type setup functions

At spawn, the type-dispatch (below) calls one setup function per vehicle, which
writes the mass/drag/handler **as hardcoded float immediates**:

| Vehicle      | body project | setup function |
| ------------ | ------------ | -------------- |
| armored car  | `rcbody`     | `FUN_00404550` |
| helicopter   | `HeliBody`   | `FUN_0040a120` |
| motorcycle   | `motobody`   | `FUN_0040bd30` |
| tank         | `StBody`     | `FUN_0041a1b0` |
| tank2        | `tBody`      | `FUN_0041b050` |
| torpedo boat | `torpb`      | `FUN_0041cdc0` |
| truck        | `BdyTruck`   | `FUN_00420620` |

The land vehicles share the contact/damage handler `FUN_00436e10` at `+0x30c`;
each installs its own per-frame handler at `+0x310` (eg the car's
`LAB_00404520`, the heli's `LAB_00409770`). Multi-part vehicles set drag on each
sub-part too (wheels, tracks), not just the driven body.

## Per-vehicle defaults (mass + drag)

Decoded directly from the setup functions' float immediates:

| Vehicle      | mass `+0x270` | drag x `+0x264` | drag y `+0x268` | drag z (fwd) `+0x26c` |
| ------------ | ------------- | --------------- | --------------- | --------------------- |
| motorcycle   | 300           | 0.00015         | 0.00025         | 0.015                 |
| armored car  | 500           | 0.00015         | 0.00025         | 0.015                 |
| tank         | 1000          | 0.008           | 0.02            | 0.02                  |
| helicopter   | 700           | 0.0022          | 0.0022          | 0.0022                |
| torpedo boat | 5000          | 0.0015          | 0.025           | 0.015                 |
| truck        | 10000         | 0.00015         | 0.00025         | **0.001**             |

**warship (`aship`) and zeppelin (`zeppe`)** have no dedicated part-setup
function - they spawn as single-body objects through the shared body-name path in
the type-dispatch, so their mass/drag aren't cleanly isolable here. A mass of
`100000.0` (`0x47c35000`) is written for the large IMMORTAL-class objects, which
these two belong to, but it is not individually confirmed per vehicle.

Note the mass and drag do **not** correlate with each other in an obvious way
(the motorcycle at 300 and the car at 500 share identical drag; the truck's
lateral drag matches them but its forward drag is 15× lower). The handling
character of each vehicle is a hand-tuned point in this space.

### Reading it: handling character

Two knobs dominate how "settled" a vehicle feels after a bump or a jump:

- **Forward drag (`+0x26c`)** damps forward/back velocity. The car/motorcycle use
  `0.015`; the **truck uses `0.001`** - ~15× less - so once moving it sheds speed
  slowly and keeps sliding.
- **Mass (`+0x270`)** sets how strongly contact/restoring forces change velocity
  (`Δv ∝ F/mass`). The truck is `10000` (20× the car, 33× the motorcycle), so the
  same landing impulse barely nudges it and it takes many frames to settle.

Both point the same way for the truck's heavy, wobbly, slow-to-settle feel
(vs the light, tightly-damped car/motorcycle). Which term dominates the settling
time depends on the exact integrator math (whether drag is applied as a
velocity-proportional acceleration or a force divided by mass), which isn't fully
decompiled - so treat the split as a well-supported hypothesis, not a proof. The
tank is the outlier that damps hard on every axis (`0.008/0.02/0.02`), matching
its planted, unwobbly feel despite modest mass.

## Controllability: the type-dispatch

What makes an object drivable is **its placement type name**, not a script flag.
The spawner `FUN_0043bff0` (~`0x43c050`) runs a `strcmp` chain over the
placement's type string (`FUN_0049ff30` against `s_motocycle`, `s_torpboat`,
`s_zeppelin`, `s_battleshipa`, `s_truck`, `s_tank2`, `s_plane…`, …). A match
routes to that type's setup path, which binds **mesh + parts + physics defaults +
drive handler together**. An unrecognised type name gets no vehicle setup and
isn't drivable.

Consequences:

- **You make an object controllable by placing it under a recognised vehicle type
  name** (`car`, `motocycle`, `tank`, `torpboat`, …) in the level's placements -
  see [`controllable.ts`](../src/api/controllable.ts) for the name→body/part
  mapping recovered from this chain. There is no "make me drivable" project-var
  slot.
- **Reusing another vehicle's handling is all-or-nothing.** Because the dispatch
  couples handler and mesh, placing something as `car` gives you the armored car's
  _mesh, parts, physics and handler_ - you can't graft car handling onto an
  arbitrary mesh (eg the `mercedes` assembly) via the type name alone. Getting the
  mercedes mesh to drive like the car would need either a mesh/project swap behind
  the `car` body name or an engine change - not just a placement rename.
- **Physics values are runtime-tunable regardless.** Once spawned, a script can
  overwrite mass (`REFSetProjectVars(obj, MASS, …)`), drag (`REFSetDrag`),
  gravity, and the MOVE/ROTATE flags - so you can retune an existing vehicle's
  feel from a `.scr`, even though you can't mint new vehicle _types_ that way.

## Open questions

- Exact roles of `+0x240`, `+0x258` (turn coefficient?), `+0x260`
  (buoyancy/lift?), `+0x278`, `+0x288`/`+0x274` (inertia) - read by the
  integrator but not fully pinned.
- warship/zeppelin mass/drag - need isolating from the shared single-body spawn
  path.
- The precise integrator math (drag as accel vs force/mass), which would settle
  the handling-character analysis above.
- Concrete top speeds are only obtainable by **runtime measurement** (read
  `+0x120..0x128` magnitude at full throttle), since none are stored.
