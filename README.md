# COPD Simulation

A two-player nursing simulation about a day in the life of a patient with COPD. One student plays **Mr. Holland**, the patient, managing energy, breathing and an inhaler through everyday errands. Their partner is the **Observer**, who watches each activity and evaluates how the patient handles it. Each pair plays on its own phones or laptops, and the instructor can follow every pair live on a class leaderboard.

**Play:** <https://copd-sim.rparker-d61.workers.dev>
**Instructor page:** <https://copd-sim.rparker-d61.workers.dev/class.html>

## Running a class

1. Open the **instructor page** and sign in with the instructor PIN.
2. **Create a session.** You get a code such as `COPD-K7MQ`, a join link and a QR code.
3. **Students join.** One student in each pair opens the link or scans the QR code. Their partner then scans the invite QR code shown on that student's screen. Each pair gets a team name such as "Steady Otters".
4. **Watch live.** The session page shows every pair's progress and a leaderboard ranked by points, then time, energy left, meds and toy. Use **Projector mode** to put the top 10 on screen.
5. **Wrap up.** Use **Export CSV** to save results, **Close session** to stop new pairs joining, or **Delete** to erase the session for good.

**Optional:** before play, the **Welcome screen** button opens the game's briefing with the join QR code at the bottom, so you can go over it with the whole class.

**Tips**
- If a phone locks or a student refreshes, they rejoin automatically in the same role.
- If a student switches devices, they can open the same pair link and take back their seat.
- No student names are collected. Results are kept for one year, then deleted automatically.

## How it's built

- **The game** is a [Twine](https://twinery.org/) / SugarCube story. The source is `COPD simulation 2.0.4.twee`, and it compiles to `index.html`.
- **Multiplayer** runs on Cloudflare Workers and Durable Objects (`cloud/`). There's no server to maintain: the backend sleeps when nobody is playing and costs nothing while idle.
- **Results** are stored in Cloudflare D1 for the leaderboard and CSV export.

| Path | What's there |
|---|---|
| `COPD simulation 2.0.4.twee` | Story, game logic and styles |
| `index.html` | Compiled game (committed, so it deploys as-is) |
| `Media/` | Images and audio |
| `cloud/` | Cloudflare backend and the instructor page (`cloud/public/class.html`) |
| `tests/`, `scripts/` | Automated tests and the story flow checker |
| `Docs/` | Faculty guide for writing activities, and the multiplayer design notes |

## Making changes

- **Edit the story:** change the `.twee` file, then run `npm run build` on Windows to rebuild `index.html`. This needs [Tweego](https://www.motoslave.net/tweego/), and the path to it is set in `build.ps1`. To add new activities, see `Docs/FACULTY-MACRO-GUIDE.md`.
- **Test:** run `npm test`, which runs the story flow check, game sync, multiplayer and backend tests. In `cloud/`, run `npm install` once first.
- **Try it locally:** in `cloud/`, run `npm run dev`, then open <http://localhost:8787>. For the local instructor PIN, put `ADMIN_PIN=...` in `cloud/.dev.vars`.
- **Deploy:** merge into `master`. Cloudflare builds and publishes the game and backend automatically.

Architecture and design decisions are in [`Docs/MULTIPLAYER-MIGRATION.md`](Docs/MULTIPLAYER-MIGRATION.md).
