/**
 * class-core.js — one class session's rules, with no Cloudflare APIs.
 * The ClassSession Durable Object (class-session.js) wraps this; Node tests drive it directly.
 *
 * A session is created by the instructor. Pairs register the first time a student joins
 * (canJoin) and get a generated team name ("Steady Otters") that is unique in the session —
 * that name is what the leaderboard and CSV show (no student names are collected).
 * Closing a session stops NEW pairs; pairs already playing can finish and their results
 * still count.
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

/* Team names: friendly adjective + animal. 30 × 30 = 900 combinations per session. */
export const TEAM_ADJECTIVES = [
    "Brave", "Calm", "Steady", "Mighty", "Swift", "Clever", "Bright", "Bold", "Gentle", "Lucky",
    "Sunny", "Cosmic", "Daring", "Eager", "Fearless", "Golden", "Happy", "Jolly", "Kind", "Lively",
    "Merry", "Noble", "Plucky", "Quick", "Radiant", "Spirited", "Trusty", "Valiant", "Witty", "Zesty",
];
export const TEAM_ANIMALS = [
    "Otters", "Owls", "Foxes", "Pandas", "Falcons", "Turtles", "Hummingbirds", "Dolphins", "Koalas", "Penguins",
    "Badgers", "Beavers", "Bison", "Cardinals", "Cheetahs", "Eagles", "Geckos", "Herons", "Jaguars", "Lynxes",
    "Manatees", "Meerkats", "Narwhals", "Ospreys", "Pelicans", "Puffins", "Ravens", "Sea Lions", "Tigers", "Wolves",
];

/** A team name not already used in this session. */
export function newTeamName(used, random = Math.random) {
    const taken = new Set(used);
    for (let i = 0; i < 50; i++) {
        const name =
            TEAM_ADJECTIVES[Math.floor(random() * TEAM_ADJECTIVES.length)] + " " +
            TEAM_ANIMALS[Math.floor(random() * TEAM_ANIMALS.length)];
        if (!taken.has(name)) return name;
    }
    // Very full session (or unlucky rolls): walk the list, then number them.
    for (const a of TEAM_ADJECTIVES) for (const b of TEAM_ANIMALS) if (!taken.has(`${a} ${b}`)) return `${a} ${b}`;
    let n = 2;
    while (taken.has(`Team ${n}`)) n++;
    return `Team ${n}`;
}

export function newSession({ code, course, now }) {
    return { v: 1, code, course: cleanCourse(course), createdAt: now, closedAt: null, pairs: {}, results: [] };
}

function emptyPair(pair, now, teamName) {
    return {
        pair,
        teamName,
        attempt: 1,
        status: "waiting",
        passage: "",
        points: 0,
        energy: 10,
        elapsedMs: 0,
        patientConnected: false,
        observerConnected: false,
        updatedAt: now,
    };
}

/**
 * May a NEW student seat in `pair` join? Registers the pair (with a team name) on first join.
 * Also answers already-registered pairs with their team name (gives one to pairs registered
 * before team names existed).
 * @returns {{ ok: boolean, reason?: string, teamName?: string, dirty: boolean }}
 */
export function canJoin(session, pair, now, random = Math.random) {
    if (!session) return { ok: false, reason: "no_session", dirty: false };
    const used = () => Object.values(session.pairs).map((p) => p.teamName).filter(Boolean);
    const existing = session.pairs[pair];
    if (existing) {
        if (existing.teamName) return { ok: true, teamName: existing.teamName, dirty: false };
        existing.teamName = newTeamName(used(), random);
        return { ok: true, teamName: existing.teamName, dirty: true };
    }
    if (session.closedAt) return { ok: false, reason: "session_closed", dirty: false };
    const teamName = newTeamName(used(), random);
    session.pairs[pair] = emptyPair(pair, now, teamName);
    return { ok: true, teamName, dirty: true };
}

/**
 * Updates a pair's live status. Only pairs admitted by canJoin can be updated — otherwise a
 * refused pair's "socket closed" update would sneak it onto the board (and past the gate).
 */
export function applyProgress(session, p) {
    if (!session || !p || !p.pair || !session.pairs[p.pair]) return false;
    const { teamName, ...rest } = p; // the session owns the team name
    session.pairs[p.pair] = { ...session.pairs[p.pair], ...rest };
    return true;
}

/** Stores a result (replacing an earlier copy of the same pair + attempt). */
export function applyResult(session, r) {
    if (!session || !r || !r.pair) return false;
    session.results = session.results.filter((x) => !(x.pair === r.pair && x.attempt === r.attempt));
    const team = session.pairs[r.pair] && session.pairs[r.pair].teamName;
    session.results.push(team ? { ...r, teamName: team } : r);
    if (session.pairs[r.pair]) session.pairs[r.pair].status = "finished";
    return true;
}

/** The team name, or "Pair KCP2" for pairs from before team names existed. */
export function pairLabel(r) {
    return r.teamName || `Pair ${r.pair}`;
}

/** Everything the instructor page shows. */
export function board(session) {
    if (!session) return null;
    const pairs = Object.values(session.pairs).sort((a, b) => pairLabel(a).localeCompare(pairLabel(b)));
    const teamOf = (r) => (session.pairs[r.pair] && session.pairs[r.pair].teamName) || r.teamName;
    const withLabels = (rows) => rows.map((r) => ({ ...r, label: pairLabel({ ...r, teamName: teamOf(r) }) }));
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
    // Stop spreadsheet formula injection (defense in depth; team names are generated)
    if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
    return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** CSV of every attempt, ranked (rank = rank among all attempts). */
export function toCsv(session) {
    const header = [
        "rank", "session", "team", "pair", "attempt", "points", "time",
        "elapsed_seconds", "energy", "has_meds", "has_toy", "outcome", "finished_at",
    ];
    const rows = rankResults(session ? session.results : []).map((r) => [
        r.rank,
        session.code,
        pairLabel({ ...r, teamName: (session.pairs[r.pair] && session.pairs[r.pair].teamName) || r.teamName }),
        r.pair,
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
