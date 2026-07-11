import type {TextureSkin} from './objects.ts'
import type {ControllableGeometryMap, ControllablePart, Vector3} from './types.ts'

/**
 * Projects the engine draws via a `.anm` vertex animation rather than their static
 * mesh, mapped to the animation file and the frame that is their **rest pose**. The
 * stored mesh (= anm frame 0) is in an animated extreme; a static export should use the
 * rest frame instead. Eg `motobody`: the bike's front fork/handlebars are baked steered,
 * and `mc.anm` frame 4 (the centre of its 9-frame steering sweep) is straight. Keys are
 * lowercased project names; the `.anm` lives in `ANM/` beside `objects.dat`.
 */
export const restPoses: Record<string, {anm: string; frame: number}> = {
  motobody: {anm: 'MC.ANM', frame: 4},
}

/**
 * The multiplayer belly gunner (class 0x3b; see the `bellygun` note below) mounted
 * under a host vehicle at body-local `mount` (bottom-front). Returns the visible parts
 * only - the `BPTur` ring at the mount + the twin `Car2Can` barrels 7 forward of it
 * (matching the standalone `bellygun`). The mount point is **eyeballed** (the engine
 * assigns it at spawn, not in geometry), so tune per vehicle.
 *
 * `yaw` (degrees, about the vertical axis) spins the whole gun: it's applied to each
 * part mesh and to the barrels' offset from the mount, so eg `180` faces the barrels the
 * other way. Defaults to 0.
 */
function bellyGunAt(mount: Vector3, yaw = 0): ControllablePart[] {
  const rad = (yaw * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  // barrel at body-local offset (±1, 0, +7) from the mount, that offset rotated by `yaw`
  const barrel = (side: number): Vector3 => ({
    x: mount.x + (side * cos - 7 * sin),
    y: mount.y,
    z: mount.z + (side * sin + 7 * cos),
  })
  const withYaw = (part: ControllablePart): ControllablePart =>
    yaw && typeof part !== 'string' ? {...part, yaw} : part
  return [
    withYaw({project: 'BPTur', at: [mount]}),
    withYaw({project: 'Car2Can', at: [barrel(1), barrel(-1)]}),
  ]
}

/**
 * Plane assembly (shared by all `plane*` logical names - they're the same
 * `AirPlan` airframe with different textures/loadouts). From the ce.exe setup
 * (~0x40f0a9): fuselage+wings (`AirPlan`) + horizontal tail (`AirRhB`) + twin
 * propellers (`AirProp`, ±21 lateral) + taildragger landing gear (`AirWfl`: one
 * tail wheel at z−63, two main wheels at ±18.5 lateral, 16 down). Laterals are
 * authoritative from the mirrored offsets; the up/forward axes were ambiguous in
 * the trace and seated to sit on the wings / under the airframe.
 */
// All offsets decoded from the AirPlan setup routine (~0x40f0a9).
const PLANE_PARTS: ControllablePart[] = [
  'AirPlan',
  {
    project: 'AirProp',
    at: [
      {x: -21, y: -4, z: -6},
      {x: 21, y: -4, z: -6},
    ],
  }, // twin props
  {project: 'AirRhB', at: [{x: 0, y: -9.3, z: -68.2}]}, // horizontal tailplane (elevator)
  {project: 'AirRbak', at: [{x: 0, y: -6.5, z: -65.75}]}, // vertical tail fin / rudder (tall, z−66)
  {project: 'AirRfL', at: [{x: -63, y: -14.75, z: 2}]}, // upper-wingtip element, ±63 = wingspan
  {project: 'AirRfR', at: [{x: 63, y: -14.75, z: 2}]}, // (mirror)
  // Two main wheels. The setup also places a third `AirWfl` dead-centre at (0,0,z) but
  // clears its render bit (`[obj+0x2a8] &= 0xfffffffd`), so it is hidden in-game (a
  // collision/marker proxy, not a tail wheel) - omitted here.
  {
    project: 'AirWfl',
    at: [
      {x: -18.5, y: 16, z: 8},
      {x: 18.5, y: 16, z: 8},
    ],
  },
  // Belly gunner (multiplayer)
  ...bellyGunAt({x: 0, y: 3.5, z: -8}, 180),
]

/**
 * Two deck **mortars** on the warship, front and rear - NOT the twin-barrel AA gun.
 * Each is `AASheld` (shield) + `AABox` (box) + `bspipe` (the single thick barrel,
 * from OBJECTS2.DAT). From ce.exe ~0x4036b4 the three cluster at one spot, stacked
 * up-and-forward: shield z+190/y−25 → box z+202/y−39 → barrel z+214/y−44 (a
 * high-angle mortar). The front position is authoritative; the rear is mirrored to
 * z≈−200 (best guess, verify in-game). The setup's 6× `RCWheel` are invisible
 * markers (entry/steer points) and are not rendered.
 */
/**
 * SE5 biplane assembly (the `plane`/`plane3` variants, a *different* airframe from the
 * `AirPlan` monoplane of `plane2`/`plane4`; built by ce.exe `FUN_0040dbb0`, classes 0
 * and `0x39`). The body is `kropp` (the WWI biplane fuselage + wings, textured `SIML`;
 * NOT just a pilot as the type resolver's stale `plane→kropp` label suggested).
 *
 * Offsets are decoded from the `FUN_0046bf90` (SetPosition) constants, same as the other
 * vehicles. The catch: this setup's part offsets are stored as **doubles** (`fadd/fsub
 * qword`, shown as `(float)_DAT_…` in the decompile), so they must be read 8-byte, not
 * as float32 (reading them as float gives garbage like `2.7e23`). -Y up, +Z forward:
 * prop forward at the nose, the two `Se5*Flp` ailerons out at the upper wingtips, the
 * `BFla` fin and `Flps` elevator back at the tail.
 */
const SE5_PARTS: ControllablePart[] = [
  'kropp', // fuselage + wings (textured SIML; the alt `plane3` swaps to Siml2)
  {project: 'Se5Prop', at: [{x: 0, y: -4, z: 19.5}]}, // nose propeller
  {project: 'Se5BFla', at: [{x: 0, y: -5.9, z: -41.25}]}, // vertical fin/rudder at the tail
  {project: 'Se5LFlp', at: [{x: -20.9, y: -13.25, z: 1.2}]}, // upper-left aileron (out at the wingtip, up 13.25)
  {project: 'Se5RFlp', at: [{x: 20.9, y: -13.25, z: 1.2}]}, // upper-right aileron (mirror)
  {project: 'Se5Flps', at: [{x: 0, y: -3.85, z: -41.2}]}, // horizontal tail elevator
  // Two main wheels (±7 lateral / 10.5 down / 5.5 fwd). The setup also places a third
  // `Se5Whee` dead-centre but clears its render bit (hidden, like AirWfl), so omitted.
  {
    project: 'Se5Whee',
    at: [
      {x: 7, y: 10.5, z: 5.5},
      {x: -7, y: 10.5, z: 5.5},
    ],
  },
]

/**
 * Armored car: chassis + turret (the same `Car2*` relative layout fitted on the
 * torpedo boat - mount +4 fwd/3 up of the turret anchor, cannon +12 fwd, twin ±1),
 * turret seated on the roof (≈y−9). The four wheels are `Car2Whe` at authoritative
 * offsets from the ce.exe setup (~0x404569).
 */
// Every part is positioned by the rcbody setup in ce.exe (~0x404569) as
// `body_position + delta`, where each delta is read straight off the SetPosition
// (0x46bf90) call. The body is placed at its position with no offset, so these deltas
// are body-local. −Y is up; +Z is forward. (The setup's `RCWheel` are invisible
// entry/steer markers - the visible wheel mesh is `Car2Whe`.)
const ARMORED_CAR: ControllablePart[] = [
  'rcbody',
  {project: 'Car2Tur', at: [{x: 0, y: -10.5, z: -2}]}, // turret, 10.5 up / 2 back
  {project: 'Car2Hol', at: [{x: 0, y: -14.5, z: 3.5}]}, // mantlet, 14.5 up / 3.5 fwd
  // Twin barrels (±1 lateral). The setup's z offset (+13.5) is only an init value -
  // the cannon carries a per-frame update fn ([obj+0x310]=0x4040a0) that aims/elevates
  // it around the mantlet, so its mounted rest position is at the mantlet, not +13.5.
  // Seated to emerge forward from Car2Hol (aim-zero), matching in-game.
  {
    project: 'Car2Can',
    at: [
      {x: 1, y: -15, z: 7},
      {x: -1, y: -15, z: 7},
    ],
  },
  {
    project: 'Car2Whe',
    at: [
      {x: -10.5, y: 2, z: 15.5},
      {x: 10.5, y: 2, z: 15.5}, // front ±10.5 lateral, 2 down, 15.5 fwd
      {x: -10.5, y: 2, z: -15.5},
      {x: 10.5, y: 2, z: -15.5}, // rear, 15.5 back
    ],
  },
]

const WARSHIP_GUNS: ControllablePart[] = [
  // Per-gun anchors: front lowered ~8 onto the deck; rear pushed aft to z−330
  // (both verified by eye, not from source). Internal layout: box +12 fwd/−14 up,
  // barrel +24 fwd/−19 up, relative to each shield anchor.
  {
    project: 'AASheld',
    at: [
      {x: 0, y: -21, z: 190},
      {x: 0, y: -7, z: -330},
    ],
  },
  {
    project: 'AABox',
    at: [
      {x: 0, y: -35, z: 202},
      {x: 0, y: -21, z: -318},
    ],
  },
  {
    project: 'bspipe',
    at: [
      {x: 0, y: -40, z: 214},
      {x: 0, y: -26, z: -306},
    ],
  },
]

/**
 * Built-in map of *controllable* objects to their visible geometry.
 *
 * Controllable objects - the vehicles and turrets the player can enter/drive -
 * are placed by a level's `data1.bin` under a *logical* project name (`tank`,
 * `car`, `aagun3`, …) whose own `objects.dat` "project" is an **empty stub** (no
 * geometry). The engine attaches the real body mesh at runtime.
 *
 * The **body model** here is taken from the authoritative type→model resolver
 * disassembled out of `ce.exe` (a `strcmp` chain at ~`0x43c050` that writes one
 * project name per type) - eg `tank→StBody`, `car→rcbody`, `truck→BdyTruck`,
 * `tank2→tBody`, `motocycle→motobody`, `torpboat→torpb`, `zeppelin→zeppe`,
 * `battleshipa→aship`. Where a vehicle's remaining parts are unambiguous (same
 * name prefix, authored in a shared origin), they're appended so the whole vehicle
 * renders - eg the steam tank's tower + tracks, the AA turret's box/shield/cannon.
 *
 * Aircraft need care. The resolver maps `Helicopter→AirPlan` (stale; the real mesh is
 * `HeliBody`, used here). For planes its `plane→kropp` is actually right: `kropp` is the
 * SE5 biplane body (`plane`/`plane3`), while `plane2`/`plane4` are the separate `AirPlan`
 * monoplane. See `SE5_PARTS`/`PLANE_PARTS` and the aircraft entries below.
 *
 * A part is either a plain **string** (drawn once at the placement transform -
 * for geometry authored in a shared origin: body, turret, cannon, the assembled
 * AA-gun parts) or a `{project, at}` **{@link ControllableInstancedPart}**, a copy
 * at each given **body-local offset**. The engine seats sub-objects at `body
 * position + offset` (its `SetPosition`), so parts modelled around their own
 * origin - the steam tank's side tracks, wheels - need those offsets or they
 * overlap through the centre. The offsets are read from each vehicle's setup code
 * in `ce.exe` (eg the steam tank at ~`0x41a1dd`: tracks at ±20 lateral, 6.5 down).
 * Parts whose offsets haven't been extracted yet are omitted rather than misplaced.
 *
 * Keys match case-insensitively against the placement's base project name
 * (trailing `_NN` stripped; note the engine's internal spelling differs for the
 * motorcycle - placements use `motorcyc`). Several bodies live in the multiplayer
 * patches' `OBJECTS2.DAT` (helicopter, zeppelin, battleships); pass it via
 * `assembleLevel`'s `extraObjects` option so they resolve. The map is exported and
 * overridable, eg `{...controllableGeometry, tank: ['…']}`.
 *
 * See `docs/formats.md` → *Enterable vehicles & turrets*.
 */
export const controllableGeometry: ControllableGeometryMap = {
  // Ground vehicles (bodies confirmed by the ce.exe resolver). Side/wheel parts
  // the engine seats with runtime offsets (tracks, wheels) are omitted - see the
  // note above; they'd otherwise overlap through the centre.
  // All tank offsets decoded from their engine setup functions.
  tank: [
    'STBody',
    {project: 'STBandL', at: [{x: -20, y: 6.5, z: 0}]}, // side tracks ±20 lateral, 6.5 down
    {project: 'STBandR', at: [{x: 20, y: 6.5, z: 0}]},
    {project: 'STTower', at: [{x: 0, y: -16, z: 7}]}, // turret, 16 up / 7 forward
    {project: 'STPipe', at: [{x: 0, y: -21, z: 15}]}, // steam cannon, 21 up / 15 forward
  ],
  tank2: [
    'tBody',
    {project: 'tLeft', at: [{x: -11, y: 2, z: 0}]}, // tracks ±11 / 2 down
    {project: 'tRight', at: [{x: 11, y: 2, z: 0}]},
    {project: 'tTurret', at: [{x: 0, y: -11, z: -6}]}, // turret, 11 up / 6 back
    {project: 'tCan', at: [{x: 0, y: -16, z: 5}]}, // long cannon, centred, 16 up / 5 fwd
  ],
  tank3: [
    // flame tank (~0x41bfc3): hull + side tracks (±15) + turret + hull flamethrower.
    'Tankjb',
    {
      project: 'TankLjb',
      at: [
        {x: -15, y: -2, z: 0},
        {x: 15, y: -2, z: 0},
      ],
    }, // tracks
    {project: 'TankHjb', at: [{x: 0, y: -13, z: -4}]}, // turret, 13 up / 4 back
    {project: 'TankPjb', at: [{x: 0, y: -13.75, z: 1.5}]}, // flamethrower
  ],
  // Armored car (placements use `car`; `car2` is the same vehicle). See ARMORED_CAR.
  car: ARMORED_CAR,
  car2: ARMORED_CAR,
  truck: [
    'BdyTruck',
    // wheels from ce.exe setup (~0x420635): front ±14.4 lateral / +36 fwd, rear
    // ±12.6 / −18, both 1.8 down.
    {
      project: 'TWFront',
      at: [
        {x: -14.4, y: 1.8, z: 36},
        {x: 14.4, y: 1.8, z: 36},
      ],
    },
    {
      project: 'TWBack',
      at: [
        {x: -12.6, y: 1.8, z: -18},
        {x: 12.6, y: 1.8, z: -18},
      ],
    },
  ],
  // Motorcycle + sidecar (~0x40c070). The setup places mcwhlrg ×3 / mcwhsml ×2, but
  // one mcwhlrg clears the hidden bit (0x2 on [obj+0x2a8]), so the visible wheels are
  // the two bike wheels (mcwhlrg, x=−2.5 - bike sits left of centre, sidecar on the
  // right) + the sidecar wheel (mcwhsml, x=+8.5). Front mcwhlrg (−2.5,2.5,10) and rear
  // z (−9) decoded; sidecar z fitted visually.
  motorcyc: [
    'motobody', // rendered at its mc.anm rest frame (straight fork) - see restPoses
    // Front wheel position is the engine's own rest data: `mc.anm` frame-4 trailer
    // transform (−2.50, 1.95, 10.11), straight. (The trailer also carries the wheel's
    // steer rotation, but at the rest frame it's neutral, so the wheel sits straight.)
    // Rear wheel is the static setup offset. Both are mcwhlrg.
    {
      project: 'mcwhlrg',
      at: [
        {x: -2.5, y: 1.95, z: 10.11},
        {x: -2.5, y: 2.5, z: -9},
      ],
    },
    {project: 'mcwhsml', at: [{x: 8.5, y: 3, z: -2}]}, // sidecar wheel
  ],

  // Aircraft. Two airframes, interleaved by the class->name table (0x4cda60): the SE5
  // biplane (`plane` base / `plane3` alt, class 0 / 0x39, kropp body) and the AirPlan
  // monoplane (`plane2` base / `plane4` alt, class 0x28 / 0x3a). Alt skins in
  // `controllableSkins`.
  plane: SE5_PARTS,
  plane2: PLANE_PARTS,
  plane3: SE5_PARTS,
  plane4: PLANE_PARTS,

  // Watercraft
  woodboat: ['wboat'],
  // Hull + the armored-car turret reused as the deck gun (from torpb setup
  // ~0x41cdd3): Car2Tur (turret) + Car2Hol (mount) + twin Car2Can barrels (±1).
  // Offsets are tiny - the parts are authored in place. The setup's RCWheel ×6 are
  // invisible markers (like the warship), not rendered.
  // Decoded from the torpb setup (~0x41cdd3): the armored-car turret reused on the
  // deck. The 6× RCWheel are invisible entry/steer markers (they carry the hidden bit;
  // not rendered). Car2Can is a VISIBLE twin (both barrels rendered, like the car, ±1
  // lateral) and runtime-aimed, so seated at the mantlet (its setup z+13.5 is an init).
  torpboat: [
    'torpb',
    {project: 'Car2Tur', at: [{x: 0, y: -25.5, z: -2}]},
    {project: 'Car2Hol', at: [{x: 0, y: -29.5, z: 3.5}]},
    {
      project: 'Car2Can',
      at: [
        {x: 1, y: -30, z: 8},
        {x: -1, y: -30, z: 8},
      ],
    },
  ],
  submarin: ['submari', 'subprop', 'subrudd'],

  // Manned AA gun (from ce.exe setup ~0x401258): base + shield + mount/box (the
  // piece connecting the barrels to the body) + twin cannons. Body slots [1c]=x
  // [20]=y [24]=z; −Y is up. Without these offsets the parts overlap at the origin.
  aagun3: [
    'AALegs',
    {project: 'AASheld', at: [{x: 0, y: -6, z: 0}]},
    {project: 'AABox', at: [{x: 0, y: -20, z: 12}]},
    {
      project: 'AACanon',
      at: [
        {x: -2, y: -26, z: 15},
        {x: 2, y: -26, z: 15},
      ],
    },
  ],
  // The "GG gun": a heavy single-barrel emplacement on the same base as aagun3
  // (from ce.exe setup FUN_00407980 / 0x407980, class 0x29). Base + shield + mount,
  // then ONE thick `bspipe` barrel (the warship's mortar barrel, from OBJECTS2.DAT) -
  // NOT the twin `AACanon`, and NOT `GGCanon` (which the setup never touches; the old
  // `['AALegs','GGCanon']` was wrong, hence the broken look). All offsets decoded from
  // the setup's FUN_0046bf90 calls. Multiplayer-only (placed in levels 128-133/248).
  gggun: [
    'AALegs',
    {project: 'AASheld', at: [{x: 0, y: -6, z: 0}]},
    {project: 'AABox', at: [{x: 0, y: -20, z: 12}]},
    {project: 'bspipe', at: [{x: -2, y: -26, z: 25}]},
  ],

  // Multiplayer-patch additions - bodies live in OBJECTS2.DAT (see extraObjects)
  // Offsets transcribed from the full setup function (~0x40a14d). The setup places
  // `HeliTBla` 3× but the first (0,−18,−10) clears a state bit on [obj+0x2a8] that the
  // other two don't - it's non-rendered (confirmed: not visible in-game), so only the
  // two visible coaxial discs are kept. Rotors spin in place, so the hub offsets are
  // exact (centered, x=0; stacked near the mast tip).
  helicopter: [
    'HeliBody',
    {
      project: 'HeliTBla',
      at: [
        {x: 0, y: -27, z: 3.5},
        {x: 0, y: -33, z: 3.5},
      ],
    }, // coaxial pair
    {project: 'HeliRBla', at: [{x: -2.5, y: -12.5, z: -63.5}]}, // tail rotor, back-left of the boom
    // landing gear (AirWfl) - authoritative from ce.exe setup (~0x40a57c): a tricycle,
    // rear-centre + two front wheels, all 14 down.
    {
      project: 'AirWfl',
      at: [
        {x: 0, y: 14, z: -20},
        {x: -13.5, y: 14, z: 10},
        {x: 13.5, y: 14, z: 10},
      ],
    },
    // Belly/chin gunner (multiplayer): eyeballed mount under the nose. See bellyGunAt.
    ...bellyGunAt({x: 0, y: 7.5, z: 17}),
  ],
  // The plane/helicopter belly gunner (class 0x3b, ce.exe `FUN_0040fd80`): a
  // multiplayer-only, per-player-spawned turret (so it never appears in single-player).
  // Its constructor builds `BPTur`×2 + `Car2Hol` + `Car2Can`×2, but the layout is NOT
  // the constructor's `FUN_0046bf90` init offsets: per-frame handlers reposition parts.
  // In-game only the lower `BPTur` ring and the two `Car2Can` barrels are visible:
  //  - the upper `BPTur` is moved to (0,-45,0), up inside the fuselage, by its handler
  //    `LAB_0040faf0` (`FUN_00433d00(0,-45,0)`), so it is hidden;
  //  - `Car2Hol` (the armored-car mantlet) is reused only for the turret/aim logic and
  //    is hidden;
  //  - each `Car2Can` is positioned by `LAB_0040fb00`/`LAB_0040fb40` -> `FUN_004505d0`
  //    at turret-LOCAL (±1, 0, 5 - 2.5*aim), then run through the turret's orientation
  //    matrix (a 180 deg flip + base orient) we don't reconstruct statically.
  // So keyed `bellygun` (not `bptur` - `BPTur` is a real OBJECTS2.DAT mesh), modelling
  // just the visible ring + barrels. The barrels keep the code's tight ±1 twin spacing
  // (`FUN_004505d0`'s X arg), centered on the ring; their Z is **eyeballed** to sit them
  // forward at the ring, not code-derived (the true offset runs through the turret's
  // orientation matrix). Adjust the barrel Z to taste.
  bellygun: [
    {project: 'BPTur', at: [{x: 0, y: 0, z: 0}]},
    {
      project: 'Car2Can',
      at: [
        {x: 1, y: 0, z: 7},
        {x: -1, y: 0, z: 7},
      ],
    },
  ],
  // Envelope only. The setup's `zhatch` is the rear closing hatch (hidden in
  // multiplayer) and `subrudd` (tail fin) isn't visible in-game, so both omitted.
  // The manned gun is a separate `ZeppeGun` controllable placement (see below).
  zeppelin: ['zeppe'],
  // The zeppelin's manned gun turret - a standalone `ZeppeGun` entity placed in
  // levels' object caches (with its own position/AI routes). It resolves to the
  // `zeppg` gondola mesh (`zeppovg` is the identical gondola for the `zeppov`
  // envelope) plus a twin gun. The gondola carries no barrels, so a pair of
  // `AACanon` is mounted at the front; barrel mesh confirmed visually, the ±8/forward
  // offset is a best guess (the model is data-driven, not resolvable from code).
  zeppegun: [
    'zeppg',
    {
      project: 'AACanon',
      at: [
        {x: -8, y: 0, z: 39},
        {x: 8, y: 0, z: 39},
      ],
    },
  ],
  // Hull + two deck mortars (front/back) - see WARSHIP_GUNS. RCWheel markers hidden.
  battleshipa: ['aship', ...WARSHIP_GUNS],
  battleshipg: ['bship', ...WARSHIP_GUNS],
}

/**
 * The visible gun both bunker variants get (`FUN_00403b80`): a single `Car2Can`
 * barrel, offset -4 laterally (the embrasure is off-centre) / 9 up / 29 fwd. The
 * setup also builds an `AASheld` shield and `AABox` mount at the same anchor, but
 * **both clear render bit 0x2** (`& 0xfffffffd`) so only the barrel is drawn - they're
 * the aim mount, hidden inside the emplacement. The engine builds this for BOTH
 * `bunkers` (0x30) and `bunkerl` (0x31) identically; the only per-variant difference
 * is the body mesh (bunker1 vs bunkerd).
 */
const BUNKER_GUN: ControllablePart[] = [{project: 'Car2Can', at: [{x: -4, y: -9, z: 29}]}]

/**
 * Built-in map of *non-controllable* multi-part objects - "assemblies".
 *
 * Like {@link controllableGeometry} these are level placements whose `objects.dat`
 * project is an empty stub (no geometry): the engine's class dispatcher
 * (`FUN_0044d480`, keyed by the class byte from the `0x4cda60` name table) hands
 * each to a setup function that creates the real body mesh + sub-parts at body-local
 * offsets. The difference is only that the player can't enter/drive these - they're
 * scenery/props (a parked staff car, a train, a flak bunker, a passenger airship).
 * The assembly mechanics are identical, so the export treats them the same way; they
 * just live in `assemblies/` rather than `controllables/`.
 *
 * Offsets are decoded from each setup's `FUN_0046bf90` (SetPosition) calls the same
 * way the controllables were (`body_position + delta`, -Y up / +Z forward). Keys are
 * the lowercased logical placement names.
 */
export const assemblyGeometry: ControllableGeometryMap = {
  // Staff car (MERCEDES, class 0x0d, FUN_0040afb0): Merc body + four Mwheel (front ±9
  // / 28 fwd, rear ±9 / 12 back, all 3 up), each on a suspension joint (FUN_0047f900).
  // The setup also makes a `MercSH` ground shadow (a flat decal, dropped like other
  // controllables' shadows) and a hidden `motobody` driver proxy at the origin (clears
  // render bit 0x2), both omitted.
  mercedes: [
    'Merc',
    {
      project: 'Mwheel',
      at: [
        {x: -9, y: -3, z: 28},
        {x: 9, y: -3, z: 28},
        {x: -9, y: -3, z: -12},
        {x: 9, y: -3, z: -12},
      ],
    },
  ],
  // Flak bunkers (BUNKERS 0x30 / BUNKERL 0x31, FUN_00403b80): two concrete-emplacement
  // bodies (`bunker1` / `bunkerd`) sharing the same off-centre barrel (BUNKER_GUN).
  bunkers: ['bunker1', ...BUNKER_GUN],
  bunkerl: ['bunkerd', ...BUNKER_GUN],
  // Passenger airship (ZEPPELINP, class 0x35, FUN_00423820): the `zeppov` envelope +
  // `zhatch` boarding hatch (38 down / 147 back). The setup also makes a `subrudd`
  // tail fin but clears its render bit 0x2 (hidden), so it's omitted. (The drivable
  // `zeppelin` uses the `zeppe` envelope and hides both.)
  zeppelinp: ['zeppov', {project: 'zhatch', at: [{x: 0, y: 38, z: -147}]}],
}

// NOTE: the train (TRAIN 0x12 / STRAIN 0x1d, FUN_0041e9d0) is deliberately NOT an
// assembly. Its setup adds six `Car2Whe`, but five clear render bit 0x2 (hidden bogie/
// physics proxies) and the one drawn wheel is a stray; the only visible geometry is the
// `train` body mesh itself, already exported under objects/. So there's nothing to
// assemble beyond the raw project.

/**
 * Alt-skin texture swaps per controllable variant. Some vehicles are one mesh with two
 * skins picked by the placement name; CE bakes the swap in-engine (a face-texture
 * rewrite `X.tga -> X2.tga` for the alt variant, `FUN_0044d0e0`; the `*2` textures ship
 * in `texsec.dat`). `assembleLevel`/`cnetool object` pass the matching entry to
 * {@link createTextureResolver} so the export shows the alt skin instead of the base.
 *
 * Confirmed from the setup functions and the class->name table:
 *  - `car2` (class 0x1f): `Carnew -> Carnew2` (grey steel + camo vs olive + eagle).
 *  - `plane4` (class 0x3a, `FUN_0040f090`, the `AirPlan` airframe): a 7-texture swap.
 *  - `plane3` (class 0x39, `FUN_0040dbb0`, the `kropp`/SE5 biplane): `Siml -> Siml2`.
 * `car`/`plane`/`plane2` are the base skins (no swap).
 */
export const controllableSkins: Record<string, TextureSkin> = {
  car2: {carnew: 'Carnew2'},
  plane3: {siml: 'Siml2'}, // SE5 biplane alt skin (class 0x39, FUN_0040dbb0)
  plane4: {
    aireng: 'aireng2',
    airbot: 'airbot2',
    airpbjbe: 'airpbjb2',
    airpbot: 'airpbot2',
    feng: 'feng2',
    wing: 'wing2',
    wingljb: 'wingljb2',
  },
}
