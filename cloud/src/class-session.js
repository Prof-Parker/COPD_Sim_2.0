/**
 * class-session.js — Durable Object for one class session (named by its session code).
 *
 * - Pair rooms call canJoin / progress / result over Durable Object RPC.
 * - The instructor page connects with a WebSocket (/ws/class?s=CODE), sends { t:"auth", pin },
 *   and then receives { t:"board", board } every time something changes.
 * - Results are also written to D1 (permanent copy for history and CSV export).
 * - An alarm deletes this session's live data after RETENTION_DAYS.
 */
import { DurableObject } from "cloudflare:workers";
import { canJoin, applyProgress, applyResult, board, newSession, toCsv } from "./class-core.js";
import { pinMatches } from "./auth.js";

const KEY = "session";
export const RETENTION_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

export class ClassSession extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.session = null;
        ctx.blockConcurrencyWhile(async () => {
            this.session = (await ctx.storage.get(KEY)) || null;
        });
    }

    async save() {
        await this.ctx.storage.put(KEY, this.session);
    }

    /* ---------------- instructor actions (called by the Worker after the PIN check) ---------------- */

    async create({ code, course }) {
        if (this.session) return { ok: false, reason: "exists" };
        const now = Date.now();
        this.session = newSession({ code, course, now });
        await this.save();
        await this.ctx.storage.setAlarm(now + RETENTION_DAYS * DAY_MS);
        await this.d1(
            "INSERT OR IGNORE INTO sessions (code, course, created_at, closed_at) VALUES (?, ?, ?, NULL)",
            code, this.session.course, now
        );
        return { ok: true, board: board(this.session) };
    }

    async close() {
        if (!this.session) return { ok: false, reason: "no_session" };
        if (!this.session.closedAt) {
            this.session.closedAt = Date.now();
            await this.save();
            await this.d1("UPDATE sessions SET closed_at = ? WHERE code = ?", this.session.closedAt, this.session.code);
            this.broadcast();
        }
        return { ok: true, board: board(this.session) };
    }

    async reopen() {
        if (!this.session) return { ok: false, reason: "no_session" };
        this.session.closedAt = null;
        await this.save();
        await this.d1("UPDATE sessions SET closed_at = NULL WHERE code = ?", this.session.code);
        this.broadcast();
        return { ok: true, board: board(this.session) };
    }

    /**
     * Deletes everything about this session: live board, D1 rows and every pair room in it.
     * Students still connected are disconnected and told the session is gone; the code can be
     * created again afterwards. Works even when only the D1 rows are left (e.g. after retention).
     */
    async remove(code) {
        const existed = !!this.session;
        const pairs = this.session ? Object.keys(this.session.pairs) : [];
        // Forget the session first so no new pair can register while the rest is cleaned up.
        this.session = null;
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();

        for (const ws of this.ctx.getWebSockets()) {
            try {
                ws.send(JSON.stringify({ t: "error", reason: "deleted" }));
                ws.close(4004, "deleted");
            } catch {
                /* already gone */
            }
        }

        let roomsWiped = 0;
        if (this.env.PAIR_ROOM) {
            const wipes = pairs.map((pair) =>
                this.env.PAIR_ROOM.get(this.env.PAIR_ROOM.idFromName(`${code}:${pair}`))
                    .wipe()
                    .then(() => { roomsWiped += 1; })
                    .catch((e) => console.error(`wipe ${code}:${pair} failed:`, e && e.message))
            );
            await Promise.all(wipes);
        }

        await this.d1("DELETE FROM results WHERE session_code = ?", code);
        await this.d1("DELETE FROM sessions WHERE code = ?", code);
        return { ok: true, existed, pairs: pairs.length, roomsWiped };
    }

    /**
     * Removes one team from the session (e.g. a student scanned the class QR twice and made a
     * stray one-player team): its row, its results and its pair room. Players still connected
     * to it are sent back to the session-code box.
     */
    async removePair(pair) {
        if (!this.session) return { ok: false, reason: "no_session" };
        if (!this.session.pairs[pair]) return { ok: false, reason: "no_pair" };
        const code = this.session.code;
        delete this.session.pairs[pair];
        this.session.results = this.session.results.filter((r) => r.pair !== pair);
        await this.save();
        if (this.env.PAIR_ROOM) {
            try {
                await this.env.PAIR_ROOM.get(this.env.PAIR_ROOM.idFromName(`${code}:${pair}`)).wipe();
            } catch (e) {
                console.error(`wipe ${code}:${pair} failed:`, e && e.message);
            }
        }
        await this.d1("DELETE FROM results WHERE session_code = ? AND pair_code = ?", code, pair);
        this.broadcast();
        return { ok: true };
    }

    async hasPair(pair) {
        return !!(this.session && this.session.pairs[pair]);
    }

    async getBoard() {
        return board(this.session);
    }

    async csv() {
        return this.session ? toCsv(this.session) : null;
    }

    /* ---------------- calls from pair rooms ---------------- */

    async canJoin(pair) {
        const res = canJoin(this.session, pair, Date.now());
        if (res.dirty) {
            await this.save();
            this.broadcast();
        }
        return { ok: res.ok, reason: res.reason, teamName: res.teamName };
    }

    async progress(p) {
        if (applyProgress(this.session, p)) {
            await this.save();
            this.broadcast();
        }
    }

    async result(r) {
        if (!applyResult(this.session, r)) return;
        await this.save();
        const pair = this.session.pairs[r.pair];
        const teamName = (pair && pair.teamName) || r.teamName || "";
        await this.d1(
            `INSERT OR REPLACE INTO results
               (session_code, pair_code, attempt, team_name, patient_name, observer_name, points, energy,
                elapsed_ms, has_meds, has_toy, win, finished_at)
             VALUES (?, ?, ?, ?, '', '', ?, ?, ?, ?, ?, ?, ?)`,
            this.session.code, r.pair, r.attempt, teamName, r.points, r.energy,
            r.elapsedMs, r.hasMeds ? 1 : 0, r.hasToy ? 1 : 0, r.win ? 1 : 0, r.finishedAt
        );
        this.broadcast();
    }

    /** Retention: forget this session's live data a year after it was created. */
    async alarm() {
        this.session = null;
        await this.ctx.storage.deleteAll();
    }

    /* ---------------- instructor WebSocket ---------------- */

    async fetch(request) {
        if (request.headers.get("Upgrade") !== "websocket") {
            return new Response("Expected WebSocket", { status: 426 });
        }
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({ authed: false });
        return new Response(null, { status: 101, webSocket: client });
    }

    async webSocketMessage(ws, raw) {
        let msg = null;
        try {
            msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
        } catch {
            /* ignore */
        }
        if (!msg || msg.t !== "auth") return;
        if (!pinMatches(msg.pin, this.env.ADMIN_PIN)) {
            ws.send(JSON.stringify({ t: "error", reason: "bad_pin" }));
            ws.close(4001, "bad pin");
            return;
        }
        if (!this.session) {
            ws.send(JSON.stringify({ t: "error", reason: "no_session" }));
            ws.close(4004, "no session");
            return;
        }
        ws.serializeAttachment({ authed: true });
        ws.send(JSON.stringify({ t: "board", board: board(this.session) }));
    }

    async webSocketClose(ws) {
        try {
            ws.close(1000, "closed");
        } catch {
            /* already closed */
        }
    }

    broadcast() {
        const text = JSON.stringify({ t: "board", board: board(this.session) });
        for (const ws of this.ctx.getWebSockets()) {
            const a = ws.deserializeAttachment() || {};
            if (!a.authed) continue;
            try {
                ws.send(text);
            } catch {
                /* socket went away */
            }
        }
    }

    /** Runs a D1 statement; logs instead of failing the game if D1 is unavailable. */
    async d1(sql, ...args) {
        if (!this.env.DB) return;
        try {
            await this.env.DB.prepare(sql).bind(...args).run();
        } catch (e) {
            console.error("D1 write failed:", e && e.message);
        }
    }
}
