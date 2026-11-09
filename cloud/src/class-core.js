/**
 * class-core.js — one class session's rules, with no Cloudflare APIs.
 * The ClassSession Durable Object (class-session.js) wraps this; Node tests drive it directly.
 *
 * A session is created by the instructor. Pairs register the first time a student joins
 * (canJoin). Closing a session stops NEW pairs; pairs already playing can finish and their
 * results still count.
 */
import { rankResults, bestPerPair, formatElapsed } from "./ranking.js";

export const SESSION_RE = /^[A-Z0-9][A-Z0-9-]{2,23}$/;
const MAX_COURSE_LEN = 60;

export function cleanCourse(course) {
    return String(course || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, MAX_COURSE_LEN);
}

/** Random code like "COPD-K7MQ" (no 0/O/1/I to avoid misreading). */
export function newSessionCode(random = Math.random) {
    const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let out = "";
    for (let i = 0; i < 4; i++) out += chars[Math.floor(random() * chars.length)];
    return `COPD-${out}`;
}

export function newSession({ code, course, now }) {
    return { v: 1, code, course: cleanCourse(course), createdAt: now, closedAt: null, pairs: {}, results: [] };
}

function emptyPair(pair, now) {
    return {
        pair,
        attempt: 1,
        status: "waiting",
        passage: "",
        points: 0,
        energy: 10,
        elapsedMs: 0,
        patientName: "",
        observerName: "",
        patientConnected: false,
        observerConnected: false,
        updatedAt: now,
    };
}

/**
 * May a NEW student seat in `pair` join? Registers the pair on first join.
 * @returns {{ ok: boolean, reason?: string, dirty: boolean }}
 */
export function canJoin(session, pair, now) {
    if (!session) return { ok: false, reason: "no_session", dirty: false };
    if (session.pairs[pair]) return { ok: true, dirty: false };
    if (session.closedAt) return { ok: false, reason: "session_closed", dirty: false };
    session.pairs[pair] = emptyPair(pair, now);
    return { ok: true, dirty: true };
}

/**
 * Updates a pair's live status. Only pairs admitted by canJoin can be updated — otherwise a
 * refused pair's "socket closed" update would sneak it onto the board (and past the gate).
 */
export function applyProgress(session, p) {
    if (!session || !p || !p.pair || !session.pairs[p.pair]) return false;
    session.pairs[p.pair] = { ...session.pairs[p.pair], ...p };
    return true;
}

/** Stores a result (replacing an earlier copy of the same pair + attempt). */
export function applyResult(session, r) {
    if (!session || !r || !r.pair) return false;
    session.results = session.results.filter((x) => !(x.pair === r.pair && x.attempt === r.attempt));
    session.results.push(r);
    if (session.pairs[r.pair]) session.pairs[r.pair].status = "finished";
    return true;
}

/** "Robin & Sam", or "Pair KCP2" when no nicknames were given. */
export function pairLabel(r) {
    const names = [r.patientName, r.observerName].filter(Boolean);
    return names.length ? names.join(" & ") : `Pair ${r.pair}`;
}

/** Everything the instructor page shows. */
export function board(session) {
    if (!session) return null;
    const pairs = Object.values(session.pairs).sort((a, b) => String(a.pair).localeCompare(String(b.pair)));
    const withLabels = (rows) => rows.map((r) => ({ ...r, label: pairLabel(r) }));
    const finishedPairs = new Set(session.results.map((r) => r.pair)).size;
    return {
        code: session.code,
        course: session.course,
        createdAt: session.createdAt,
        closedAt: session.closedAt,
        pairs: withLabels(pairs),
        pairCount: pairs.length,
        finishedPairs,
        best: withLabels(rankResults(bestPerPair(session.results))),
        all: withLabels(rankResults(session.results)),
    };
}

/* ---------------- CSV export ---------------- */

function csvCell(value) {
    let v = value === null || value === undefined ? "" : String(value);
    // Stop spreadsheet formula injection from nicknames like "=HYPERLINK(...)"
    if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
    return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** CSV of every attempt, ranked (rank = rank among all attempts). */
export function toCsv(session) {
    const header = [
        "rank", "session", "pair", "patient", "observer", "attempt", "points", "time",
        "elapsed_seconds", "energy", "has_meds", "has_toy", "outcome", "finished_at",
    ];
    const rows = rankResults(session ? session.results : []).map((r) => [
        r.rank,
        session.code,
        r.pair,
        r.patientName,
        r.observerName,
        r.attempt,
        r.points,
        formatElapsed(r.elapsedMs),
        Math.round((r.elapsedMs || 0) / 1000),
        r.energy,
        r.hasMeds ? "yes" : "no",
        r.hasToy ? "yes" : "no",
        r.win ? "made it through the day" : "hospital",
        new Date(r.finishedAt).toISOString(),
    ]);
    return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
