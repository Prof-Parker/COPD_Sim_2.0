# Multiplayer Migration: Playroom → Cloudflare Durable Objects

**Status:** In progress.
- **Milestone A** (backend skeleton in `cloud/`) is built and deployed.
- **Milestone B** (Net adapter) is built. The game runs on either backend.
- **Milestone C** (server-owned rules) is built and tested locally. **Cloudflare is now the default**; add `?net=playroom` for the old backend. Real-phone QA is still to do.
**Author:** Robin Parker
**Last updated:** November 2026
**Target branch:** `net-cloudflare` (off `Beta`)

---

## 1. Summary

Replace Playroom Kit with a **serverless** backend on Cloudflare Workers and Durable Objects over WebSockets. There is no server to run, patch, or keep online: Cloudflare runs our code only when a student connects, scales it automatically, and puts it to sleep when a room goes quiet. Each patient/observer pair gets its own cloud "room" that owns the game state (instead of a "host" browser). A second room per class session collects final results for a live classroom leaderboard.

> **Terminology:** where this doc says "server," it means our code running on Cloudflare's managed serverless runtime, not a machine anyone maintains. See §5.5 for exactly what is and isn't our job.

## 2. Goals

1. Keep the current patient/observer two-player gameplay unchanged for students.
2. **Stability:** survive refreshes, iPhone auto-lock, and Wi-Fi drops without desync or lost roles.
3. **Scale:** no practical user cap at classroom scale (multiple sections, 30–60+ students each).
4. **Leaderboard:** live classroom view of every pair's ending points, elapsed time, energy, and tie-breaker.
5. Low cost (free tier or ~$5/month).
6. **Serverless only:** no servers, VMs, containers, or databases to install, patch, monitor, or restart. One instructor-developer must be able to own it alongside teaching.

### Non-goals (for now)

- Accounts or student logins (session codes plus nicknames are enough).
- LMS/Canvas grade passback.
- Rooms with more than two players, including mid-game spectators (decided in §10).
- A custom domain (the free `*.workers.dev` address is used).

## 3. Why move off Playroom

| Problem today | Root cause | How the new design fixes it |
|---|---|---|
| Desync after the host refreshes (commits `a2b2f98`, `1b70909`) | One browser is the host and holds the true state | The server owns the state; there is no host |
| Room code lost after `insertCoin`; localStorage join hints | The client has to rebuild its room identity | The URL carries the session and pair code, and a player token restores the role |
| State lags briefly after joining, causing "wait before wiping" logic | Shared state arrives eventually instead of on connect | The server sends a full copy of the state the moment a client connects |
| Clock drift; `sharedTime` broadcast by the host every tick | The host is the timekeeper | The server stores `startedAt` and clients calculate elapsed time |
| User cap on the free tier | Vendor limits | Our own Worker; Cloudflare limits are far above classroom scale |

## 4. Options considered

All options below are serverless (fully managed, nothing to host). They differ in whether we write a small amount of backend *code* or only backend *rules*.

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Cloudflare Workers + Durable Objects (WebSocket)** | Serverless; room-owned state with one request at a time (no races); built-in storage; idle rooms cost almost nothing (hibernation); static hosting on the same domain | We write and own a small amount of backend code (~300–500 lines of JS) | **Chosen** |
| PartyKit / `partyserver` (on top of Durable Objects) | Serverless; handles room routing and connection setup | Extra abstraction layer | Optional helper, same architecture |
| Firebase Realtime DB / Firestore | Serverless; no backend code at all, only security rules; good SDK | Clients still write state directly, so most host-reconciliation logic stays; rules can't enforce ordering as cleanly; free tier caps simultaneous connections | Fallback if we want zero backend code |
| MQTT (HiveMQ/EMQX cloud) | Managed broker; lightweight publish/subscribe | No server-side game rules; still needs a host or retained-message bookkeeping | Rejected |

## 5. Architecture

```
 Student phones / laptops                   Cloudflare
 ┌───────────────┐   wss://.../ws/room   ┌──────────────────────────────┐
 │ Patient       │──────────────────────▶│ Worker (router + static site) │
 │ Observer      │                       │                              │
 └───────────────┘                       │  ┌────────────────────────┐  │
                                         │  │ PairRoom DO            │  │
 Instructor laptop / projector           │  │ id = <session>:<pair>  │──┼──┐ final result
 ┌───────────────┐  wss://.../ws/class   │  └────────────────────────┘  │  │
 │ Leaderboard   │──────────────────────▶│  ┌────────────────────────┐  │  │
 └───────────────┘                       │  │ ClassSession DO        │◀─┼──┘
                                         │  │ id = <session>         │  │
                                         │  └──────────┬─────────────┘  │
                                         │             ▼                │
                                         │        D1 (SQLite)           │
                                         │   sessions, results          │
                                         └──────────────────────────────┘
```

### 5.1 Worker (entry point)

- Serves the compiled Twine `index.html` and assets as static files.
- Routes `GET /ws/room?s=<session>&p=<pair>` to the matching `PairRoom` Durable Object.
- Routes `GET /ws/class?s=<session>` (instructor only) to the matching `ClassSession` Durable Object.
- Provides small REST endpoints: create a session, end a session, export results as CSV.

### 5.2 `PairRoom` Durable Object (one per pair)

The server-owned state:

```
{
  sessionCode, pairCode,
  seq,                       // increases on every accepted change
  roomStarted, startedAt, endedAt,
  currentPassage, passageSeq,
  roles: { patient: <playerToken|null>, observer: <playerToken|null> },
  names: { patient, observer },
  game: { Energy, Points, Inhaler, win, evalComplete, ... }   // = DEFAULT_GAME_STATE keys
}
```

Rules the server enforces:

- **Role claims:** only one patient and one observer. A second claim on a taken role is rejected unless it uses the same player token (a reconnect).
- **Navigation:** a `navigate` request must include the `passageSeq` the client expects; old or stale requests are rejected and the client resyncs.
- **Turn ownership (optional, phase 2):** only the role whose turn it is can change certain keys, such as observer-only evaluation keys.
- **Clock:** `startedAt` is set once when the room starts; `endedAt` is set when the room reaches an end passage (the timer also stops on game-over and win screens).
- **Persistence:** state is written to the Durable Object's own storage after each change, so it survives the object being evicted.
- **Hibernation:** uses the WebSocket Hibernation API so idle rooms cost nothing.

### 5.3 `ClassSession` Durable Object (one per class session)

- Created by the instructor (e.g. session code `COPD-1109A`).
- Tracks which pairs exist and their live status: waiting, in progress, or finished.
- Receives the final result from each `PairRoom` and stores it in D1.
- Pushes leaderboard updates to connected instructor/projector views.
- Can lock the session, which stops new pairs from joining.

### 5.4 D1 (permanent storage)

```sql
sessions(code PK, course, created_at, closed_at)
results(id PK, session_code FK, pair_code, attempt, patient_name, observer_name,
        points, energy, elapsed_ms, has_meds, has_toy, win, finished_at)
```

Used for history, CSV export, and comparing results across sections. D1 is a managed serverless database: no install, backups, or upgrades on our side.

### 5.5 Operations: what we do and don't maintain

| Cloudflare handles (not our job) | Our job |
|---|---|
| Machines, operating systems, security patches | The backend JS in this repo (versioned with the game) |
| Uptime, restarts, scaling up and down | Deploying: push to GitHub → Cloudflare builds and deploys automatically (or one `wrangler deploy` command) |
| TLS certificates, DDoS protection | Occasionally checking the Cloudflare dashboard for errors or usage alerts |
| Database hosting, durability, point-in-time recovery | Deciding the data retention period (§9) |
| Putting idle rooms to sleep and waking them on demand | |

**Deployment:** connect the GitHub repo to Cloudflare (Workers Builds). Merging to `master` deploys the game and backend together; other branches get their own preview URLs for testing. No CI server, no SSH, no hosting bills beyond the plan.

**When nobody is playing,** nothing runs and nothing is billed beyond the plan's base cost. There is nothing to start before class or shut down afterward.

## 6. Message protocol (JSON over WebSocket)

Every message has a `t` (type) field. The server is authoritative and sends a sequence number (`seq`) with every update.

**Client → server**

| `t` | Payload | Notes |
|---|---|---|
| `hello` | `{ token?, name? }` | First message. The server issues a token if none is sent |
| `claimRole` | `{ role }` | `patient` or `observer` |
| `set` | `{ patch: {key: val,...} }` | Game-variable changes |
| `navigate` | `{ passage, expectSeq }` | Rejected if `expectSeq` is out of date |
| `reset` | `{}` | Try Again / restart (rules TBD) |
| `ping` | `{}` | Keepalive |

**Server → client**

| `t` | Payload | Notes |
|---|---|---|
| `welcome` | `{ token, you: {role}, snapshot, seq, serverNow }` | Full copy of the state on every connect or reconnect |
| `patch` | `{ seq, changes }` | Small updates |
| `peer` | `{ role, connected }` | The partner joined, left, or reconnected |
| `reject` | `{ reason, snapshot }` | The client replaces its state with this snapshot |
| `pong` | `{ serverNow }` | Used to correct the client's clock for the timer |

**Reconnect flow:** the client stores `token` in localStorage under the session and pair code, then reconnects with exponential backoff and sends `hello {token}`. The server gives back the same role and a fresh snapshot. If a client sees a gap in `seq`, it requests a full snapshot.

### 6.1 As built (Milestone A)

These differences from the tables above were made during implementation:

- **Full snapshots instead of patches.** The room state is only a few KB, so every change sends `{t:"state", seq, snapshot, you}` to both players. Clients simply replace their copy, so there's no patch-merging or `seq`-gap logic. Cloudflare bills per message, not per byte, so this costs the same.
- **`you` on every message.** Each socket receives its own `{role, name}`, so a client always knows its role without seeing the other player's token.
- **New `inc {key, by, min?, max?}` message.** This is an atomic add on the server. Local testing showed that a client-side "read value, add 1, `set`" loses updates when two clicks land at once. Points, Energy and behavior counters must use `inc`.
- **`sync {}`** asks for a fresh snapshot.
- **Room size:** the first two tokens to join own the room. A third device is rejected with `room_full`; a known token can always reconnect.
- **Test page:** `/ws-test.html?s=TEST1&p=1`. Open it on two devices to check sync, roles, presence and reconnect.

### 6.2 As built (Milestone B — Net adapter)

**How the game reaches multiplayer**
- SimApp and the passages call `window.Net`, never `Playroom` directly.
- `Net` keeps the Playroom-style calls the game already used, so the game logic is unchanged.
- `createPlayroomNet()` passes those calls straight through to Playroom Kit.
- `createCloudNet()` is the WebSocket client, kept in the .twee between `CLOUDNET:BEGIN`/`END` markers so the tests can load it.

**Choosing a backend**
- Playroom is the default (`setup.NET_BACKEND = "playroom"`).
- `?net=cf` in the link switches to Cloudflare.

**CloudNet links and pair codes**
- `?net=cf&s=DEMO1` with no pair code creates a new pair code and writes it into the URL.
- The invite QR is `?s=DEMO1&p=KCP2&net=cf`.
- A link without `s` is refused with a "needs a class session code" message.

**Who is "host"**
- Host is the lowest-numbered connected player: the first to join, like Playroom.
- If that player drops, the partner becomes host until they return.
- This is a temporary shim; Milestone C removes host-only logic.

**Writes and players**
- Writes show up locally at once and are sent to the server in one batch per tick.
- The server's `ack` confirms them.
- Writes made while offline are re-sent after reconnecting.
- Players get public ids (`p1`, `p2`) from the server; tokens never leave the device that owns them.

**Keepalive**
- The client sends the text `ping` every 25 s.
- Cloudflare answers `pong` itself (`setWebSocketAutoResponse`) without waking the room.

**Tests**
- The resync tests run against both backends (42 tests).
- `tests/cloudnet.test.mjs` covers the client (13 tests).
- `cloud/test/` covers the server rules (17 tests).
- The Cloudflare test fake uses the real `room-core.js`.

### 6.3 As built (Milestone C — server-owned rules)

**What the server now decides** (each can no longer race between the two devices):

| Game action | Before (Playroom) | Now (Cloudflare) |
|---|---|---|
| Passage change | Two separate writes plus polling | `navigate {passage, expectSeq, timer, patch}`: one compare-and-set. If the partner moved the room first, this device follows the room. |
| Router rolls (grocery, pharmacy, toy store, wild card) | The host rolled; the other device could read an old roll | `roll {key, sides}`: one roll per key per visit, shared by both. A device whose router screen fires after the room has moved on follows the room instead of rolling again. Passages call `SimApp.routeByRoll(key, [targets], visitedKey)`. |
| Whistle_Stop_In energy drain | Host only | `op {name:"errandsDrain"}`: runs once per visit |
| Points, Energy, Inhaler, behavior counters | Read, add, write (simultaneous updates could be lost) | `inc`: atomic on the server; Energy clamped to 0–15 |
| Clock | The host's own playtime, sent every second as `sharedTime` | A server clock: starts on the first passage that isn't a lobby screen, pauses on `pausetimer` passages, stops at Final_Report, and restarts with `timer {action:"reset"}`. HUD and debrief both read `SimApp.getElapsedParts()`. |
| Try Again | Reset only the clicker's stats and sent them to Start. The partner didn't follow. | `reset {fromAttempt, game, passage}`: attempt + 1, default stats, new clock, both devices go to **Simulation_Hub** with roles kept. If both players press it, only one new attempt starts. |

**Lobby changes**
- **Session code:** without `?s=`, the Start screen shows a "Class session code" box instead of Connect.
- **Nickname:** Role Selection has an optional nickname box (up to 20 characters). It's remembered on the device and sent to the server for the leaderboard.
- **Taking back a seat:** if a pair is full, a student who switched device or browser can take back whichever seat is offline, keeping its role (`hello {takeover:true}`). They're asked to confirm first. An online seat can never be taken.

**Where the game connects**
- Cloudflare is the default backend.
- When the game isn't served by the Worker (e.g. GitHub Pages or a local file), it connects to `setup.NET_ENDPOINT`, which is `wss://copd-sim.rparker-d61.workers.dev/ws/room`.

**Deliberately kept for now**
- **Playroom-only recovery code** (the `#r=` hash, room hints, snapshot wait) stays, so `?net=playroom` still works as a fallback. On Cloudflare it does nothing. It's removed in Milestone E.
- **Remaining `isHost()` checks** are lobby-only: first-room setup and the invite button. On Cloudflare "host" means "first to join", and the server enforces every rule that matters.

**Fixed along the way**
- `scripts/parse-twee.mjs` didn't recognize headers like `:: Start [nobr]{…}`, which made 4 passages look unreachable. `npm test` now passes end to end.
- Start's Connect/session controls now appear after the passage is displayed (`:passagedisplay`).

**Tests:** 42 resync, 14 client, 7 gameplay (`tests/gameplay-cf.test.mjs`), 27 server, plus the flow validator.

## 7. Client changes

### 7.1 Network adapter

Add a `Net` module with the same surface the app uses today, so most of the story code doesn't change:

| Today (Playroom) | Adapter |
|---|---|
| `Playroom.insertCoin(...)` | `Net.connect({session, pair})` |
| `Playroom.getState / setState` | `Net.get / Net.set` (used by `setVal`/`getVal`) |
| `Playroom.myPlayer().getState("role")` | `Net.me.role` |
| `Playroom.onPlayerJoin` | `Net.on("peer", ...)` |
| `Playroom.getRoomCode()` | `Net.roomCode` |
| `Playroom.onDisconnect` | `Net.on("status", ...)` |
| `Playroom.isHost()` | **Removed** — replaced by role checks, or the logic moves to the server |

Keep a build flag (`NET_BACKEND = "playroom" | "cf"`) so both backends can run side by side until the new one is proven in class.

### 7.2 Twee passages

- About 150 `Playroom.*` references (in `index.html` and the `.twee` source) need updating. Most are `Playroom.isHost()` guards in macros, which become role checks (usually patient-driven) or are deleted because the server handles them.
- `sharedTime` broadcast → calculate the time from `startedAt` and the server clock offset.
- Joining: QR code / invite link becomes `https://<domain>/?s=COPD-1109A&p=07`.

### 7.3 Code that gets deleted

The recovery logic built only to work around Playroom: room-hint persistence and restore, the "wait before wiping" delay after `insertCoin`, host-only room initialization, and most of `recoverSession`.

## 8. Leaderboard

- **Instructor view** (`/class?s=COPD-1109A`): a live table of pairs with status, points, energy, elapsed time, meds, and toy.
- **Projector mode:** large type showing the top N, plus "X of Y pairs finished."
- **Export:** CSV per session.
- **Attempts:** each "Try Again" is a **new attempt** with its own leaderboard row (`attempt` 1, 2, 3...). The leaderboard can show all attempts or each pair's best attempt (toggle in the instructor view).
- **Visibility:** the leaderboard appears **only on the instructor screen** (and the projector view the instructor opens). Students see their own pair's results on the debrief screen as they do today, but never other pairs' results.

### 8.1 Ranking order

Rows are sorted by these rules in order; each rule only applies when every rule before it is tied:

1. **Most points** — highest `points`
2. **Fastest** — lowest `elapsed_ms`
3. **Most remaining energy** — highest `energy`
4. **Has meds** — `hasMedications = true` ranks above `false`
5. **Has toy** — `hasToy = true` ranks above `false`

Pairs still tied after rule 5 share the same rank. Unfinished attempts are listed below finished ones and are not ranked.

## 9. Security & privacy

- **Student privacy (FERPA):** collect only a nickname or first name per role, with no student IDs or emails. Set a retention period, e.g. delete results older than one academic year (a scheduled Worker job can do this).
- **Instructor actions** (create/close session, view leaderboard, export): protected by a single admin PIN stored as a Cloudflare secret (not in the repo). Only one instructor needs access, so no login system.
- **Validation:** the server only accepts known game keys, with type and range checks (e.g. Energy 0–10), plus a per-connection rate limit.
- **Network:** WebSockets over `wss://` on port 443, which normally passes through campus networks.

## 10. Decisions

| # | Question | Decision (Nov 2026) |
|---|---|---|
| 1 | Does "Try Again" replace the earlier result? | **No — each Try Again is a new attempt** with its own leaderboard row (§8) |
| 2 | Mid-game spectators? | **Not supported.** Rooms are exactly two players |
| 3 | Ranking / tie-breaker order | **Most points → fastest → most remaining energy → has meds → has toy** (§8.1) |
| 4 | Custom domain? | **No.** Use the free `*.workers.dev` address |
| 5 | Other instructor access? | **No.** Robin only; a single admin PIN is enough (§9) |
| 6 | Backend code allowed? | **Yes, a small amount of serverless JS** — Cloudflare Durable Objects confirmed over Firebase (§4) |
| 7 | Do students see the leaderboard? | **No — instructor screen only.** Students see only their own pair's debrief (§8) |

No open questions remain.

## 11. Phased plan

| Phase | Scope | Exit criteria |
|---|---|---|
| **0. Spike** | Bare Worker + `PairRoom` echoing state; connect from a test page; GitHub → Cloudflare auto-deploy set up | Two phones stay in sync; a refresh restores the state; a push deploys with no manual steps |
| **1. Adapter** | `Net` module; `setVal`/`getVal` call it; backend flag | Existing tests pass against a mock `Net` |
| **2. Pair rooms** | Roles, navigation, server clock, reconnect | Full multiplayer QA: iPhone + desktop, refresh/lock/Wi-Fi drop tests |
| **3. Remove host logic** | Delete Playroom-only recovery code and `isHost` guards | Fewer lines; no regressions in `validate-flow.mjs` or the resync tests |
| **4. Class sessions + D1** | Session create/close, result reporting | Results saved after a test class |
| **5. Leaderboard UI** | Instructor and projector views, CSV export | Used live in one class section |
| **6. Retire Playroom** | Remove the flag and the Playroom SDK | One full term on the new backend |

## 12. Testing

- Turn `tests/helpers/playroom-mock.mjs` into the shared test suite for the `Net` adapter, so every behavior is tested against both backends.
- Add Durable Object unit tests (Vitest with Cloudflare's Workers test pool): rejecting duplicate role claims, rejecting stale navigation, reconnect with a token.
- Add reconnect chaos tests: drop the connection at random points during a scripted run, then check that both clients end with the same snapshot.
- Run a load check: simulate around 100 pairs to confirm the leaderboard keeps up.

## 13. Cost estimate

**Limits are per account, not per project.** Every Worker on the account (this sim plus any other project moved to Cloudflare) draws from the same quotas.

| | Free plan | Paid plan ($5/month per account) |
|---|---|---|
| Worker requests | 100,000 / day (shared) | 10 million / month included |
| Durable Object requests (each WebSocket message counts) | 100,000 / day (shared with Workers) | 1 million / month included |
| Workers per account | 100 | 500 |
| D1 databases | 10 | more |
| Going over | Requests **fail with an error** until 00:00 UTC | Billed per extra million; nothing breaks |

*(Checked Nov 2026 against Cloudflare's docs; confirm before Phase 0.)*

**Rough usage:** one class of ~30 pairs sending a few hundred messages per player is around 20,000–40,000 Durable Object requests, well within the free daily budget. The real risk is that a second project, or two class sections on the same day, uses up the shared free budget and the game stops working mid-class.

**Recommendation:** start on the free plan for development, then switch to the **$5/month paid plan before using it with students**. That covers this project and future ones on the same account, and going over is billed instead of breaking the game.
