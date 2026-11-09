/**
 * pair-room.js — Durable Object for one patient/observer pair.
 *
 * Thin wrapper: WebSockets (hibernation API) + storage. All game rules live in room-core.js.
 * One object exists per "<session>:<pair>" name; Cloudflare runs it only while sockets are active.
 */
import { DurableObject } from "cloudflare:workers";
import { RoomCore } from "./room-core.js";

const STATE_KEY = "state";

export class PairRoom extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.room = null;
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
        const sessionCode = url.searchParams.get("s");
        const pairCode = url.searchParams.get("p");
        // First connection names the room (state is created lazily without codes).
        if (!this.room.state.sessionCode) {
            this.room.state.sessionCode = sessionCode;
            this.room.state.pairCode = pairCode;
        }
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({ token: null });
        return new Response(null, { status: 101, webSocket: client });
    }

    async webSocketMessage(ws, raw) {
        let msg;
        try {
            msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
        } catch {
            msg = null;
        }
        const conn = ws.deserializeAttachment() || { token: null };
        const before = conn.token;
        const { out, dirty } = this.room.handle(conn, msg, this.connectedTokens());
        if (conn.token !== before) ws.serializeAttachment({ token: conn.token });
        if (dirty) await this.ctx.storage.put(STATE_KEY, this.room.state);
        this.deliver(ws, out);
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
        const { out } = this.room.presenceChanged(this.connectedTokens(ws));
        this.deliver(ws, out.map((o) => ({ ...o, to: "others" })));
    }

    /** Tokens with an open socket, ignoring `closing` (a socket that is going away). */
    connectedTokens(closing = null) {
        const set = new Set();
        for (const s of this.ctx.getWebSockets()) {
            if (s === closing) continue;
            const a = s.deserializeAttachment();
            if (a && a.token && s.readyState === WebSocket.OPEN) set.add(a.token);
        }
        return set;
    }

    deliver(self, out) {
        const sockets = this.ctx.getWebSockets();
        for (const { to, msg } of out) {
            for (const s of sockets) {
                if (s.readyState !== WebSocket.OPEN) continue;
                if (to === "self" && s !== self) continue;
                if (to === "others" && s === self) continue;
                const a = s.deserializeAttachment() || {};
                if (to !== "self" && !a.token) continue; // not joined yet
                try {
                    s.send(JSON.stringify(this.room.personalize(msg, a.token)));
                } catch {
                    /* socket went away mid-send */
                }
            }
        }
    }
}
