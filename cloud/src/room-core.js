/**
 * room-core.js — the pair-room rules, with no Cloudflare APIs.
 *
 * The PairRoom Durable Object (pair-room.js) is a thin wrapper around this module,
 * and the Node tests drive it directly. Keep it pure: no I/O, no globals.
 *
 * Usage:
 *   const room = new RoomCore(savedStateOrNull, { sessionCode, pairCode, now, makeToken, random });
 *   const { out, dirty } = room.handle(conn, message, connectedTokens);
 *     conn            — mutable per-socket object; room-core sets conn.token after "hello"
 *     message         — parsed JSON from the client
 *     connectedTokens — Set of tokens with an open socket (for presence)
 *     out             — [{ to: "self" | "all" | "others", msg }]; send with routeMessages()
 *     dirty           — true when room.state changed and must be saved
 *
 * Messages that change state may carry a client id `cid`. The sender's copy of the
 * resulting broadcast (or reject) includes `ack: cid`, so the client knows its own
 * writes up to that point have been applied (or refused).
 *
 * Game variables (Energy, Points, currentPassage, passageSeq, …) live in state.game, the
 * same keys SimApp uses. The server owns the rules that must not race between devices:
 *   navigate  — compare-and-set on passageSeq (two devices can't both move the room)
 *   roll      — one dice roll per key per passage, shared by both devices
 *   op        — named calculations that must run once (errandsDrain)
 *   inc       — atomic add (counters)
 *   timer     — the room clock (start, pause on pausetimer passages, stop at Final_Report)
 *   reset     — Try Again: new attempt, fresh stats, both devices back to the hub
 *
 * handle() also returns `events` for the class leaderboard (sent on by pair-room.js):
 *   { type: "progress", progress } — status/passage/score changed (join, move, presence)
 *   { type: "result", result }     — the pair reached Final_Report: the official, server-built
 *                                    result for this attempt (sent once per attempt)
 */

export const RESULT_PASSAGE = "Final_Report";
const LOBBY = ["Start", "Role_Selection", "Waiting_Room"];

export const ROLES = ["patient", "observer"];
export const LOBBY_PASSAGE = "Role_Selection";
export const TIMER_MODES = ["run", "pause", "stop", "none"];
const MAX_PLAYERS = 2;
const MAX_NAME_LEN = 20;
const MAX_KEY_LEN = 40;
const MAX_PATCH_KEYS = 80;
const MAX_STRING_LEN = 500;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PASSAGE_RE = /^[A-Za-z0-9_][A-Za-z0-9_. -]{0,79}$/;

export function createInitialState({ sessionCode, pairCode }) {
    return {
        v: 1,
        sessionCode: sessionCode || "",
        pairCode: pairCode || "",
        seq: 0, // increases on every accepted change
        attempt: 1,
        timer: newTimer(),
        once: {}, // roll/op key -> passageSeq it last ran at
        lost: false, // this attempt hit a Game_Over passage
        reported: {}, // attempt -> true once its result was sent
        nextPid: 1,
        players: {}, // token -> { pid, role, name }
        roles: { patient: null, observer: null }, // role -> token
        game: { currentPassage: LOBBY_PASSAGE, passageSeq: 0 },
    };
}

function newTimer() {
    return { startedAt: null, pausedAt: null, pausedMs: 0, stoppedAt: null };
}

/** Milliseconds on the room clock at `now` (paused and stopped time excluded). */
export function timerElapsed(timer, now) {
    if (!timer || timer.startedAt === null || timer.startedAt === undefined) return 0;
    const end = timer.stoppedAt ?? timer.pausedAt ?? now;
    return Math.max(0, end - timer.startedAt - (timer.pausedMs || 0));
}

export function cleanName(name) {
    if (typeof name !== "string") return "";
    return name.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, MAX_NAME_LEN);
}

function isPlainValue(v) {
    if (v === null) return true;
    const t = typeof v;
    if (t === "boolean") return true;
    if (t === "number") return Number.isFinite(v);
    if (t === "string") return v.length <= MAX_STRING_LEN;
    return false;
}

function validPatch(patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return false;
    const keys = Object.keys(patch);
    if (keys.length === 0 || keys.length > MAX_PATCH_KEYS) return false;
    return keys.every((k) => k.length <= MAX_KEY_LEN && KEY_RE.test(k) && isPlainValue(patch[k]));
}

function validKey(key) {
    return typeof key === "string" && key.length <= MAX_KEY_LEN && KEY_RE.test(key);
}

function pidNumber(pid) {
    return Number(String(pid || "").replace(/^p/, "")) || 0;
}

function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * Sends `out` to the right sockets. Shared by the Durable Object and the test fake.
 * @param {RoomCore} room
 * @param {{to: string, msg: object}[]} out
 * @param {{token: string|null, send: (text: string) => void}[]} targets  open sockets
 * @param {object|null} self  the target that sent the triggering message
 */
export function routeMessages(room, out, targets, self) {
    for (const { to, msg } of out) {
        for (const t of targets) {
            if (to === "self" && t !== self) continue;
            if (to === "others" && t === self) continue;
            if (to !== "self" && !t.token) continue; // not joined yet
            try {
                t.send(JSON.stringify(room.personalize(msg, t.token)));
            } catch {
                /* socket went away mid-send */
            }
        }
    }
}

export class RoomCore {
    constructor(saved, opts = {}) {
        this.now = opts.now || (() => Date.now());
        this.makeToken = opts.makeToken || defaultToken;
        this.random = opts.random || Math.random;
        this.state = saved && saved.v === 1 ? saved : createInitialState(opts);
        this._upgrade();
    }

    /** Fills fields added after Milestone A, so rooms saved by older code keep working. */
    _upgrade() {
        const s = this.state;
        if (!s.nextPid) s.nextPid = 1;
        for (const tok of Object.keys(s.players)) {
            if (!s.players[tok].pid) s.players[tok].pid = `p${s.nextPid++}`;
        }
        if (!s.game) s.game = {};
        if ("passage" in s) {
            if (s.game.currentPassage === undefined) s.game.currentPassage = s.passage;
            delete s.passage;
        }
        if ("passageSeq" in s) {
            if (s.game.passageSeq === undefined) s.game.passageSeq = s.passageSeq;
            delete s.passageSeq;
        }
        if (s.game.currentPassage === undefined) s.game.currentPassage = LOBBY_PASSAGE;
        if (s.game.passageSeq === undefined) s.game.passageSeq = 0;
        if (!s.timer) {
            s.timer = newTimer();
            delete s.startedAt;
            delete s.endedAt;
        }
        if (!s.once) s.once = {};
        if (!s.attempt) s.attempt = 1;
        if (s.lost === undefined) s.lost = false;
        if (!s.reported) s.reported = {};
    }

    get passageSeq() {
        return num(this.state.game.passageSeq, 0);
    }

    /** What a client sees: everything except tokens. */
    snapshot(connectedTokens = new Set()) {
        const s = this.state;
        const roles = {};
        for (const r of ROLES) {
            const tok = s.roles[r];
            roles[r] = tok
                ? { name: (s.players[tok] && s.players[tok].name) || "", connected: connectedTokens.has(tok) }
                : null;
        }
        const players = Object.keys(s.players)
            .map((tok) => ({
                pid: s.players[tok].pid,
                role: s.players[tok].role,
                name: s.players[tok].name,
                connected: connectedTokens.has(tok),
            }))
            .sort((a, b) => pidNumber(a.pid) - pidNumber(b.pid));
        return {
            sessionCode: s.sessionCode,
            pairCode: s.pairCode,
            seq: s.seq,
            passage: s.game.currentPassage,
            passageSeq: this.passageSeq,
            attempt: s.attempt,
            timer: { ...s.timer },
            roles,
            players,
            game: { ...s.game },
        };
    }

    handle(conn, msg, connectedTokens = new Set()) {
        const before = { passage: this.state.game.currentPassage, attempt: this.state.attempt };
        const res = this._dispatch(conn, msg, connectedTokens);
        res.events = [];
        if (!res.dirty) return res;
        const tokens = new Set(connectedTokens);
        if (conn && conn.token) tokens.add(conn.token);
        const s = this.state;
        if (msg.t === "navigate" && s.game.currentPassage !== before.passage) {
            if (String(s.game.currentPassage).startsWith("Game_Over")) s.lost = true;
            if (s.game.currentPassage === RESULT_PASSAGE && !s.reported[s.attempt]) {
                s.reported[s.attempt] = true;
                res.events.push({ type: "result", result: this.result() });
            }
        }
        if (["hello", "navigate", "claimRole", "name", "reset"].includes(msg.t)) {
            res.events.push({ type: "progress", progress: this.progress(tokens) });
        }
        return res;
    }

    /** Official result for the current attempt, built from server state (clients can't send scores). */
    result() {
        const s = this.state;
        const g = s.game;
        const energy = num(g.Energy, 0);
        const inhaler = num(g.Inhaler, 0);
        return {
            pair: s.pairCode,
            attempt: s.attempt,
            patientName: this._nameFor("patient"),
            observerName: this._nameFor("observer"),
            points: num(g.Points, 0),
            energy,
            elapsedMs: timerElapsed(s.timer, this.now()),
            hasMeds: g.hasMedications === true,
            hasToy: g.hasToy === true,
            win: !s.lost && energy > 0 && inhaler < 7,
            finishedAt: this.now(),
        };
    }

    /** Live status for the instructor's board. */
    progress(connectedTokens = new Set()) {
        const s = this.state;
        const g = s.game;
        const passage = g.currentPassage;
        let status = "playing";
        if (LOBBY.includes(passage)) status = "waiting";
        else if (passage === RESULT_PASSAGE || s.reported[s.attempt]) status = "finished";
        return {
            pair: s.pairCode,
            attempt: s.attempt,
            status,
            passage,
            points: num(g.Points, 0),
            energy: num(g.Energy, 10),
            elapsedMs: timerElapsed(s.timer, this.now()),
            patientName: this._nameFor("patient"),
            observerName: this._nameFor("observer"),
            patientConnected: !!s.roles.patient && connectedTokens.has(s.roles.patient),
            observerConnected: !!s.roles.observer && connectedTokens.has(s.roles.observer),
            updatedAt: this.now(),
        };
    }

    _nameFor(role) {
        const tok = this.state.roles[role];
        return (tok && this.state.players[tok] && this.state.players[tok].name) || "";
    }

    _dispatch(conn, msg, connectedTokens) {
        if (!msg || typeof msg.t !== "string") {
            return this._reject(conn, "bad_message", connectedTokens, msg);
        }
        if (msg.t === "ping") {
            return { out: [{ to: "self", msg: { t: "pong", serverNow: this.now(), id: msg.id } }], dirty: false };
        }
        if (msg.t === "hello") return this._hello(conn, msg, connectedTokens);
        if (!conn.token || !this.state.players[conn.token]) {
            return this._reject(conn, "not_joined", connectedTokens, msg);
        }
        switch (msg.t) {
            case "sync":
                return { out: [{ to: "self", msg: this._stateMsg(connectedTokens) }], dirty: false };
            case "claimRole":
                return this._claimRole(conn, msg, connectedTokens);
            case "name":
                return this._name(conn, msg, connectedTokens);
            case "set":
                return this._set(conn, msg, connectedTokens);
            case "inc":
                return this._inc(conn, msg, connectedTokens);
            case "navigate":
                return this._navigate(conn, msg, connectedTokens);
            case "roll":
                return this._roll(conn, msg, connectedTokens);
            case "op":
                return this._op(conn, msg, connectedTokens);
            case "timer":
                return this._timer(conn, msg, connectedTokens);
            case "reset":
                return this._reset(conn, msg, connectedTokens);
            default:
                return this._reject(conn, "unknown_type", connectedTokens, msg);
        }
    }

    /** This player's own id, role and name, added to each outgoing message for that socket. */
    you(token) {
        const p = token && this.state.players[token];
        return p ? { pid: p.pid, role: p.role, name: p.name } : null;
    }

    /** Returns a copy of msg with `you` (and `ack` for the sender) filled in for `token`. */
    personalize(msg, token) {
        if (msg.t !== "state" && msg.t !== "reject") return msg;
        const { ackToken, ack, ...rest } = msg;
        const copy = { ...rest, you: this.you(token) };
        if (ack !== undefined && ackToken === token) copy.ack = ack;
        return copy;
    }

    /** Call when a socket closes, so the partner (and the class board) learn about it. */
    presenceChanged(connectedTokens) {
        return {
            out: [{ to: "all", msg: this._stateMsg(connectedTokens) }],
            dirty: false,
            events: [{ type: "progress", progress: this.progress(connectedTokens) }],
        };
    }

    _hello(conn, msg, connectedTokens) {
        const s = this.state;
        let token = typeof msg.token === "string" ? msg.token : null;
        if (!token || !s.players[token]) {
            if (Object.keys(s.players).length >= MAX_PLAYERS) {
                /*
                 * Pair is full. A student who switched device/browser (or lost site data) can
                 * take back a seat whose owner is offline: { takeover: true }. They inherit that
                 * seat's id, role and nickname; the old device's token stops working.
                 */
                const offline = msg.takeover
                    ? Object.keys(s.players).filter((t) => !connectedTokens.has(t))
                    : [];
                if (!offline.length) {
                    return this._reject(conn, "room_full", connectedTokens, msg);
                }
                const old = offline.sort((a, b) => pidNumber(s.players[a].pid) - pidNumber(s.players[b].pid))[0];
                token = this.makeToken();
                s.players[token] = s.players[old];
                delete s.players[old];
                for (const r of ROLES) {
                    if (s.roles[r] === old) s.roles[r] = token;
                }
            } else {
                token = this.makeToken();
                s.players[token] = { pid: `p${s.nextPid++}`, role: null, name: "" };
            }
        }
        conn.token = token;
        if (msg.name !== undefined) s.players[token].name = cleanName(msg.name);
        s.seq += 1;
        const tokens = new Set(connectedTokens);
        tokens.add(token);
        return {
            out: [
                {
                    to: "self",
                    msg: {
                        t: "welcome",
                        token,
                        you: this.you(token),
                        snapshot: this.snapshot(tokens),
                        seq: s.seq,
                        serverNow: this.now(),
                    },
                },
                { to: "others", msg: this._stateMsg(tokens) },
            ],
            dirty: true,
        };
    }

    _claimRole(conn, msg, connectedTokens) {
        const s = this.state;
        const role = msg.role;
        const token = conn.token;
        if (role !== null && !ROLES.includes(role)) {
            return this._reject(conn, "bad_role", connectedTokens, msg);
        }
        if (role && s.roles[role] && s.roles[role] !== token) {
            return this._reject(conn, "role_taken", connectedTokens, msg);
        }
        const prev = s.players[token].role;
        if (prev && s.roles[prev] === token) s.roles[prev] = null;
        s.players[token].role = role;
        if (role) s.roles[role] = token;
        if (msg.name !== undefined) s.players[token].name = cleanName(msg.name);
        s.seq += 1;
        return this._broadcastState(connectedTokens, conn, msg);
    }

    /** { t:"name", name } — optional nickname shown on the instructor leaderboard. */
    _name(conn, msg, connectedTokens) {
        this.state.players[conn.token].name = cleanName(msg.name);
        this.state.seq += 1;
        return this._broadcastState(connectedTokens, conn, msg);
    }

    _set(conn, msg, connectedTokens) {
        if (!validPatch(msg.patch)) {
            return this._reject(conn, "bad_patch", connectedTokens, msg);
        }
        Object.assign(this.state.game, msg.patch);
        this.state.seq += 1;
        return this._broadcastState(connectedTokens, conn, msg);
    }

    /**
     * Atomic add on the server: { t:"inc", key, by, min?, max? }.
     * Use for Points/Energy/behavior counters so two quick clicks can't overwrite each other
     * (a client-side "read, add 1, set" loses updates when both devices act at once).
     */
    _inc(conn, msg, connectedTokens) {
        const { key, by } = msg;
        if (!validKey(key) || typeof by !== "number" || !Number.isFinite(by)) {
            return this._reject(conn, "bad_patch", connectedTokens, msg);
        }
        let next = num(this.state.game[key], 0) + by;
        if (typeof msg.min === "number") next = Math.max(msg.min, next);
        if (typeof msg.max === "number") next = Math.min(msg.max, next);
        this.state.game[key] = next;
        this.state.seq += 1;
        return this._broadcastState(connectedTokens, conn, msg);
    }

    /**
     * { t:"navigate", passage, expectSeq, timer?, patch? }
     * Moves the room only if passageSeq still equals expectSeq, so two devices can't both
     * advance it. A loser gets "stale_seq" plus the current snapshot and follows the room.
     * `timer` ("run" | "pause" | "stop" | "none") updates the room clock for the new passage.
     * `patch` (optional) is applied in the same step, e.g. { evalComplete: false }.
     */
    _navigate(conn, msg, connectedTokens) {
        const s = this.state;
        if (typeof msg.passage !== "string" || !PASSAGE_RE.test(msg.passage)) {
            return this._reject(conn, "bad_passage", connectedTokens, msg);
        }
        if (msg.patch !== undefined && !validPatch(msg.patch)) {
            return this._reject(conn, "bad_patch", connectedTokens, msg);
        }
        if (msg.timer !== undefined && !TIMER_MODES.includes(msg.timer)) {
            return this._reject(conn, "bad_timer", connectedTokens, msg);
        }
        if (msg.expectSeq !== this.passageSeq) {
            // Someone else moved first (or this client is stale): send the truth back.
            return this._reject(conn, "stale_seq", connectedTokens, msg);
        }
        if (msg.patch) Object.assign(s.game, msg.patch);
        s.game.currentPassage = msg.passage;
        s.game.passageSeq = this.passageSeq + 1;
        this._applyTimerMode(msg.timer || "none");
        s.seq += 1;
        return this._broadcastState(connectedTokens, conn, msg);
    }

    _applyTimerMode(mode) {
        const t = this.state.timer;
        const now = this.now();
        if (mode === "none") return;
        if (mode === "stop") {
            if (t.startedAt !== null && t.stoppedAt === null) t.stoppedAt = t.pausedAt ?? now;
            return;
        }
        if (t.stoppedAt !== null) return; // stays stopped until reset
        if (mode === "run") {
            if (t.startedAt === null) t.startedAt = now;
            if (t.pausedAt !== null) {
                t.pausedMs += now - t.pausedAt;
                t.pausedAt = null;
            }
        } else if (mode === "pause") {
            if (t.startedAt !== null && t.pausedAt === null) t.pausedAt = now;
        }
    }

    /**
     * { t:"roll", key, sides } — one shared dice roll per key per passage.
     * Both devices call this when a router passage renders; the first call rolls,
     * the second gets the same number. game[key] = 1..sides.
     */
    _roll(conn, msg, connectedTokens) {
        const { key, sides } = msg;
        if (!validKey(key) || !Number.isInteger(sides) || sides < 2 || sides > 20) {
            return this._reject(conn, "bad_roll", connectedTokens, msg);
        }
        const s = this.state;
        if (s.once[`roll:${key}`] !== this.passageSeq || s.game[key] === undefined) {
            s.game[key] = 1 + Math.floor(this.random() * sides);
            s.once[`roll:${key}`] = this.passageSeq;
        }
        s.seq += 1;
        return this._broadcastState(connectedTokens, conn, msg);
    }

    /**
     * { t:"op", name } — named calculations that must happen once per passage even though
     * both devices render it.
     *   errandsDrain: Energy -= errandsRun², clamped to 0..15 (Whistle_Stop_In)
     */
    _op(conn, msg, connectedTokens) {
        const s = this.state;
        if (msg.name !== "errandsDrain") {
            return this._reject(conn, "bad_op", connectedTokens, msg);
        }
        const guard = `op:${msg.name}`;
        if (s.once[guard] !== this.passageSeq) {
            const errands = num(s.game.errandsRun, 0);
            const energy = num(s.game.Energy, 10) - errands * errands;
            s.game.Energy = Math.min(15, Math.max(0, energy));
            s.once[guard] = this.passageSeq;
        }
        s.seq += 1;
        return this._broadcastState(connectedTokens, conn, msg);
    }

    /** { t:"timer", action:"reset" } — clock back to 0:00 and running (start of the real simulation). */
    _timer(conn, msg, connectedTokens) {
        if (msg.action !== "reset") {
            return this._reject(conn, "bad_timer", connectedTokens, msg);
        }
        this.state.timer = newTimer();
        this.state.timer.startedAt = this.now();
        this.state.seq += 1;
        return this._broadcastState(connectedTokens, conn, msg);
    }

    /**
     * { t:"reset", fromAttempt, game, passage } — Try Again.
     * Starts attempt fromAttempt+1 with the given default stats and sends the room to
     * `passage`. If the partner already pressed Try Again (attempt moved on), this is
     * refused with the current snapshot and the client simply follows.
     */
    _reset(conn, msg, connectedTokens) {
        const s = this.state;
        if (msg.fromAttempt !== s.attempt) {
            return this._reject(conn, "stale_attempt", connectedTokens, msg);
        }
        if (!validPatch(msg.game) || typeof msg.passage !== "string" || !PASSAGE_RE.test(msg.passage)) {
            return this._reject(conn, "bad_reset", connectedTokens, msg);
        }
        Object.assign(s.game, msg.game);
        s.game.currentPassage = msg.passage;
        s.game.passageSeq = this.passageSeq + 1;
        s.attempt += 1;
        s.once = {};
        s.lost = false;
        s.timer = newTimer();
        s.timer.startedAt = this.now();
        s.seq += 1;
        return this._broadcastState(connectedTokens, conn, msg);
    }

    _stateMsg(connectedTokens) {
        return { t: "state", seq: this.state.seq, snapshot: this.snapshot(connectedTokens), serverNow: this.now() };
    }

    _broadcastState(connectedTokens, conn, msg) {
        const tokens = new Set(connectedTokens);
        if (conn && conn.token) tokens.add(conn.token);
        const out = this._stateMsg(tokens);
        if (msg && msg.cid !== undefined && conn && conn.token) {
            out.ackToken = conn.token;
            out.ack = msg.cid;
        }
        return { out: [{ to: "all", msg: out }], dirty: true };
    }

    _reject(conn, reason, connectedTokens, msg) {
        const tokens = new Set(connectedTokens);
        if (conn && conn.token) tokens.add(conn.token);
        const out = { t: "reject", reason, seq: this.state.seq, snapshot: this.snapshot(tokens), serverNow: this.now() };
        if (msg && msg.cid !== undefined && conn && conn.token) {
            out.ackToken = conn.token;
            out.ack = msg.cid;
        }
        return { out: [{ to: "self", msg: out }], dirty: false };
    }
}

function defaultToken() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
