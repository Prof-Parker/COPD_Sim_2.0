/**
 * worker.js — entry point. Static files (the game, Media, class.html) are served by
 * Cloudflare's asset handling before this runs; this only sees the routes below.
 *
 * Students
 *   GET  /ws/room?s=<session>&p=<pair>      WebSocket → PairRoom "<session>:<pair>"
 *
 * Instructor (Authorization: Bearer <ADMIN_PIN>)
 *   GET  /api/sessions                      recent sessions (D1)
 *   POST /api/session   {code?, course?}    create a class session (random code if none)
 *   POST /api/session/<code>/close          stop new pairs joining
 *   POST /api/session/<code>/reopen
 *   DELETE /api/session/<code>              delete the session, its results and its pair rooms
 *   GET  /api/session/<code>/export.csv     every attempt, ranked
 *   GET  /ws/class?s=<code>                 live board WebSocket (PIN sent as first message)
 *
 * Cron: deletes D1 rows older than RETENTION_DAYS (wrangler.jsonc "triggers").
 */
export { PairRoom } from "./pair-room.js";
export { ClassSession } from "./class-session.js";
import { RETENTION_DAYS } from "./class-session.js";
import { SESSION_RE, newSessionCode, cleanCourse } from "./class-core.js";
import { pinMatches, pinFromRequest } from "./auth.js";

const PAIR_RE = /^[A-Z0-9]{1,6}$/;

export function normalizeCode(value) {
    return String(value || "").trim().toUpperCase();
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
}

function classStub(env, code) {
    return env.CLASS_SESSION.get(env.CLASS_SESSION.idFromName(code));
}

async function handleApi(request, env, url) {
    if (!pinMatches(pinFromRequest(request), env.ADMIN_PIN)) {
        await new Promise((r) => setTimeout(r, 750)); // slows down PIN guessing
        return json({ ok: false, reason: env.ADMIN_PIN ? "bad_pin" : "pin_not_configured" }, 401);
    }
    const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]

    if (request.method === "GET" && parts[1] === "sessions" && parts.length === 2) {
        if (!env.DB) return json({ ok: true, sessions: [] });
        const { results } = await env.DB.prepare(
            `SELECT s.code, s.course, s.created_at AS createdAt, s.closed_at AS closedAt,
                    (SELECT COUNT(*) FROM results r WHERE r.session_code = s.code) AS resultCount
               FROM sessions s ORDER BY s.created_at DESC LIMIT 50`
        ).all();
        return json({ ok: true, sessions: results });
    }

    if (request.method === "POST" && parts[1] === "session" && parts.length === 2) {
        let body = {};
        try {
            body = await request.json();
        } catch {
            /* empty body is fine */
        }
        const course = cleanCourse(body.course);
        if (body.code) {
            const code = normalizeCode(body.code);
            if (!SESSION_RE.test(code)) return json({ ok: false, reason: "bad_code" }, 400);
            const res = await classStub(env, code).create({ code, course });
            return json({ ...res, code }, res.ok ? 200 : 409);
        }
        for (let i = 0; i < 5; i++) {
            const code = newSessionCode();
            const res = await classStub(env, code).create({ code, course });
            if (res.ok) return json({ ...res, code });
        }
        return json({ ok: false, reason: "no_free_code" }, 500);
    }

    if (request.method === "DELETE" && parts[1] === "session" && parts.length === 3) {
        const code = normalizeCode(decodeURIComponent(parts[2]));
        if (!SESSION_RE.test(code)) return json({ ok: false, reason: "bad_code" }, 400);
        return json(await classStub(env, code).remove(code));
    }

    if (parts[1] === "session" && parts.length === 4) {
        const code = normalizeCode(decodeURIComponent(parts[2]));
        if (!SESSION_RE.test(code)) return json({ ok: false, reason: "bad_code" }, 400);
        const stub = classStub(env, code);
        if (request.method === "POST" && parts[3] === "close") return json(await stub.close());
        if (request.method === "POST" && parts[3] === "reopen") return json(await stub.reopen());
        if (request.method === "GET" && parts[3] === "export.csv") {
            const csv = await stub.csv();
            if (csv === null) return json({ ok: false, reason: "no_session" }, 404);
            return new Response(csv, {
                headers: {
                    "Content-Type": "text/csv; charset=utf-8",
                    "Content-Disposition": `attachment; filename="copd-sim-${code}.csv"`,
                    "Cache-Control": "no-store",
                },
            });
        }
    }
    return json({ ok: false, reason: "not_found" }, 404);
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

        if (url.pathname === "/ws/class") {
            const s = normalizeCode(url.searchParams.get("s"));
            if (!SESSION_RE.test(s)) return new Response("Invalid session code", { status: 400 });
            if (request.headers.get("Upgrade") !== "websocket") {
                return new Response("Expected WebSocket", { status: 426 });
            }
            return classStub(env, s).fetch(request);
        }

        if (url.pathname.startsWith("/api/")) {
            try {
                return await handleApi(request, env, url);
            } catch (e) {
                console.error("API error:", e && e.stack);
                return json({ ok: false, reason: "server_error" }, 500);
            }
        }

        return new Response("Not found", { status: 404 });
    },

    /** Daily retention cleanup of the permanent copy in D1. */
    async scheduled(_event, env) {
        if (!env.DB) return;
        const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
        await env.DB.prepare("DELETE FROM results WHERE finished_at < ?").bind(cutoff).run();
        await env.DB.prepare("DELETE FROM sessions WHERE created_at < ?").bind(cutoff).run();
    },
};
