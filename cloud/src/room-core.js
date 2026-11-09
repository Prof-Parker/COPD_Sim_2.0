/**
 * room-core.js — the pair-room rules, with no Cloudflare APIs.
 *
 * The PairRoom Durable Object (pair-room.js) is a thin wrapper around this module,
 * and the Node tests drive it directly. Keep it pure: no I/O, no globals.
 *
 * Usage:
 *   const room = new RoomCore(savedStateOrNull, { sessionCode, pairCode, now, makeToken });
 *   const { out, dirty } = room.handle(conn, message, connectedTokens);
 *     conn            — mutable per-socket object; room-core sets conn.token after "hello"
 *     message         — parsed JSON from the client
 *     connectedTokens — Set of tokens with an open socket (for presence)
 *     out             — [{ to: "self" | "all" | "others", msg }]
 *     dirty           — true when room.state changed and must be saved
 */

export const ROLES = ["patient", "observer"];
export const LOBBY_PASSAGE = "Role_Selection";
const MAX_PLAYERS = 2;
const MAX_NAME_LEN = 20;
const MAX_KEY_LEN = 40;
const MAX_PATCH_KEYS = 50;
const MAX_STRING_LEN = 500;

export function createInitialState({ sessionCode, pairCode }) {
    return {
        v: 1,
        sessionCode: sessionCode || "",
        pairCode: pairCode || "",
        seq: 0, // increases on every accepted change
        passage: LOBBY_PASSAGE,
        passageSeq: 0,
        attempt: 1,
        startedAt: null,
        endedAt: null,
        players: {}, // token -> { role, name }
        roles: { patient: null, observer: null }, // role -> token
        game: {},
    };
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

export class RoomCore {
    constructor(saved, opts = {}) {
        this.now = opts.now || (() => Date.now());
        this.makeToken = opts.makeToken || defaultToken;
        this.state = saved && saved.v === 1 ? saved : createInitialState(opts);
    }

    /** What a client sees: everything except other players' tokens. */
    snapshot(connectedTokens = new Set()) {
        const s = this.state;
        const roles = {};
        for (const r of ROLES) {
            const tok = s.roles[r];
            roles[r] = tok
                ? { name: (s.players[tok] && s.players[tok].name) || "", connected: connectedTokens.has(tok) }
                : null;
        }
        return {
            sessionCode: s.sessionCode,
            pairCode: s.pairCode,
            seq: s.seq,
            passage: s.passage,
            passageSeq: s.passageSeq,
            attempt: s.attempt,
            startedAt: s.startedAt,
            endedAt: s.endedAt,
            roles,
            game: { ...s.game },
        };
    }

    handle(conn, msg, connectedTokens = new Set()) {
        if (!msg || typeof msg.t !== "string") {
            return this._reject(conn, "bad_message", connectedTokens);
        }
        if (msg.t === "ping") {
            return { out: [{ to: "self", msg: { t: "pong", serverNow: this.now(), id: msg.id } }], dirty: false };
        }
        if (msg.t === "hello") return this._hello(conn, msg, connectedTokens);
        if (!conn.token || !this.state.players[conn.token]) {
            return this._reject(conn, "not_joined", connectedTokens);
        }
        switch (msg.t) {
            case "sync":
                return { out: [{ to: "self", msg: this._stateMsg(connectedTokens) }], dirty: false };
            case "claimRole":
                return this._claimRole(conn, msg, connectedTokens);
            case "set":
                return this._set(conn, msg, connectedTokens);
            case "inc":
                return this._inc(conn, msg, connectedTokens);
            case "navigate":
                return this._navigate(conn, msg, connectedTokens);
            default:
                return this._reject(conn, "unknown_type", connectedTokens);
        }
    }

    /** This player's own role and name, added to each outgoing message for that socket. */
    you(token) {
        const p = token && this.state.players[token];
        return p ? { role: p.role, name: p.name } : null;
    }

    /** Returns a copy of msg with `you` filled in for the socket that owns `token`. */
    personalize(msg, token) {
        if (msg.t === "state" || msg.t === "reject") return { ...msg, you: this.you(token) };
        return msg;
    }

    /** Call when a socket closes, so the partner learns about it. */
    presenceChanged(connectedTokens) {
        return { out: [{ to: "all", msg: this._stateMsg(connectedTokens) }], dirty: false };
    }

    _hello(conn, msg, connectedTokens) {
        const s = this.state;
        let token = typeof msg.token === "string" ? msg.token : null;
        if (!token || !s.players[token]) {
            if (Object.keys(s.players).length >= MAX_PLAYERS) {
                return this._reject(conn, "room_full", connectedTokens);
            }
            token = this.makeToken();
            s.players[token] = { role: null, name: "" };
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
                        you: { role: s.players[token].role, name: s.players[token].name },
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
            return this._reject(conn, "bad_role", connectedTokens);
        }
        if (role && s.roles[role] && s.roles[role] !== token) {
            return this._reject(conn, "role_taken", connectedTokens);
        }
        const prev = s.players[token].role;
        if (prev && s.roles[prev] === token) s.roles[prev] = null;
        s.players[token].role = role;
        if (role) s.roles[role] = token;
        if (msg.name !== undefined) s.players[token].name = cleanName(msg.name);
        s.seq += 1;
        return this._broadcastState(connectedTokens, conn);
    }

    _set(conn, msg, connectedTokens) {
        const patch = msg.patch;
        if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
            return this._reject(conn, "bad_patch", connectedTokens);
        }
        const keys = Object.keys(patch);
        if (keys.length === 0 || keys.length > MAX_PATCH_KEYS) {
            return this._reject(conn, "bad_patch", connectedTokens);
        }
        for (const k of keys) {
            if (k.length > MAX_KEY_LEN || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || !isPlainValue(patch[k])) {
                return this._reject(conn, "bad_patch", connectedTokens);
            }
        }
        Object.assign(this.state.game, patch);
        this.state.seq += 1;
        return this._broadcastState(connectedTokens, conn);
    }

    /**
     * Atomic add on the server: { t:"inc", key, by, min?, max? }.
     * Use for Points/Energy/behavior counters so two quick clicks can't overwrite each other
     * (a client-side "read, add 1, set" loses updates when both devices act at once).
     */
    _inc(conn, msg, connectedTokens) {
        const { key, by } = msg;
        if (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key.length > MAX_KEY_LEN) {
            return this._reject(conn, "bad_patch", connectedTokens);
        }
        if (typeof by !== "number" || !Number.isFinite(by)) {
            return this._reject(conn, "bad_patch", connectedTokens);
        }
        const cur = Number(this.state.game[key]);
        let next = (Number.isFinite(cur) ? cur : 0) + by;
        if (typeof msg.min === "number") next = Math.max(msg.min, next);
        if (typeof msg.max === "number") next = Math.min(msg.max, next);
        this.state.game[key] = next;
        this.state.seq += 1;
        return this._broadcastState(connectedTokens, conn);
    }

    _navigate(conn, msg, connectedTokens) {
        const s = this.state;
        if (typeof msg.passage !== "string" || !msg.passage || msg.passage.length > 80) {
            return this._reject(conn, "bad_passage", connectedTokens);
        }
        if (msg.expectSeq !== s.passageSeq) {
            // Someone else moved first (or this client is stale): send the truth back.
            return this._reject(conn, "stale_seq", connectedTokens);
        }
        s.passage = msg.passage;
        s.passageSeq += 1;
        s.seq += 1;
        return this._broadcastState(connectedTokens, conn);
    }

    _stateMsg(connectedTokens) {
        return { t: "state", seq: this.state.seq, snapshot: this.snapshot(connectedTokens), serverNow: this.now() };
    }

    _broadcastState(connectedTokens, conn) {
        const tokens = new Set(connectedTokens);
        if (conn && conn.token) tokens.add(conn.token);
        return { out: [{ to: "all", msg: this._stateMsg(tokens) }], dirty: true };
    }

    _reject(conn, reason, connectedTokens) {
        const tokens = new Set(connectedTokens);
        if (conn && conn.token) tokens.add(conn.token);
        return {
            out: [{ to: "self", msg: { t: "reject", reason, seq: this.state.seq, snapshot: this.snapshot(tokens) } }],
            dirty: false,
        };
    }
}

function defaultToken() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
