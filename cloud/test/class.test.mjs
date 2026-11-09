import { test } from "node:test";
import assert from "node:assert/strict";
import { compareResults, rankResults, bestPerPair, formatElapsed } from "../src/ranking.js";
import { newSession, canJoin, applyProgress, applyResult, board, toCsv, newSessionCode, SESSION_RE } from "../src/class-core.js";
import { RoomCore } from "../src/room-core.js";
import { pinMatches, pinFromRequest } from "../src/auth.js";

const r = (pair, attempt, points, elapsedMs, energy, hasMeds = false, hasToy = false, extra = {}) => ({
    pair, attempt, points, elapsedMs, energy, hasMeds, hasToy, win: true, finishedAt: 1_700_000_000_000,
    patientName: "", observerName: "", ...extra,
});

/* ---------------- ranking (design doc §8.1) ---------------- */

test("ranking: most points, then fastest, energy, meds, toy", () => {
    const rows = rankResults([
        r("A", 1, 30, 600_000, 5),
        r("B", 1, 40, 900_000, 1), // most points wins even though slowest
        r("C", 1, 30, 500_000, 5), // same points as A, faster
        r("D", 1, 30, 600_000, 9), // ties A on points+time, more energy
        r("E", 1, 30, 600_000, 5, true), // ties A on points+time+energy, has meds
        r("F", 1, 30, 600_000, 5, true, true), // ties E, also has toy
    ]);
    assert.deepEqual(rows.map((x) => x.pair), ["B", "C", "D", "F", "E", "A"]);
    assert.deepEqual(rows.map((x) => x.rank), [1, 2, 3, 4, 5, 6]);
});

test("ranking: complete ties share a rank (1, 1, 3)", () => {
    const rows = rankResults([r("A", 1, 10, 1000, 3), r("B", 1, 10, 1000, 3), r("C", 1, 5, 1000, 3)]);
    assert.deepEqual(rows.map((x) => [x.pair, x.rank]), [["A", 1], ["B", 1], ["C", 3]]);
    assert.equal(compareResults(rows[0], rows[1]), 0);
});

test("best attempt per pair uses the same rules", () => {
    const best = bestPerPair([r("A", 1, 10, 1000, 3), r("A", 2, 25, 9000, 1), r("B", 1, 5, 100, 9)]);
    assert.deepEqual(best.map((x) => [x.pair, x.attempt]).sort(), [["A", 2], ["B", 1]]);
});

test("formatElapsed gives m:ss", () => {
    assert.equal(formatElapsed(65_000), "1:05");
    assert.equal(formatElapsed(0), "0:00");
    assert.equal(formatElapsed(3_725_000), "62:05");
});

/* ---------------- class session ---------------- */

test("pairs can join an open session; a closed session only admits pairs already in it", () => {
    assert.deepEqual(canJoin(null, "P1", 0), { ok: false, reason: "no_session", dirty: false });
    const s = newSession({ code: "COPD-TEST", course: "REGN 15P <b>AM</b>", now: 1 });
    assert.equal(s.course, "REGN 15P bAM/b");
    assert.equal(canJoin(s, "P1", 2).ok, true);
    s.closedAt = 3;
    assert.equal(canJoin(s, "P1", 4).ok, true); // already registered (e.g. second player, reconnect)
    assert.deepEqual(canJoin(s, "P2", 4), { ok: false, reason: "session_closed", dirty: false });
});

test("a refused pair's progress update can't register it (closed session stays closed)", () => {
    const s = newSession({ code: "COPD-TEST", course: "", now: 1 });
    s.closedAt = 2;
    assert.equal(canJoin(s, "NEW9", 3).reason, "session_closed");
    assert.equal(applyProgress(s, { pair: "NEW9", status: "waiting", updatedAt: 4 }), false);
    assert.equal(s.pairs.NEW9, undefined);
    assert.equal(canJoin(s, "NEW9", 5).reason, "session_closed");
});

test("board: live pairs, ranked best and all attempts, finished count, labels", () => {
    const s = newSession({ code: "COPD-TEST", course: "", now: 1 });
    canJoin(s, "AAAA", 1);
    canJoin(s, "BBBB", 1);
    applyProgress(s, { pair: "AAAA", status: "playing", passage: "Breakfast", points: 4, patientName: "Robin", observerName: "Sam" });
    applyResult(s, r("AAAA", 1, 20, 500_000, 4, false, false, { patientName: "Robin", observerName: "Sam" }));
    applyResult(s, r("AAAA", 2, 30, 600_000, 2, false, false, { patientName: "Robin", observerName: "Sam" }));
    applyResult(s, r("AAAA", 2, 30, 600_000, 2, false, false, { patientName: "Robin", observerName: "Sam" })); // duplicate replaced
    const b = board(s);
    assert.equal(b.pairCount, 2);
    assert.equal(b.finishedPairs, 1);
    assert.equal(b.all.length, 2);
    assert.equal(b.best.length, 1);
    assert.equal(b.best[0].attempt, 2);
    assert.equal(b.best[0].label, "Robin & Sam");
    assert.equal(b.pairs.find((p) => p.pair === "AAAA").status, "finished");
    assert.equal(b.pairs.find((p) => p.pair === "BBBB").label, "Pair BBBB");
});

test("CSV: ranked rows, readable times, and no spreadsheet formula injection", () => {
    const s = newSession({ code: "COPD-TEST", course: "", now: 1 });
    applyResult(s, r("AAAA", 1, 20, 65_000, 4, true, false, { patientName: "=HYPERLINK(1)", observerName: 'Sam "S"' }));
    const lines = toCsv(s).trim().split("\r\n");
    assert.equal(lines[0], "rank,session,pair,patient,observer,attempt,points,time,elapsed_seconds,energy,has_meds,has_toy,outcome,finished_at");
    assert.equal(lines[1], `1,COPD-TEST,AAAA,'=HYPERLINK(1),"Sam ""S""",1,20,1:05,65,4,yes,no,made it through the day,2023-11-14T22:13:20.000Z`);
});

test("generated session codes are valid and avoid look-alike characters", () => {
    for (let i = 0; i < 50; i++) {
        const code = newSessionCode();
        assert.match(code, SESSION_RE);
        assert.doesNotMatch(code.slice(5), /[01IO]/);
    }
});

/* ---------------- room results (server-built, once per attempt) ---------------- */

function roomWithPair() {
    let clock = 1_000_000;
    let n = 0;
    const room = new RoomCore(null, { sessionCode: "COPD-TEST", pairCode: "AAAA", now: () => clock, makeToken: () => `t${++n}` });
    const a = { token: null };
    const b = { token: null };
    room.handle(a, { t: "hello" });
    room.handle(b, { t: "hello" });
    room.handle(a, { t: "claimRole", role: "patient", name: "Robin" });
    room.handle(b, { t: "claimRole", role: "observer", name: "Sam" });
    const nav = (passage, timer) =>
        room.handle(a, { t: "navigate", passage, expectSeq: room.state.game.passageSeq, timer }, new Set(["t1", "t2"]));
    return { room, a, nav, tick: (ms) => (clock += ms) };
}

test("reaching Final_Report emits one official result built from server state", () => {
    const { room, a, nav, tick } = roomWithPair();
    room.handle(a, { t: "set", patch: { Energy: 6, Points: 22, Inhaler: 2, hasMedications: true, hasToy: false } });
    nav("Simulation_Hub", "run");
    tick(90_000);
    const done = nav("Final_Report", "stop");
    const result = done.events.find((e) => e.type === "result").result;
    assert.deepEqual(
        { ...result, finishedAt: undefined },
        {
            pair: "AAAA", attempt: 1, patientName: "Robin", observerName: "Sam", points: 22, energy: 6,
            elapsedMs: 90_000, hasMeds: true, hasToy: false, win: true, finishedAt: undefined,
        }
    );
    assert.equal(done.events.find((e) => e.type === "progress").progress.status, "finished");
    // Leaving and coming back to the debrief doesn't report twice
    nav("Start", "none");
    assert.equal(nav("Final_Report", "stop").events.some((e) => e.type === "result"), false);
});

test("a game over makes the attempt a loss even if stats look fine", () => {
    const { room, a, nav } = roomWithPair();
    room.handle(a, { t: "set", patch: { Energy: 5, Inhaler: 0 } });
    nav("Hallway", "run");
    nav("Game_Over_Inhaler", "pause");
    const res = nav("Final_Report", "stop").events.find((e) => e.type === "result").result;
    assert.equal(res.win, false);
});

test("Try Again starts a fresh attempt that reports its own result", () => {
    const { room, a, nav } = roomWithPair();
    nav("Game_Over_Energy", "pause");
    nav("Final_Report", "stop");
    room.handle(a, { t: "reset", fromAttempt: 1, game: { Energy: 10, Points: 0 }, passage: "Simulation_Hub" });
    room.handle(a, { t: "set", patch: { Points: 7 } });
    const res = nav("Final_Report", "stop").events.find((e) => e.type === "result").result;
    assert.equal(res.attempt, 2);
    assert.equal(res.points, 7);
    assert.equal(res.win, true); // the game over belonged to attempt 1
});

test("progress events track joins, moves and presence", () => {
    const { room, nav } = roomWithPair();
    const moved = nav("Breakfast", "run").events.find((e) => e.type === "progress").progress;
    assert.equal(moved.status, "playing");
    assert.equal(moved.passage, "Breakfast");
    assert.equal(moved.patientConnected, true);
    const gone = room.presenceChanged(new Set(["t2"])).events[0].progress;
    assert.equal(gone.patientConnected, false);
    assert.equal(gone.observerConnected, true);
});

/* ---------------- PIN ---------------- */

test("PIN check: exact match only, and refuses when no PIN is configured", () => {
    assert.equal(pinMatches("correct horse", "correct horse"), true);
    assert.equal(pinMatches("correct hors", "correct horse"), false);
    assert.equal(pinMatches("", ""), false);
    assert.equal(pinMatches("12345", "12345"), false); // shorter than 6: treated as not configured
    assert.equal(pinMatches(undefined, "correct horse"), false);
    const req = new Request("http://x/api/sessions", { headers: { Authorization: "Bearer abc 123" } });
    assert.equal(pinFromRequest(req), "abc 123");
});
