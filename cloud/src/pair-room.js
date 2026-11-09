/**
 * pair-room.js — Durable Object for one patient/observer pair.
 *
 * Thin wrapper: WebSockets (hibernation API) + storage. All game rules live in room-core.js.
 * One object exists per "<session>:<pair>" name; Cloudflare runs it only while sockets are active.
 */
import { DurableObject } from "cloudflare:workers";
import { RoomCore, routeMessages } from "./room-core.js";

const STATE_KEY = "state";

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
