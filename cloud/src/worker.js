/**
 * worker.js — entry point. Static files (the game, Media, test pages) are served by
 * Cloudflare's asset handling before this runs; this only sees the routes below.
 *
 *   GET /ws/room?s=<session>&p=<pair>   WebSocket → PairRoom Durable Object "<session>:<pair>"
 */
export { PairRoom } from "./pair-room.js";

const SESSION_RE = /^[A-Z0-9][A-Z0-9-]{2,23}$/;
const PAIR_RE = /^[A-Z0-9]{1,6}$/;

export function normalizeCode(value) {
    return String(value || "").trim().toUpperCase();
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === "/ws/room") {
            const s = normalizeCode(url.searchParams.get("s"));
            const p = normalizeCode(url.searchParams.get("p"));
            if (!SESSION_RE.test(s) || !PAIR_RE.test(p)) {
                return new Response("Invalid session or pair code", { status: 400 });
            }
            if (request.headers.get("Upgrade") !== "websocket") {
                return new Response("Expected WebSocket", { status: 426 });
            }
            const id = env.PAIR_ROOM.idFromName(`${s}:${p}`);
            const fwd = new URL(request.url);
            fwd.searchParams.set("s", s);
            fwd.searchParams.set("p", p);
            return env.PAIR_ROOM.get(id).fetch(new Request(fwd, request));
        }

        return new Response("Not found", { status: 404 });
    },
};
