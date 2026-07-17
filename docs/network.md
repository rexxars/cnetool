# Network: discovery, session & wire protocol

How Codename Eagle (the 1.4x multiplayer demo lineage) announces a hosted game and how clients discover servers. Three largely independent mechanisms are involved:

1. **GameSpy** - internet master-server listing + per-server status queries.
2. **`iplist.exe`** - a static, file-driven server poller that feeds the in-game browser (and also broadcasts on the LAN).
3. **DirectPlay / `lobby.exe`** - the actual session/transport layer once you join.

Each section flags confidence: **[Confirmed]** = verified by static analysis or live packet capture, **[Inferred]** = strongly implied but not directly proven, **[Unconfirmed]** = open question.

---

## Ports at a glance

| Port    | Proto | Role                                                                                                                                                                               | Confidence                           |
| ------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `24711` | UDP   | Game/session traffic (DirectPlay). Default host/connect port, overridable via `+host <port>` / `+connect ip:port`. Also where a _modern_ server's "type-3" status responder lives. | Confirmed                            |
| `4711`  | UDP   | GameSpy query port - where a server answers `\status\`-style queries.                                                                                                              | Confirmed (live probe)               |
| `27900` | UDP   | GameSpy master heartbeat port - where the server announces itself to the master (send-only).                                                                                       | Confirmed (ce.exe uses `SOCK_DGRAM`) |
| `210`   | UDP   | `iplist.exe` **local bind/source** port for its probes - and where a host's LAN beacon is sent.                                                                                    | Confirmed                            |
| `211`   | UDP   | `iplist.exe` legacy query **destination** port (`'B'`/`'G'` messages).                                                                                                             | Confirmed                            |
| `47624` | UDP   | Classic DirectPlay session enumeration (standard DPlay). CE's actual use here is unverified.                                                                                       | Unconfirmed                          |

> Note: `24711` is the **default** game/session port, not a fixed one — it is overridable at launch (see below). `4711` is the GameSpy query port and **is** fixed (hardcoded). The other ports were recovered by reverse engineering and packet capture.

### Configuring the ports **[Confirmed - static analysis of 1.41]**

The game/session port defaults to **24711** and is backed by a single port variable (`DAT_004c26d0`, initial value `0x6087`). Both launch flags that establish an endpoint write it, so it is configurable at startup:

- `+host <port>` - the optional trailing integer after `+host` is `sscanf`'d as `%d` and stored (`FUN_004426a0` @ `0x4426a0`).
- `+connect <ip>:<port>` - the `:port` field of the connect address writes the **same** variable.

The parsed value replaces the 24711 default in the connection endpoint (`FUN_00442360` @ `0x442360`, `port` slot of the 6-element address array), so a non-default port works as long as host and client agree on it. Host and join sharing one port variable is the corroboration that the host-side override takes effect - the identical value must reach the socket for a client to dial a non-default server. **[The parse + storage is confirmed statically; end-to-end socket binding at a custom port is not yet verified live.]** See `docs/game-flow.md` § Command-line arguments.

The GameSpy **query port `4711` is not configurable.** It is a compile-time literal `0x1267` passed as the first argument to GameSpy init (`FUN_004240d0(0x1267, "cneagle", …)` @ `0x4240d0`), which binds the query socket to it and emits it as the `<queryport>` in the `\heartbeat\` frame (§1a). No flag, config file, or global feeds it - there is a single call site with the value inlined, so changing it requires patching the binary.

---

## 1. GameSpy - internet listing

This is the intended path for internet server discovery.

### 1a. Announcement (server → master) **[Confirmed - static analysis of 1.41]**

On host start, `ce.exe` initialises GameSpy (`"Try to init GameSpy!"` → `"GameSpy init ok"`) and announces itself to a master server. The master hostname is baked into the binary as the literal string **`master.gamespy.com`** (in `ce.exe`'s data). GameSpy's masters are long dead, so out of the box this announcement goes nowhere.

The heartbeat frame the server sends is:

```
\heartbeat\<queryport>\gamename\cneagle
```

- `gamename` is **`cneagle`**.
- `<queryport>` is the UDP port the server will answer status queries on (i.e. `4711`).
- Transport is **UDP to `master.gamespy.com:27900`**. The GameSpy init (`FUN_004240d0`) creates the master socket with `socket(AF_INET, SOCK_DGRAM, 0)` and `connect()`s it to port `0x6cfc` (27900); the heartbeat builder (`FUN_00424ec0`) only ever `send()`s on it. (A re-send after failure recreates the same `SOCK_DGRAM` socket.) A repeat heartbeat may append `\statechanged\`.

#### Heartbeat cadence **[Confirmed - static analysis of 1.41]**

The poll routine `FUN_00424290` (run every game tick) decides when to heartbeat:

- **Startup:** one heartbeat (the `lastHeartbeatTick == 0` case).
- **Steady state:** one every **5 minutes** - `300000 < GetTickCount() − lastHeartbeatTick` (`lastHeartbeatTick` = `DAT_004d8020`, stamped after each send).
- **On state change:** one `\statechanged\` heartbeat per discrete event (`FUN_00424ec0(1)` - e.g. entering `openplaying`/map load), plus one on **shutdown** (`exiting`).
- **Dormant burst path:** `if (DAT_004be20c > 0) { DAT_004be20c--; sendHeartbeat() }` sends one heartbeat _per tick_ while that counter is positive - but in 1.41 the counter is **never armed anywhere in the binary**, so it stays 0 (dead code).

> **No acknowledgement is expected, and the rate never adapts.** The heartbeat socket is send-only; the game never `recv`s on it and the cadence above is a pure timer - it does **not** speed up, retry faster, or change when the master is silent or when the server's own query port (`4711`) is unreachable from the master. (The only `send()`-error reaction is recreating the socket and resending **once**, which also changes the UDP source port.) So a healthy server emits a handful of heartbeats per session, not a stream. A _flood_ (e.g. dozens in a tight window) is therefore the host misbehaving - a crash/restart loop (each launch re-sends the startup + map-load heartbeats), state-flapping, or a build where the burst counter is armed - **not** anything the protocol asks for, and **not** caused by the master not replying. Diagnostic: a restart loop changes the UDP **source port** each time (fresh socket); one runaway process keeps the same source port.

> **The game only _announces_ - it never queries the master for a server list.** `master.gamespy.com` is referenced in exactly two places in `ce.exe`, both connecting to **27900** (heartbeat). The GameSpy master _list_ port `28900` (`0x70e4`) appears **nowhere**, there is no `\list\` request, and no code path ingests a list of servers. The master socket is **send-only**; the single `recvfrom` loop (`FUN_004241f0`) reads only the **query/validation** socket bound to `4711`. So the in-game browser's server list comes **entirely from `iplist.txt` + the LAN sweep (§2)** - GameSpy is a one-way _publish_ so that _external_ tools/sites can enumerate CE hosts, never a source the game reads back. This is why a revived master alone would not repopulate the stock browser.

The master can then run a **`\secure\` / `\validate\` challenge-response** to prove the announcer is a real CE server - but note **this runs on the query port (`4711`), not the heartbeat socket** (§1b), confirming the heartbeat socket is send-only:

1. Master sends `\secure\<challenge>` to the server's query port `4711` (challenge = random alphanumeric string; may be appended to a `\status\` / `\basic\` query).
2. Server appends `\validate\<response>` to its reply, where `response = base64( gs_encrypt(challenge, secretKey) )`.

**[Confirmed - live probe]** `\secure\ABCDEF` → `\validate\XY7mYbEq\final\`, matching `computeValidate('ABCDEF')` - confirmed against both a **1.43** host and a **1.50** dedicated, so the key `HNvEAc` and transform below are unchanged across those versions.

The CE specifics (reverse-engineered from `ce.exe`):

- **Secret key:** `HNvEAc`
- **`gs_encrypt`:** a modified RC4 - textbook RC4 key schedule, but the keystream loop folds each plaintext byte into the index (`x = (x + data[i] + 1) mod 256`), making it self-synchronising.
- **Encoding:** standard base64, emitted in whole 4-char groups with no `=` padding (short final group zero-filled).

> **Reference implementation:** a from-scratch GameSpy master replacement scoped to CE lives at <https://github.com/rexxars/ce-server-list>. It receives the `cneagle` heartbeat over **UDP** `27900`, tracks live servers, and re-checks them by querying their advertised `<ip>:<queryPort>` back. The `gs_encrypt` implementation there is the authoritative description of the transform.
>
> **[Confirmed - live capture]** a live capture showed `ce.exe` sends the heartbeat over **UDP/27900** (100 datagrams, 0 TCP). The reference master accordingly listens on **UDP** 27900; a TCP listener could never receive a real heartbeat. It does **not** run the `\secure\` validation (the key is public, so it proves nothing the query-back doesn't); listing is gated by whether the server answers `\status\` on `4711`.
>
> **To actually receive announcements:** point `ce.exe`'s `master.gamespy.com` lookup at a host running that service (e.g. patch/redirect the hostname). Once redirected, heartbeats are received. **[Inferred - believed correct, confirm against a live capture.]**

### 1b. Per-server status query (master/client → server) **[Confirmed - live probe]**

A server's status is fetched with a **standard GameSpy-1 query** on its query port (`4711`). The request is one or more backslash-delimited keywords; the reply is backslash-delimited `\key\value\...` pairs. **No `\secure\`/`\validate\` handshake is required to query** - that challenge is master-side only (§1a). A live 1.43 host answered every probe immediately when tested with a UDP query tool:

| Request          | Reply contents                                                      |
| ---------------- | ------------------------------------------------------------------- |
| `\status\`       | full dump - server rules **and** (on 1.43) the player list          |
| `\info\`         | `hostname`…`gamemode` (no `gamename` block, no players)             |
| `\basic\`        | `gamename` / `gamever` / `location`                                 |
| `\rules\`        | `timelimit` / `fraglimit` / `teamplay` / `scorelimit`               |
| `\players\`      | one `player_N` block **per packet** (empty `\final\` if no players) |
| `\echo\`         | `\echo\` (liveness/ping)                                            |
| `\info\\status\` | **batched** - info section followed by status section, one datagram |

`\secure\<challenge>` is answered with `\validate\<response>` appended to the reply (see §1a) - **bare** `\secure\` (no challenge) returns just an empty `\final\`.

#### Fragmentation / reassembly contract **[Confirmed]**

Every reply packet is tagged `\queryid\<id>.<segment>` (segments start at `1`); `<id>` is a single server-wide counter that increments per query received. Large replies split across packets:

- The **final packet contains `\final\`**, and its `<segment>` number **equals the total packet count** for that `<id>`. So a reader knows it is done once it has received that many packets for the id.
- Packets may arrive **out of order** (UDP) - reassemble by counting packets for each `<id>` until the count reaches the final segment's number, not by sequence.
- `\players\` uses this to send **one `player_N` per packet** (`<id>.1`, `<id>.2`, …). Spectators appear as ordinary players (e.g. `team_N\blue`).

> Reference client: `src/query.ts` in [ce-server-list](https://github.com/rexxars/ce-server-list) issues `\status\` + `\players\` and implements exactly this count-until-total reassembly; its `test/query.test.ts` has recorded multi-packet, out-of-order `\players\` fixtures.

A `\status\` from the live `CE Nation` host (one player connected) decoded to:

```
gamename cneagle   gamever cneagle1.43   location 1
hostname "CE Nation"   hostport 24711   mapname "No mans land"
gametype ctf   gamemode openplaying   numplayers 1   maxplayers 8
timelimit 0   fraglimit 0   scorelimit 0   teamplay 1
player_0 Rexxie   frags_0 0   deaths_0 0   skill_0 0   ping_0 0   team_0 red
```

> `gamever` here is **`cneagle1.43`** - a live server in the wild running 1.43 (the static-RE canonical target is 1.41). The player block repeats `player_N`/`frags_N`/`deaths_N`/`skill_N`/`ping_N`/`team_N` per connected player.
>
> **Don't assume field order or where players live.** On this 1.43 host the `\status\` reply bundles the `gamename`/`gamever` block _and_ the players, and orders the terminator `…\final\\queryid\13.1`. The older `ce-server-list` fixtures show a leaner `\status\` (no players, no `gamename` block) ordered `…\queryid\29.1\final\` - i.e. `queryid` _before_ `final`. Likely version drift. A parser should read players from `\players\` regardless and not depend on `\final\`/`\queryid\` ordering.
>
> A plain `\status\` is answered with no framing tricks on this 1.43 host. (A bare `\status\` reportedly got **no reply** in one test; that does not reproduce here - likely a different server/version or a malformed datagram.)

---

## 2. `iplist.exe` - the static server poller

### Purpose **[Confirmed]**

`iplist.exe` exists to populate the in-game server browser by **probing a fixed list of IPs** and reporting each server's status back to the game. It is _not_ a master-server client - it has no discovery of its own; it only checks addresses it is handed:

- **Internet:** addresses come from `iplist.txt` (see below).
- **LAN:** the game also runs it against the broadcast address `255.255.255.255` (so it doubles as the LAN sweep).

It also contains IPX socket code - a remnant of 1999-era LAN play - alongside the UDP/IP path. IPX is not covered further here.

### Design intent & history **[Confirmed timeline / Inferred intent]**

`iplist` is **the original, pre-GameSpy server-discovery mechanism** - a static, file-driven directory that predates the master-server integration.

- **It shipped with a default server.** Every version examined (1.0, 1.33, 1.36, 1.41, and common ripped copies) ships a byte-identical `IPLIST.TXT`:

  ```
  # List of TCP/IP-servers for CodeName:Eagle
  195.84.201.22
  ```

  One hardcoded "official" host (`195.84.201.22` - RIPE/European address space, consistent with the Swedish developer Refraction Games).

- **It predates GameSpy.** The 1.0 release ships `IPLIST.EXE` + `LOBBY.EXE` + `MENUDLL.DLL` with **zero** GameSpy strings in _any_ binary (`gamespy`, `cneagle`, `master.gamespy.com` all absent). GameSpy first appears in **1.33** (and persists through 1.41). So `iplist` is the older path; GameSpy was bolted on later as the dynamic/global publish channel (§1) and the game's own browser was **never** migrated onto it (§1a - the game never queries the master).

**How it was meant to work (inferred):** a "poor-man's master server" - instead of fetching a live list from a central master, the game reads a flat file of known server IPs and probes each one to fill the browser with live status (name/ping/map/players). The intended workflow: ship a default pointing at the official host, and let players **edit the file** to add friends' servers or drop in an **updated list distributed out-of-band** (publisher/fan sites, magazine cover discs - very 1999). The `#`-comment support and bare-IP-per-line format are exactly what a hand-edited / community-shared text file wants.

**Why a separate `iplist.exe` child + pipe (inferred):** isolate the blocking per-IP probe (~1 s wait × ~3 retries) from the game loop, spawn one child per IP for cheap concurrency, and keep the **IPX** LAN path in the same helper. The 1.0 `IPLIST.EXE` even carries a canned demo row (`Name:"IPServer%d" Ping:67 Map:128 Players:4 …`), hinting it began life as a fairly standalone prober.

### `iplist.txt` format **[Confirmed]**

Plain ASCII, parsed by **`MENUDLL.DLL`** (the menu module) in `parseTCPIPserverList` - **not** by `ce.exe` or `iplist.exe`:

```
# Lines beginning with '#' are comments
89.38.98.12
192.168.1.50
```

One bare IPv4 per line. The parser rejects anything that isn't a clean dotted quad (no ports, no hostnames).

Confirmed from the `MENUDLL.DLL` decompile (`parseTCPIPserverList`): `sscanf` `"%d.%d.%d.%d"` requiring exactly 4 octets each `< 256`, `#`-comment skip, capped at **1000 servers** - and after parsing it **appends `255.255.255.255` as the final list entry**. So the LAN broadcast sweep is not special-cased; it is just the last row of the parsed list, probed like any other.

### `MENUDLL.DLL` ↔ `iplist.exe` protocol **[Confirmed]**

> **Who does what:** the file-reading and child-spawning all live in **`MENUDLL.DLL`** (the menu module), not `ce.exe`. Confirmed by strings: `iplist.txt`, `parseTCPIPserverList()`, `ipList.exe`, and the `%d %d %d %d %d %d` arg template appear **only** in `MENUDLL.DLL`. `iplist.exe` has **no** reference to `iplist.txt` - it only knows octets and pipes.
>
> Heads-up for RE: a Ghidra decompilation of `ce.exe` contains **none** of this (no `iplist`/`parseTCPIP`/spawn code) - decompile `MENUDLL.DLL` instead. It is a DLL, so its image base is `0x10000000` (`file_offset = vaddr − 0x10000000`), not `ce.exe`'s `0x400000`.

`MENUDLL.DLL` drives `iplist.exe` as a child process over an anonymous pipe:

1. Parse `iplist.txt` into a list of server IPs.
2. For **each** server - and once for the LAN broadcast address - create an anonymous pipe and spawn `iplist.exe` with inherited handles, passing arguments as six integers:

   ```
   iplist.exe <writePipeHandle> <mode> <oct0> <oct1> <oct2> <oct3>
   ```

   Examples observed:
   - Internet server `89.38.98.12`: `iplist.exe 8 1 89 38 98 12`
   - LAN broadcast: `iplist.exe 8 1 255 255 255 255`

   So: arg0 = inherited pipe handle, arg1 = **mode** (see below), args 2-5 = the target IP octets. (The target **port is not passed** - `iplist.exe` chooses it internally from the mode.)

3. `iplist.exe` probes the address and writes result rows back through the pipe as ASCII text lines, which the game parses to fill the browser:

   ```
   Name:"%s" Ping:%d Map:%d Players:%d MaxPlayers:%d Spectators:%d MaxSpectators:%d Type:%s IP:%d.%d.%d.%d IPXAdress:%d.%d.%d.%d.%d.%d
   ```

   On no response it reports failure (an exit code distinct from success) and the row is dropped.

> **`Spectators` / `MaxSpectators` are vestigial - CE has no spectator mode.** `ce.exe` contains **zero** references to "spectator"/"observer" (the only game modes are Deathmatch / CTF / Teamplay), and `iplist.exe` never _computes_ these fields - every row-format literal hard-codes them, mostly `Spectators:0 MaxSpectators:0` and on a couple of paths a dummy `Spectators:2 MaxSpectators:16` (the same constant for every server - a tell that it's fake). The menu does parse them (and even builds a `n(max)` display column), so the browser UI was _designed_ with a spectators column in mind, but no real data ever backs it. It is **not** a GameSpy field either: a CE `\status\` reply carries `numplayers`/`maxplayers` but no spectators (§1b). So it's a planned-but-never-implemented browser field; emitting `Spectators:0 MaxSpectators:0` is the faithful value.

> **From the `MENUDLL.DLL` disasm:** the spawn is one generic function `FUN_10028940(mode, oct0, oct1, oct2, oct3)` (`0x10028940`) - it `sprintf`s the `%d %d %d %d %d %d` argv, launches `ipList.exe`, then parses the returned rows with a tolerant `strstr` scan for `Name:"` / `Ping:` / … / `IP:` / `IPXAdress:` in order. It has exactly **two** call sites (see the mode table below); the `mode` is a caller-supplied immediate.

### `iplist.exe` probe behaviour **[Confirmed]**

- Opens a UDP socket, **binds local port `210`**, enables `SO_BROADCAST`.
- Sends an **8-byte query datagram** (first byte = message type, rest zero).
- Waits **~1.0 s** for a reply (single receive window). The legacy path resends (≈3 attempts, ~1 s apart) before giving up.

### Query/message variants **[Confirmed]**

The first byte of the 8-byte datagram and the destination port depend on the `mode` argument:

| Mode arg          | Message byte                  | Dest port | Notes                                                                                                                                                                                          |
| ----------------- | ----------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `1`               | `'B'` (0x42) and `'G'` (0x47) | `211`     | The **legacy** path. **What the stock browser uses** - confirmed: the server-loop caller `push $1` (§ below).                                                                                  |
| `2`               | `0x03` ("type-3")             | `24711`   | Status query against the **game port**. **Never invoked by the stock menu** - confirmed: no mode-2 call site exists in `MENUDLL.DLL`.                                                          |
| `4711` (`0x1267`) | `'G'` (0x47)                  | `211`     | Distinct branch keyed on the value `4711`; purpose **[Unconfirmed]** - possibly GameSpy-query-port related.                                                                                    |
| `0`               | -                             | -         | The one-shot caller (`0x10029960`) `push $0` against `0.0.0.0`, then checks the result. **[Inferred]** a networking / `iplist.exe`-present self-test (cf. `No TCPIP protocol could be found`). |

> **Mode is set by the caller, confirmed from `MENUDLL.DLL` disasm.** The spawner has two call sites: `0x10029831` (the loop over the parsed list + the appended `255.255.255.255`) passes **mode 1**, and `0x10029960` passes **mode 0** to `0.0.0.0`. **No site passes mode 2**, so the type-3/`24711` path is genuinely unreachable from the stock menu - the primary-source reason the internet browser stays empty against modern (type-3-only) servers.

> **Related message type seen on the wire:** `'D'` (0x44) is **not** an `iplist` probe - it's the type byte of the host's **LAN beacon** broadcast to `:210` (see §3). Listed here only so the full `'B'`/`'G'`/`0x03`/`'D'` byte inventory lives in one place.

> **Internal quirk [Confirmed]:** the send routine reads the destination port as a single _byte_, so the type-3 builder's intended `24711` was being truncated. Relevant if you read the disassembly and the numbers don't line up.

### Version timeline - two `iplist.exe` builds **[Confirmed]**

There are exactly **two** distinct `IPLIST.EXE` binaries across all pre-1.50 versions examined (both happen to be 196,665 bytes, but ~74% of their bytes differ - a full rebuild, not a tweak):

| Build (md5) | Ships in                                 | Probe model                                                 |
| ----------- | ---------------------------------------- | ----------------------------------------------------------- |
| `c3c2aaed…` | **1.0**, ripped                          | legacy **ping + IPX only** - no status query                |
| `b490cd49…` | **1.33 / 1.36 / 1.41 / 1.43-unofficial** | adds the **type-3 server-status query** + lobby integration |

So the **type-3 (`0x03`/`24711`) status path - and the port-truncation bug above - were introduced in the 1.33 rebuild**; the 1.0 prober predates them. Evidence is the string boundary: only the 1.33+ build carries `Got server status.`, `pServerStatus`, `CheckPing`, `PingLobby`, `SendToLobbyProcessHandle`, `*PlayerStatus`, and links updated network code (`C:\gamedev\Network\MultiPlayer.C`). The 1.0 build has only `Got Ping back` / `Ping timeout`. The reply IP format also changed `IP:%d.%d.%d.%d` → `IP:%s`, consistent with the prober filling in the probed IP (the type-3 reply carries a zeroed IP - see below). This lines up with the GameSpy timeline (§2 "Design intent"): 1.0 is pre-GameSpy/pre-status-query; 1.33 added both. `1.43-unofficial` reuses the stock 1.41 `iplist.exe` byte-for-byte.

> The literal `0x03`/`24711` are code constants, not strings, so the boundary is pinned on the feature strings above rather than an opcode match - disassemble the 1.0 send routine to confirm the status-query builder is absent there.

### The "type-3" query/reply **[Confirmed - live capture]**

Both halves were captured live (`.33` client ↔ `.35` host `CE Nation`).

**Query** - 8 bytes, here sent as a **broadcast** to the game port (this is `iplist` mode 2):

```
.33 : 210   →   255.255.255.255 : 24711
03 00 00 00 00 5b 00 00      (a 2nd probe carried ...00 69 00 00)
^type 0x03         ^token
```

Live capture refines the static reading: byte 5 is a **non-zero token** that varies per probe (`0x5b`, `0x69`), not "all rest zero". The reply does **not** echo it.

**Reply** - 59-byte datagram, unicast back to the prober's source port. Field
meanings below are pinned by live probes of **three hosts**: a 1.50 dedicated
(`CE Dedicated`, deathmatch, `maxplayers` 15, 0 players), a non-dedicated LAN
host (`LOCALDEV`, ctf, `maxplayers` 16, host playing), and an internet host
(`CE2022`, ctf, `maxplayers` 28). Example is the `CE Dedicated` reply:

```
03 00 00 00 00 5a 00 33  00 00 00 00 87 60 ff 00  01 10 "CE Dedicated\0"  <tail>
```

| Offset | Bytes         | Field                                                                        | Confidence  |
| ------ | ------------- | ---------------------------------------------------------------------------- | ----------- |
| 0      | `03`          | echoes the query type                                                        | Confirmed   |
| 5      | `5a`          | per-session counter; **+1 per remote-client join**, not per-query (see note) | Confirmed   |
| 7      | `33`          | marker the client validates                                                  | Confirmed   |
| 8-11   | `00 00 00 00` | **zeroed IP field** (querier fills in the probed IP)                         | Confirmed   |
| 12-13  | `87 60`       | game port, little-endian `0x6087` = `24711`                                  | Confirmed   |
| 14     | `ff`          | constant `0xff` (unknown)                                                    | Unconfirmed |
| 15     | `00`          | **teamplay flag** (`00` off / `01` on)                                       | Confirmed   |
| 16     | `01`          | **connected-client count + 1** (see note - host player not counted)          | Confirmed   |
| 17     | `10`          | **`maxplayers + 1`, saturating at 16** (`0x10`) - see note                   | Confirmed   |
| 18+    | `43…00`       | server name, **NUL-terminated** (`CE Dedicated`)                             | Confirmed   |
| tail   | `<tail>`      | **leaked uninitialized memory** - see note                                   | Confirmed   |

> **Offset 15 = teamplay.** `00` for the deathmatch host, `01` for both ctf
> hosts - it tracks the GameSpy `teamplay` field exactly. This is the byte the
> beacon carries at offset 11 (the `ff 01` / `ff 00` pair is `[0xff][teamplay]`).
>
> **Offset 17 is `maxplayers + 1` clamped to 16.** It read `0x10` on the
> `maxplayers` 15 / 16 / 28 hosts and `0x09` on the historical 8-slot `CE
Nation` capture - i.e. `min(maxplayers, 15) + 1`, saturating at `0x10`. So it
> is a usable max only for ≤15-slot servers; above that it pins at 16. Read the
> real `maxplayers` from GameSpy `\status\` (the demo/patch allows up to 30).
>
> **Offset 16 counts _remote clients_, not total players.** Confirmed on two
> hosts: connecting a client to the dedicated host moved it `01` → `02`, and the
> `LOCALDEV` listen server with its host **plus** one joined client read `02`
> while `\status\` reported `numplayers 2` - so exactly the one remote client is
> counted and the host-player is not. So this byte (and the beacon's offset 12) =
> _remote clients + 1_, and reads lower than GameSpy `numplayers` on a listen
> server whose host is playing.
>
> **The reply carries the server's _port_ but a zeroed _IP_ field.** The querier
> fills in the IP it just probed; a parser that takes the IP from the packet
> gets `0.0.0.0`.
>
> **The tail is leaked memory.** The bytes after the name decode to
> pointer-shaped junk that differs per host: `CE Dedicated` leaks ce.exe code/data
> addresses (`9c 34 42 00` = `0x0042349c`, `48 f7 52 00` = `0x0052f748`),
> `CE2022` leaks a stack address (`08 f8 19 00` = `0x0019f808`). The host emits a
> fixed-size struct and never zeroes the slack. No real `map`/`maxplayers`
> fields live there - read those from GameSpy `\status\` (§1b).
>
> **Offset 5 is a per-session counter that bumps on player join.** It is _not_
> per-query (back-to-back probes return the same value) and does not echo the
> query token. A remote client joining moved it `0x5a` → `0x5b` on the dedicated
> host and `0x09` → `0x0a` on the `LOCALDEV` listen server - +1 per join on two
> independent hosts, tracking the offset-16 client byte - and a 1999 note saw the
> same `24` → `25`. Its per-host baseline differs (`0x5a` / `0x09` / `0xf9`), so
> it carries session history, not just the current count. A content-checksum was
> ruled out: no byte-sum window over the record reproduces all three baselines.
> Best read as a **state-change / event counter** (the same class of event that
> triggers a GameSpy `\statechanged\` heartbeat), seeded by the session's earlier
> activity; the exact set of triggering events (leaves, map loads, …) is unpinned.

This reply is structurally **the same record as the LAN beacon** (§3): the beacon is this reply minus the 4-byte IP field, and every field from the port onward (teamplay, client count, clamped max, NUL-terminated name) matches. See the beacon section for the side-by-side.

### Why the in-game browser finds no internet servers (stock) **[Confirmed]**

The default menu path spawns `iplist.exe` in **mode 1**, which probes with the **legacy `'B'`/`'G'` messages on port `211`**. Servers in the modern lineage do **not** answer that protocol. The protocol they _do_ answer - **type-3 on `24711`** - is reachable only via mode 2, which the stock menu never invokes (and which was additionally hampered by the port-truncation quirk above). So out of the box the internet browser stays empty even when `iplist.txt` points at a live, joinable server.

A live community-run server **does** answer the type-3/`24711` query - so routing the browser through that path makes internet servers appear. Three live hosts across the modern lineage answer it (a 1.50 dedicated, a `1.43`-reporting LAN host, and a community internet host), so the responder is part of that lineage; whether a truly stock, unpatched 1.41 host answers is untested (no such host available) and remains under Open Questions.

---

## 3. LAN discovery

### Does it broadcast over the subnet? **[Confirmed - yes]**

Yes. The game runs `iplist.exe` against `255.255.255.255` with `SO_BROADCAST` set, so the discovery side sends its 8-byte probe as a subnet broadcast (legacy `'B'`/`'G'` to `211` in the stock path).

### Does a hosted game _respond_ to discovery probes? **[Confirmed - no, it _announces_ instead]**

A self-hosted server in this lineage was observed to **bind only `24711` (game) and `4711` (GameSpy)** and to answer **none** of the `iplist` probes - not the legacy `'B'`/`'G'` on `211`, and not type-3 on `24711` - from either localhost or another machine. Meanwhile a DirectPlay client could still connect to it.

The host is not a query/response responder for LAN discovery. Instead it **pushes an unsolicited beacon** (next section), so the discovery model is announce-driven, not poll-driven.

### LAN beacon (`'D'` → `:210`) **[Confirmed - live capture]**

An **idle dedicated host broadcasts an announcement once per second**, from the game port to the `iplist` bind port:

```
<host> : 24711   →   255.255.255.255 : 210      (UDP broadcast, ~1.0 s cadence)
  game port             iplist's bind port
```

Because `iplist.exe` already **binds `210`** (it sends its probes _from_ there), a listener on `210` receives these beacons without ever sending a probe. So LAN discovery is **push-based**: the host advertises; iplist/the game just listens.

The payload is **`14 + name_len + 1` bytes** (24 for the 9-char `CE Nation`):

```
44 00 00 00  00 04 00 10  87 60 ff 01  01 09  43 45 20 4e 61 74 69 6f 6e 00
```

| Offset | Bytes      | Field                                                              | Confidence  |
| ------ | ---------- | ------------------------------------------------------------------ | ----------- |
| 0      | `44`       | message type **`'D'`** (0x44)                                      | Confirmed   |
| 1-4    | `00…00`    | reserved (always zero)                                             | Inferred    |
| 5      | `04`       | **≈ maxplayers / 2** (⌊clamped max ÷ 2⌋); config-derived, not live | Inferred    |
| 6      | `00`       | reserved (always zero)                                             | Inferred    |
| 7      | `10`       | **`name_len + 7`** (`0x10` = 16 → a 9-char name)                   | Confirmed   |
| 8-9    | `87 60`    | game port, little-endian `0x6087` = `24711`                        | Confirmed   |
| 10     | `ff`       | constant `0xff` (unknown)                                          | Unconfirmed |
| 11     | `01`       | **teamplay flag** (`00` off / `01` on)                             | Confirmed   |
| 12     | `01`       | **connected-client count + 1** (remote clients; host not counted)  | Confirmed   |
| 13     | `09`       | **`max players + 1`, saturating at 16** (`0x09` → 8 slots)         | Confirmed   |
| 14+    | `43…6e 00` | server name, **NUL-terminated** (e.g. `CE Nation`)                 | Confirmed   |

> **Offsets 7 and 13 (patch RE + multi-sample capture).** The `CE Nation` sample above hides the distinction between offset 7, offset 13, and the name length: the name is **9 chars** and the host has **8** max players, so offset 13 (`maxplayers+1 = 9`) equals the name length, and offset 7 (`name_len+7 = 16`) blends into the `00 04 00 10` run. A longer sample separates them - `CodenameEagle.net US West` (25 chars, 8 max players) sends **offset 7 = `0x20` (32 = 25+7)** and **offset 13 = `0x09` (8 max players)**, with the name running 25 bytes to its NUL. So the name is delimited by its **NUL terminator** (offset 7 corroborates the length), **not** by a byte-13 length prefix - reading byte 13 as the length truncates long names and drops beacons whose `maxplayers` runs past the packet end. `parseBeacon` in `src/api/lan.ts` implements this; `test/lan.test.ts` carries both captured beacons.

> **Byte 13 saturates at 16 (`0x10`).** Live type-3 probes (§2, the same field) read `0x10` for hosts with `maxplayers` 15, 16 and 28, and `0x09` for an 8-slot host - i.e. `min(maxplayers, 15) + 1`. So `parseBeacon`'s `maxPlayers` is exact only for ≤15-slot servers and reports 15 for anything larger; the true value comes from GameSpy `\status\`. `parseBeacon` is a fallback for hosts that don't answer `\status\`, so this is acceptable but worth knowing.

> **Byte 11 = teamplay, byte 12 = clients+1 - confirmed live on the wire.** In one `:210` capture of the `LOCALDEV` ctf host, byte 12 flipped `01` → `02` mid-stream the moment a remote client joined (the beacon is rebuilt from live state each ~1 s), while byte 11 stayed `01` (teamplay on). So byte 12 counts _remote clients + 1_ - the host-player is not included - and byte 11 is teamplay. The `ff 01` pair is `[0xff constant][teamplay]`. This matches the three-host type-3 capture (§2).

> **Byte 5 ≈ maxplayers / 2, and does not track live state.** Across the captured beacons it fits `⌊min(maxplayers, 15) / 2⌋`: the 8-slot `CodenameEagle.net US West` sent `0x04`, and `LOCALDEV` (15/16 slots, clamped to 15) sent `0x07`. In the same live capture where byte 12 flipped on a join, byte 5 held `0x07` throughout - so it is derived from the configured max, not live state (unlike the type-3 offset-5 join counter, §2, a different field). Only two distinct maxplayers have been sampled, so this is provisional - a host with a different max (e.g. 4 or 6) would confirm it. Bytes 1-4 and 6 are reserved (always zero).

> Note the game port is embedded **little-endian** in the payload (`87 60`), whereas it appears network-order (`60 87`) in the UDP header. Unlike the type-3 reply, the beacon carries no IP field at all - the receiver uses the source IP of the datagram.

**Same record as the type-3 reply, from the port onward.** The beacon is close to the §2 type-3 status reply with the 4-byte IP field removed - the game port, the `ff 01`, the player-count byte, the max-players byte and the NUL-terminated name line up. The two differ in the header bytes at offsets 5 and 7: in the beacon offset 7 is `name_len + 7`, whereas in the reply it is a fixed marker (`0x33`) the client validates.

```
beacon (24B):  44 00 00 00 00 04 00 10            87 60 ff 01 01 09 "CE Nation\0"
reply  (59B):  03 00 00 00 00 24 00 33  00 00 00 00 87 60 ff 01 01 09 "CE Nation\0" <tail>
                                        └ zeroed IP ┘
```

By analogy with the beacon, the reply's offset-17 byte (`09` above, the beacon's offset 13) is most likely **max players + 1** and the name is NUL-terminated from offset 18 - though only the beacon side is cross-checked against multiple captures.

**The beacon is continuous, and offset 12 tracks the client count.** Across a ~14-min capture the host emitted **835 beacons at ~1.0 s**, never pausing for the active session. Byte 12 split exactly **571× `01` (idle) / 264× `02`**, and the 264 `02` beacons fall precisely inside the connected player's session window - so **offset 12 = connected clients + 1** (a remote joiner; see §2 for why a listen server's own host-player is not counted). The remaining constant bytes are 4-6 and the `0xff` at offset 10; offset 11 is teamplay and offset 13 is the clamped max (offset table above).

> Caveat: in one captured session the beacon _appeared_ to never change with players, but that session was logged `nPlayers=0` on the console (a failed/odd join), so the count genuinely stayed at `01`. With a real connected player it flips to `02`, confirming offset 12.
>
> Bytes 4-6 and the `0xff` at offset 10 are still unexplained; they did not move between idle and 1-player. (Offset 7 is `name_len + 7`; offset 11 is teamplay; offset 12 is clients+1; offset 13 is `maxplayers + 1` clamped to 16.)

### Practical consequence for modding

Changing which port/protocol `iplist` _probes_ with affects the **internet** (`iplist.txt`) browser only. LAN discovery is unaffected by that, because it does not rely on iplist's probe at all - it relies on the host's `'D'`/`210` beacon being received on the wire.

> **GameSpy LAN queries on `4711`** and **DirectPlay session enumeration** are not needed to explain plain LAN browse - for the stock host this beacon accounts for it. Those paths may still exist; they are not the leading explanation.

---

## 4. `lobby.exe` (session layer)

The multiplayer session runs in a **separate helper process, `lobby.exe`** (`"Lobby version: 0.38  Copyright (c) Refraction Games 1999"`), with game traffic on UDP `24711`. `ce.exe` is "the application"; `lobby.exe` owns the socket and the wire protocol. The join handshake is visible in `lobby.log` (`ConnectToTCPServer(<ip>)`, a handle, `DP_STARTPACKETS`, then the game loop).

### "TCP" here means the IP service family, not the TCP transport **[Confirmed - static analysis of 1.41 `LOBBY.EXE`]**

The `lobby.log` line `ConnectToTCPServer(%s)` (and its sibling `ConnectToIPXServer(%d.%d.%d.%d.%d.%d)`) names the **protocol family** the session uses - **TCP/IP vs IPX**, the two 1999-era LAN/internet stacks - _not_ the transport protocol. The actual socket is **UDP**:

- `LOBBY.EXE` uses the **connectionless** Winsock calls - `sendto`, `recvfrom`, `bind`, `htons`, `inet_addr` - and **none** of the stream calls (`connect`, `listen`, `accept`, `send`, `recv`). (RE note: it loads Winsock via `GetProcAddress`, so these show up as **indirect calls through `DAT_*` pointers** - set in the init function near the `s_sendto_*`/`s_recvfrom_*` string loads - not as named imports; find a call site by the nearby diagnostic string, not by an import xref.)
- The "TCP" socket is created at `0x40a319` as **`socket(AF_INET=2, SOCK_DGRAM=2, IPPROTO_UDP=0x11)`** - a UDP datagram socket. The `"Invalid TCP socket()"` string is just that call's failure message.
- It binds the game port: `0x40b689` does `mov word [0x423ff0], 0x6087` (`0x6087` = **24711**), then `htons` + `bind` it.

So both the discovery layer (§1-3) and the session layer are **UDP/IP**; nothing in CE speaks stream TCP. The `IDirectPlay*`/`DPERR_*` strings in `LOBBY.EXE` are the **standard DirectPlay SDK error-description table** (plus the `IDirectPlayLobby::RunApplication` launch path `ce.exe` uses to spawn the helper); the gameplay **transport is `lobby.exe`'s own hand-rolled UDP**, not DirectPlay messaging - confirmed by the raw `sendto`/`recvfrom` path and its own reliability counters below.

### Host/"slave" model + reliability layer **[Confirmed - `LOBBY.EXE` strings]**

`lobby.exe` is **host-authoritative** and rolls its own reliable-messaging layer on top of UDP. The diagnostic strings spell out the model:

- `Server nPacketsLoss=%d SlaveOnline=%d` - one **host** ("Server"), N **slaves** (clients); per-slave online state and packet-loss accounting.
- `nResendsReq=%d nResends=%d nHostActionsSent=%d nHostActionsRec=%d` - the unit of reliable delivery is a **"host action"**; unacked actions are **resent**. This is why the join packets below retransmit until acked rather than relying on a stream.
- `DP_STARTPACKETS` is a **ce.exe → lobby.exe ready signal**: `LOBBY: Application sent DP_STARTPACKETS after %f seconds!` vs the error `Application never sent DP_STARTPACKETS!`. The game tells the helper "begin the packet loop" once it has finished loading.

### Gameplay protocol: input-broadcast lockstep **[Confirmed - `LOBBY.EXE` + `ce.exe` decompiles]**

> **RE trap:** `ce.exe` `FUN_00477df0`/`FUN_00477f70` look like a per-frame state-snapshot pipeline (as if CE streamed **full per-object state** down to clients and clients only rendered). They are not - they are the **savegame / join full-state (de)serializer** (sole caller `FUN_00478660` `fread`s from a `FILE*` and emits `LoadPlayer…` errors), _not_ the per-frame wire protocol. The real model is **deterministic input lockstep**, confirmed independently across `lobby.exe` and `ce.exe`.

CE is a **deterministic input-lockstep** game (think 1990s RTS), with a **hybrid authority split**: object **motion/physics is peer-deterministic** (every machine simulates it identically), while **outcomes are host-authoritative** (damage, deaths, respawns, score, AI - computed only on the host and broadcast as events).

**Client → host: a compact 4-byte input frame, not positions or scancodes.** `lobby.exe` (not `ce.exe`) owns input: it imports `DINPUT.dll`, creates a DirectInput keyboard device, reads mouse + joystick, and maps keys through `keyconf.dat`/`keydefs.dat` into **13 abstract "actions"** (the parser requires exactly `0xd`). `FUN_00409860` packs the current input into **four bytes**:

```
[0] aimX   signed byte, clamped −127..+127   (look/aim horizontal)
[1] aimY   signed byte, clamped −127..+127   (look/aim vertical)
[2] dirs   two signed 4-bit nibbles (hi<<4|lo) (quantised movement axes, ±7)
[3] btns   bit-field (bit7 = aim-active, low bits fire/use, high nibble weapon)
```

The client sends this as UDP type `0x02` to the host. It is **abstracted, quantised input intent** - not scancodes, not computed positions. These are the "host actions" the reliability layer counts/resends.

**Host → all: the merged input set, re-broadcast (not state).** The host packs every player's latest 4-byte input into one `0x81`-byte frame (`[nPlayers u8][32 × 4 bytes]`, stored at `DAT_00423a60`) and sends it as UDP type `0x14`. `lobby.exe` pipes that `0x14` frame to its **local** `ce.exe`, which copies it into a **256-slot input ring** (`DAT_00541798`, stride `0x81`, write head `DAT_005519f8`).

**Every machine - host and clients - runs the identical deterministic simulation** from that shared input stream. The sim step `FUN_00479aa0` consumes the ring at read head `DAT_005519fc`, applies each player's intent via `FUN_0047ab50` (input → intent fields `obj+0x50/54/58/5c/60` → the object's `+0x308` behaviour callback → gravity + `pos += vel` integration), runs collision and the `.scr` script VM, and advances the **synchronized tick `DAT_0053fab0`**. None of physics, collision, script VM, or projectile motion is host-gated - clients integrate their **own** player locally from the input stream too.

**Why your own player still feels laggy:** pure lockstep input delay. Your input travels to the host, is merged into the turn, travels back as the `0x14` frame, and only _then_ does your local sim apply it - and the sim cannot advance past a tick whose `0x14` frame has not arrived (`DAT_005519fc != DAT_005519f8` gates the step), so a single late peer **stalls everyone** (`FreezeHost`). That is the literal mechanism behind "laggy on the internet, LAN-only" - not a state round-trip.

**Synchronized tick + built-in desync detection.** The host stamps the global tick `DAT_0053fab0` into the `0x26` GAMEINFO packet (`FUN_00477360`); clients adopt it (`FUN_00477230` sets `DAT_0053fab0` from the packet). Desync is **detected, not corrected**: `FUN_00479a00` computes a per-tick checksum = the float sum of every player's x+y+z; the host keeps a 512-entry ring of it (`DAT_00540c50[tick & 0x1ff]`), each client sends `(tick, checksum)` as packet `0x3c` every 36 ticks, and on mismatch the host logs **"Player %s: WORLD OUT OF SYNC"** to `netlog.txt`, bumps the `OutOfSync` counter, and drops the player (msg `0x27` → session teardown, `FUN_00473f00`). Note the checksum only samples _player positions_ (and is an x87 float sum), so object-state divergence stays invisible until it moves a player.

**Randomness is lockstep-deterministic by construction.** The only `srand` in the binary is `srand(0x1267)` - **4711**, the same magic as the autostart flag - run once per level load (`FUN_0046a0c0`), filling a **512-entry int16 random table** (`0x5555e0`) that is byte-identical on every machine (nothing is ever time-seeded). Two independent cursors read it: the **sim stream** (`FUN_0046a080`, cursor `0x53faf0`) feeds gameplay (script `REFRandom`/`REFRandomItem`, gib counts, spawn timers), while the **FX stream** (`FUN_0046a050`, cursor `0x53faf2`) feeds particles/splashes/environment - so rendering more effects on one machine cannot shift the gameplay stream. The sim cursor is **reset to 0 at MP game start and at every player create/respawn** (`FUN_0044d480` - lockstep events executed at a wire-specified tick via `DP_REBIRTH 0x31`, whose spawn point is host-chosen and transmitted), giving the stream a periodic hard re-sync; one sim draw is also burned per world tick. Leftover CRT `rand()` consumers are quarantined to SP-only AI and local audiovisual variation. **Residual desync vectors:** `REFGetTime` exposes QPC wall-clock (not the sim tick) to scripts; the sword-swing animation picks by CRT `rand()` (harmless unless anim ever feeds hit logic); and the checksum's own float-sum fragility above.

**Host authority lives in the _outcomes_, gated by `DAT_005519f0`** (`==0` = authoritative simulator: single-player _or_ the MP host; `==1` = non-authoritative client - note this polarity is the **opposite** of an intuitive "1 = host" guess, and a few loader call-sites reuse the flag in the other sense, so classify per-call-site). Only the authoritative side runs: projectile-impact damage (`FUN_00479aa0` → `FUN_004250f0`), explosion/splash damage (`FUN_00435c80` returns early when `==1`), AI navmesh (`LoadAIMap`), respawns/corpse cleanup (`FUN_004766e0`), and the full-state load path (`FUN_00477df0`, used only at join/savegame). Clients **receive** these outcomes as events (status `0x2f`, rebirth `0x31`, stats `0x48`, …) rather than computing them. So CE already separates _deterministic movement_ from _event-driven authoritative outcomes_.

**Tick ≈ 27 ms (`timeSetEvent(0x1b, …)`, ~37 Hz).** `lobby ↔ ce.exe` IPC is over **named pipes**, 5-byte header `[connId u8][playerId u8][msgType u8][payloadLen u16]` + payload (`FUN_0040b060` write / `FUN_0040b120` read on the lobby side; dispatcher `FUN_00477640` on the `ce.exe` side).

### `player<N>.txt` - end-of-session diagnostics dump **[Confirmed - `LOBBY.EXE` decompile]**

On exit, `lobby.exe` writes a small text file named **`player%d.txt`** (`%d` = the local player number `DAT_00423ad0` - `0` on the host, the assigned slot on a client, `99` if a client exits before getting one; it is the same value used as the `playerId` byte in the pipe header) into its working directory - `fopen(..., "wt")`, so it is **created/truncated and written**, not read. It is gated on Winsock having loaded (`DAT_00423cd8`), and there are two emit paths, both in the lobby run/exit code (`FUN_0040b450` / `FUN_0040b240`):

- **Normal exit** (after the main priority loop returns) dumps the session's network accounting - one `fprintf` each: `TCP protocol` / `IPX protocol` (launch-flag bit 4), `Host` / `Client` (bit 2), `FreezeHost=%d IsHostComputer=%d`, `Server nPacketsLoss=%d SlaveOnline=%d`, `nResendsReq=%d nResends=%d nHostActionsSent=%d nHostActionsRec=%d`, and `ExitPrintMessage %s nPlayers=%d`.
- **Error exit** writes `ExitWithPipeMemError` instead: `FUN_0040b240` fires from the pipe-writer `FUN_0040b060` when a message to `ce.exe` would exceed the header's `u16` payload limit (`0xffff`), then terminates the session.

So `player<N>.txt` is a **post-mortem connection-quality report** (transport, host role, packet loss, resends/host-actions, final player count) - a sibling of `lobby.log`, written once per run keyed by player number so peers/instances don't clobber each other. Nothing reads it back; it is developer/QA diagnostics.

> The findings above come from a Ghidra decompilation of `LOBBY.EXE` 1.41 (same image base as `ce.exe`, `0x400000`). Note the socket/resend code lives only in `LOBBY.EXE` - a decompilation of `ce.exe` has none of it.

Classic DirectPlay enumerates sessions over UDP `47624` plus a dynamic `2300-2400` range; CE does **not** appear to use that (no stream sockets, its own UDP transport), so any DirectPlay role is limited to launch/lobby. **[Inferred]**

### Observed join sequence **[Inferred - one captured session]**

A single join was captured (`.33` client → `.35` host, all on UDP `24711`). It ran **~529 s after** the type-3 discovery probe - discovery and join are independent steps, not back-to-back. Opcodes below are from one session, so treat them as provisional.

Control packets share the **8-byte** shape `<type> 00 00 00 00 <val> 00 00` - the same framing as the type-3 query:

| Dir | Len | Type   | Notes                                                            |
| --- | --- | ------ | ---------------------------------------------------------------- |
| C→S | 8   | `0x01` | connect/keepalive, `val=1`, sent repeatedly                      |
| C→S | 8   | `0x3d` | request that draws the connect reply below                       |
| S→C | 40  | `0x3d` | **connect reply** - carries the current **map name** (see below) |
| C→S | 20  | `0x17` | **player-name registration** (see below)                         |

**Connect reply (40 B, type `0x3d`)** carries the loaded map name:

```
3d 00 00 00 00 a0 00 20  "No mans land\0…"  <tail>
                          ^ map name ("No mans land" = NML)
```

(The trailing `<tail>` is the same leaked-memory pattern as the type-3 reply - §2.)

**Player-name registration (20 B, type `0x17`)** - the client announces its name, retransmitted ~10× at ~0.216 s until acked:

```
17 00 00 00 00 9a 00 0c  52 65 78 78 69 65 00 00 00 00 00 02
^type        ^seq  ^len12  "Rexxie" + pad ………………………………… ^?02
```

The name is length-prefixed (`0x0c` = 12-byte field) and zero-padded. When the player left, the host fell straight back to idle `'D'` beacons (§3).

---

## 5. The join full-state handshake (ce.exe pipe level) **[Confirmed - decompile + capture]**

When a client joins, the host syncs the **entire world state** to it over the `lobby → ce` pipe before per-tick play begins. This is the ce.exe-side view of §4's join (the pipe messages `ce.exe` consumes), reverse-engineered from the client dispatch switch in a Ghidra decompilation of `ce.exe` 1.41 and confirmed against captured recordings of the lobby pipe stream. All handlers validate payload length against a hard-coded size whose mismatch logs a `DP_*_size_error`, which is how the record names below are known.

```
CLIENT                                   HOST
  |<---- 0x3d  connect-reply --------------|  map name[0..0x1e] + mode[0x1f]   (FUN_00477490)
  |----- 0x17  DP_WANTTOJOIN ------------->|  name[0..9] + team[0xb]           (host: FUN_004732f0)
  |                                        |  host now bursts the full state:
  |<---- 0x26  GAMEINFO -------------------|  tick(u32)+rules+checksum          (FUN_00477360/230)
  |<---- 0x24  DP_STARTPACKETS ------------|  "begin object stream"
  |<==== ~Nx 0x1c  (103 B each) ===========|  every world object + player       (FUN_00473130)
  |<==== interleaved 0x1d (14 B ×6/pkt) ===|  per-part rotation + rel-position  (FUN_004728b0)
  |<---- 0x2d  DP_PLAYERITEMMESSAGE -------|  per-player weapon/item inventory   (FUN_004731a0)
  |<---- 0x2f  DP_PLAYERSTATUS (74 B) -----|  roster: names+team+score          (FUN_00477070)
  |<---- 0x1b  DP_NEWREDPLAYER (1 B) ------|  spawn the joining player + team    (FUN_00472c30)
  |                                        |  --- steady state (§4) ---
  |<==== per-tick 0x14 merged-input =======|  lockstep input ring
  |<==== 0x15 heartbeat ===================|
```

### Record types

- **`0x3d` connect-reply** (`FUN_00477490`): `name[0..0x1e]` NUL-terminated level name (looked up in `menuinfo.dat` → level index `DAT_004c2d14`) + `[0x1f]` mode flag. This is what makes a joining `ce.exe` load the right level.
- **`0x17` DP_WANTTOJOIN** (12 B; host handler `FUN_004732f0`): the joiner's own **name** (`[0..9]`, `strncpy` 10 into `DAT_00554f20 + idx*0x12`) + **team** (`[0xb]`). Receiving this is what triggers the host to emit the whole burst below.
- **`0x26` GAMEINFO** (0x1a B): `[0]=u32` the **synced game tick** `DAT_0053fab0` (also the ring bound the `0x3c` desync-check uses), then game rules (frag/score limits, teamplay), flag-carrier bits, and a `[0x18]=u16` content **checksum** the client cross-checks (mismatch → disconnect code 6).
- **`0x24` DP_STARTPACKETS**: "start of object stream" marker (sets `DAT_005519bc`). (Note: `ce.exe` also _sends_ a `0x24` when it has finished loading - see §4/the ABI table; the byte is reused both directions.)
- **`0x1c` object/player spawn** (103 B = `0x67`; `FUN_00473130`, (de)serialize `FUN_00472da0`/`FUN_00472fa0`) - see the layout table below. **This is a _generic_ object-spawn record, not just players**: players and world objects share one 0x330-byte struct and this one wire format; the leading id byte routes it - **`id < 0x20` → player** array `DAT_0053fab4` (max 32), **`id ≥ 0x20` → world object** array `DAT_0053fabc` at `id-0x20`. A recording's join burst is therefore mostly world objects (map pickups, vehicles) with ids `0x20+`. A player object is `type == 4` (payload `+0x01`).
- **`0x1d` part orientation** (14 B/part, batched 6/packet; `FUN_004728b0`): per articulated sub-part (turrets, wheels, limbs) - `[0]` object id, `[1]` part index, `[2..7]` two quantized axis vectors (third reconstructed by cross-product → 3×3 rotation matrix), `[8..d]` three quantized `s16` relative-position offsets.
- **`0x2d` DP_PLAYERITEMMESSAGE** (≤0x42 B; `FUN_004731a0`, builder `FUN_00473200`): **the per-player weapon/item inventory** - `[0]` player index, `[1]` item count, then `count × u16` **item-type ids** (from the player's mother object `O+0x2e0` list; each id is an item's `+0x2b4`). The receiver re-adds each item to the player. Each held item is itself a world object whose own state arrives in its `0x1c` record.
- **`0x2f` DP_PLAYERSTATUS** (74 B; `FUN_00477070`): the **roster** - batches of up to 4 × 0x12-byte entries `{name[10], score/status u32s}` written into `DAT_00554f20` (name) / `DAT_00554f2c` (status). How the joiner learns _existing_ players' names/teams/scores. Scoreboard only - carries **no** weapon data.
- **`0x1b` DP_NEWREDPLAYER** (1 B; `FUN_00472c30`): spawn the joining player (type 4 on-foot), `[0]` = team (0/1/2 = auto-balance). Broadcast so peers spawn the newcomer.

### `0x1c` payload layout (103 B) - key fields

`P` = the object struct; `O` = its 3D object `DAT_0053fa98[P+0x7c]`.

| off       | type  | field             | meaning                                              |
| --------- | ----- | ----------------- | ---------------------------------------------------- |
| 0x00      | u8    | (id)              | `<0x20` player slot, `≥0x20` world-object slot       |
| 0x01      | u8    | `P+0x44`          | **object type** (player = 4; asserted `≤ 0x43`)      |
| 0x02      | u16   | `P+0x46`          | **flags** (bit0 = in-vehicle, …)                     |
| 0x10-0x18 | 3×f32 | `O+0xd0/d4/d8`    | **position X/Y/Z**                                   |
| 0x1c-0x24 | 3×f32 | `O+0x120/124/128` | velocity / orientation                               |
| 0x39      | u16   | `P+0x286`         | **health** (`< 1` = dead)                            |
| 0x3b      | u16   | `P+0x288`         | **vehicle health**                                   |
| 0x5c      | u8    | `P+0x322`         | **team** (bit0)                                      |
| 0x65      | u16   | `P+0x324`         | **parent / "mother"** vehicle link (`0xffff` = none) |

The remaining bytes are per-object/vehicle state u32s (incl. fuel/armor/ammo-type counters); there is **no name and no inventory** in `0x1c` - those are `0x17`/`0x2f` (names) and `0x2d` (inventory).

### What is (and isn't) synced per player

| datum                   | sent?                          | via                                                      |
| ----------------------- | ------------------------------ | -------------------------------------------------------- |
| Name                    | yes                            | own → `0x17`; others → `0x2f` roster                     |
| Team                    | yes                            | `0x1c +0x5c`, `0x1b`, `0x2f`                             |
| Position / orientation  | yes                            | `0x1c +0x10..0x24`; per-part `0x1d`                      |
| Health / vehicle health | yes                            | `0x1c +0x39 / +0x3b`                                     |
| **Weapon inventory**    | **yes**                        | **`0x2d`** (held item-type ids) + each item's own `0x1c` |
| Fuel / armor / ammo     | as object state u32s in `0x1c` | - (no separate ammo message)                             |

### Relationship to the savegame serializer

`FUN_00477df0`/`FUN_00477f70` (the misleading-looking functions flagged in §4's RE-trap note) are the per-**part** (0x100 B) blob (de)serializers used by the **savegame** path (`FUN_00478170` _SavePlayer_ / `FUN_00478660` load). The complete authoritative per-player savegame state = the 103-B `0x1c` core (`FUN_00472da0`) + scalar extras + `N × 0x100` part blobs + the inventory id list - i.e. exactly the same content the network splits across `0x1c` / `0x1d` / `0x2d`. Savegame and join-sync are two encodings of one authoritative object state.

### Why this matters for spectating/replay tools: state vs. input **[Confirmed - decompile]**

Anyone rebuilding a spectator or replay client from these packets needs to reproduce the split between input and replicated state. The lockstep input ring (`0x14`) carries only **movement/aim + a fire bit**, applied to _every_ player deterministically (`FUN_0047ab50` → `obj+0x60`, no local/authority gate) - so movement and the _act_ of firing reproduce for all players from input alone. But **which weapon a player holds is replicated state, not input-derived**: it lives in object relationships (`obj+0x2e8/2ec/0x324`, weapon type `obj+0x44`) set from the host-authoritative snapshots (`0x1c` join, `0x2d` inventory, `0x31` rebirth, resyncs; applied by `FUN_00472fa0`), plus a client-side weapon-select **prediction** (`FUN_00444aa0`, gated to clients `DAT_005519f0 != 0`; the nibble→weapon-change path is compiled _off_ on the authoritative host). Consequently a tool that re-feeds only the `0x14` input stream reconstructs the _local_ player perfectly but leaves other players holding whatever weapon the last snapshot set - their movement and firing replay, but the _weapon_ is wrong. Faithful all-player reconstruction requires replaying the **replicated-state packets** (`0x1c`/`0x2d`/`0x31`/resync) as state, not deriving weapons from input. (Recording from _match start_ also helps: a mid-join client never receives other players' pre-join inventory, so its capture is inherently incomplete for them.)

---

## Open questions

- **Remaining beacon/type-3 unknown bytes.** After the live captures the only fully-unexplained byte is the constant **`0xff`** at beacon offset 10 / type-3 offset 14. Two items are provisional: **beacon offset 5** (fits `⌊maxplayers/2⌋` on two hosts - confirm with a third max value like 4 or 6), and the **exact trigger set for the type-3 offset-5 counter** (confirmed to bump on join and carry a per-session baseline; whether leaves / map loads also bump it is untested). (Resolved: beacon offset 5 ≈ maxplayers/2, type-3 offset 5 = per-session join counter, offset 11 = teamplay, offset 12/16 = remote clients + 1, offset 13/17 = maxplayers+1 clamped to 16, offset 7 = name_len+7.)
- **Does the in-game browser actually consume the `'D'`/210 beacon?** The host is confirmed to broadcast it and iplist binds `210`; whether the receive side surfaces it in the browser is unverified (as is whether GameSpy-on-`4711` / DirectPlay enumeration still play any LAN role).
- **Type-3 responder origin - narrowed.** All three live hosts (a 1.50 dedicated, a `1.43`-reporting LAN host, a community internet host) answer `0x03`/`24711`, so the responder is part of the modern/patched lineage. Whether a **truly stock, unpatched 1.41** host answers is still untested (no such host available).
- **Join opcodes `0x01` / `0x3d` / `0x17`.** From one captured session (§4). Unverified: the full handshake order, what `0x01`'s `val` field means, the meaning of the trailing `0x02` after the registered name, and how a clean leave/timeout is signalled (none was distinctly captured - the host just resumed beaconing).
- **Type-3 tail - resolved (leaked memory).** Live probes of three hosts show the bytes after the name are uninitialized: `CE Dedicated` leaks ce.exe code/data pointers (`0x0042349c`, `0x0052f748`), `CE2022` a stack pointer (`0x0019f808`); they differ per host and carry no real fields. Read map/maxplayers from GameSpy `\status\`. (The `0x3d` connect-reply tail in §4 is the same pattern; a populated-server capture could still confirm whether _that_ reply hides fields.)
- **Mode `4711` (`0x1267`) branch in `iplist.exe`.** Why it keys on the value `4711` and what it's meant to query.
- **IPX path.** The IPX discovery code exists but was not analysed; presumed legacy/dead.
