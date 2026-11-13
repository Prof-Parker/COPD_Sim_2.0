/**
 * pair-room.js — Durable Object for one patient/observer pair.
 *
 * Thin wrapper: WebSockets (hibernation API) + storage. All game rules live in room-core.js.
 * One object exists per "<session>:<pair>" name; Cloudflare runs it only while sockets are active.
 *
 * Class sessions (Milestone D):
 * - A NEW seat may only join if the instructor's session exists and (for a new pair) is open:
 *   the ClassSession object answers canJoin(pair). Refusals reach the client as
 *   { t:"reject", reason:"no_session" | "session_closed" } before any welcome.
 * - Progress and the official end-of-attempt result are forwarded to the ClassSession.
 */
import { DurableObject } from "cloudflare:workers";
import { RoomCore, routeMessages } from "./room-core.js";

const STATE_KEY = "state";
/*
 * The client pings every ~25 s. A socket that has been silent for this long is treated as gone
 * when someone asks to take a seat back: phones that sleep or change network often leave a dead
 * connection that Cloudflare still reports as open ("zombie"), which used to block the takeover.
 */
const STALE_SOCKET_MS = 70 * 1000;

export class PairRoom extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.room = null;
        // Keepalive: the client sends the text "ping" every ~25 s; Cloudflare answers "pong"
        // without waking this object, so idle rooms stay asleep (and unbilled).
        ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
        ctx.blockConcurrencyWhile(async () => {
            const saved = await ctx.storage.get(STATE_KEY);
            this.room = new RoomCore(saved || null, {});
        });
    }

    async fetch(request) {
        if (request.headers.get("Upgrade") !== "websocket") {
            return new Response("Expected WebSocket", { status: 426 });
        }
        const url = new URL(request.url);
        // First connection names the room (state is created lazily without codes).
        if (!this.room.state.sessionCode) {
            this.room.state.sessionCode = url.searchParams.get("s");
            this.room.state.pairCode = url.searchParams.get("p");
        }
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({ token: null, at: Date.now() });
        return new Response(null, { status: 101, webSocket: client });
    }

    classSession() {
        if (!this.env.CLASS_SESSION || !this.room.state.sessionCode) return null;
        return this.env.CLASS_SESSION.get(this.env.CLASS_SESSION.idFromName(this.room.state.sessionCode));
    }

    async webSocketMessage(ws, raw) {
        let msg;
        try {
            msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
        } catch {
            msg = null;
        }

        // Gate new seats on the instructor's class session (and pick up the team name).
        const knownSeat = !!(msg && typeof msg.token === "string" && this.room.state.players[msg.token]);
        if (msg && msg.t === "hello" && (!knownSeat || !this.room.state.teamName)) {
            const gate = await this.checkSession();
            if (!gate.ok && !knownSeat) {
                ws.send(JSON.stringify({ t: "reject", reason: gate.reason }));
                ws.close(4003, gate.reason);
                return;
            }
            if (gate.ok && this.room.setTeamName(gate.teamName)) {
                await this.ctx.storage.put(STATE_KEY, this.room.state);
            }
        }

        const conn = ws.deserializeAttachment() || { token: null };
        const before = conn.token;
        // A takeover only counts sockets that are provably alive, so a zombie can't block it.
        const takeover = !!(msg && msg.t === "hello" && msg.takeover);
        const connected = this.connectedTokens(null, takeover);
        const { out, dirty, events, kicked } = this.room.handle(conn, msg, connected);
        if (conn.token !== before) ws.serializeAttachment({ ...conn, token: conn.token });
        if (dirty) await this.ctx.storage.put(STATE_KEY, this.room.state);
        if (kicked) this.closeToken(kicked, ws);
        this.deliver(ws, out);
        this.forward(events);
        if (msg && msg.t === "hello") {
            const refused = out.find((o) => o.msg && o.msg.t === "reject");
            // One line per join attempt in Workers Logs, to diagnose classroom reconnect problems.
            console.log(JSON.stringify({
                ev: refused ? "hello_refused" : kicked ? "seat_takeover" : knownSeat ? "rejoin" : "join",
                s: this.room.state.sessionCode, p: this.room.state.pairCode,
                reason: refused ? refused.msg.reason : undefined, takeover,
                players: Object.keys(this.room.state.players).length, sockets: this.ctx.getWebSockets().length,
            }));
        }
    }

    /** The seat moved to another device: tell any socket still using the old token, and close it. */
    closeToken(token, except) {
        for (const s of this.ctx.getWebSockets()) {
            if (s === except) continue;
            const a = s.deserializeAttachment();
            if (!a || a.token !== token) continue;
            try {
                s.send(JSON.stringify({ t: "reject", reason: "seat_taken" }));
                s.close(4005, "seat_taken");
            } catch {
                /* already gone */
            }
        }
    }

    /** Asks the ClassSession whether a new seat may join this pair. */
    async checkSession() {
        const stub = this.classSession();
        if (!stub) return { ok: true }; // no class sessions configured (e.g. older deploy)
        try {
            return await stub.canJoin(this.room.state.pairCode);
        } catch (e) {
            console.error("canJoin failed:", e && e.message);
            return { ok: false, reason: "session_unavailable" };
        }
    }

    /** Sends leaderboard events to the ClassSession without holding up the game. */
    forward(events) {
        if (!events || !events.length) return;
        const stub = this.classSession();
        if (!stub) return;
        for (const ev of events) {
            const call = ev.type === "result" ? stub.result(ev.result) : stub.progress(ev.progress);
            this.ctx.waitUntil(
                Promise.resolve(call).catch((e) => console.error(`ClassSession ${ev.type} failed:`, e && e.message))
            );
        }
    }

    /**
     * Called by ClassSession when the instructor deletes the session: tell connected players,
     * disconnect them and erase this room's stored state.
     */
    async wipe() {
        for (const s of this.ctx.getWebSockets()) {
            try {
                s.send(JSON.stringify({ t: "reject", reason: "session_deleted" }));
                s.close(4004, "session_deleted");
            } catch {
                /* already gone */
            }
        }
        await this.ctx.storage.deleteAll();
        this.room = new RoomCore(null, {});
    }

    async webSocketClose(ws) {
        this.afterSocketGone(ws);
    }

    async webSocketError(ws) {
        this.afterSocketGone(ws);
    }

    afterSocketGone(ws) {
        try {
            ws.close(1000, "closed");
        } catch {
            /* already closed */
        }
        const { out, events } = this.room.presenceChanged(this.connectedTokens(ws));
        this.deliver(ws, out.map((o) => ({ ...o, to: "others" })));
        // A refused or never-joined socket leaves an empty room: nothing to report.
        if (Object.keys(this.room.state.players).length) this.forward(events);
    }

    /**
     * Tokens with an open socket, ignoring `closing` (a socket that is going away).
     * With `freshOnly`, sockets that have neither connected nor pinged recently are left out.
     */
    connectedTokens(closing = null, freshOnly = false) {
        const set = new Set();
        const now = Date.now();
        for (const s of this.ctx.getWebSockets()) {
            if (s === closing) continue;
            const a = s.deserializeAttachment();
            if (!a || !a.token || s.readyState !== WebSocket.OPEN) continue;
            if (freshOnly) {
                const ping = this.ctx.getWebSocketAutoResponseTimestamp(s);
                const lastSeen = Math.max(a.at || 0, ping ? ping.getTime() : 0);
                if (now - lastSeen > STALE_SOCKET_MS) continue;
            }
            set.add(a.token);
        }
        return set;
    }

    /** Wraps open sockets as routeMessages() targets and sends `out`. */
    deliver(selfWs, out) {
        let self = null;
        const targets = [];
        for (const s of this.ctx.getWebSockets()) {
            if (s.readyState !== WebSocket.OPEN) continue;
            const a = s.deserializeAttachment() || {};
            const t = { token: a.token || null, send: (text) => s.send(text) };
            if (s === selfWs) self = t;
            targets.push(t);
        }
        routeMessages(this.room, out, targets, self);
    }
}
