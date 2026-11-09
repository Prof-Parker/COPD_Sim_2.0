import { test } from "node:test";
import assert from "node:assert/strict";
import { RoomCore, cleanName, routeMessages, timerElapsed } from "../src/room-core.js";

function makeRoom(saved = null) {
    let n = 0;
    let clock = 1000;
    const room = new RoomCore(saved, {
        sessionCode: "TEST1",
        pairCode: "1",
        now: () => clock,
        makeToken: () => `tok${++n}`,
    });
    return { room, tick: (ms) => (clock += ms) };
}

/** Joins a client and returns its conn + welcome message. */
function join(room, token, connected = new Set()) {
    const conn = { token: null };
    const { out } = room.handle(conn, { t: "hello", token }, connected);
    return { conn, welcome: out.find((o) => o.to === "self").msg };
}

test("hello issues a token and a full snapshot", () => {
    const { room } = makeRoom();
    const { conn, welcome } = join(room);
    assert.equal(welcome.t, "welcome");
    assert.equal(conn.token, "tok1");
    assert.equal(welcome.token, "tok1");
    assert.equal(welcome.snapshot.passage, "Role_Selection");
    assert.deepEqual(welcome.you, { pid: "p1", role: null, name: "" });
});

test("players get stable public ids, listed in join order without tokens", () => {
    const { room } = makeRoom();
    const a = join(room);
    join(room);
    room.handle(a.conn, { t: "claimRole", role: "observer" });
    const snap = room.snapshot(new Set(["tok2"]));
    assert.deepEqual(snap.players, [
        { pid: "p1", role: "observer", name: "", connected: false },
        { pid: "p2", role: null, name: "", connected: true },
    ]);
    assert.equal(JSON.stringify(snap).includes("tok"), false);
});

test("rooms saved before player ids existed get ids on load", () => {
    const saved = {
        v: 1, sessionCode: "S", pairCode: "1", seq: 3, passage: "Role_Selection", passageSeq: 0,
        attempt: 1, startedAt: null, endedAt: null,
        players: { old1: { role: "patient", name: "" } }, roles: { patient: "old1", observer: null }, game: {},
    };
    const { room } = makeRoom(saved);
    assert.equal(room.you("old1").pid, "p1");
    assert.equal(room.state.nextPid, 2);
});

test("the sender's copy of a broadcast acknowledges its cid; the partner's does not", () => {
    const { room } = makeRoom();
    const a = join(room);
    join(room);
    const { out } = room.handle(a.conn, { t: "set", patch: { Points: 1 }, cid: 9 });
    assert.equal(room.personalize(out[0].msg, "tok1").ack, 9);
    assert.equal(room.personalize(out[0].msg, "tok2").ack, undefined);
    assert.equal("ackToken" in room.personalize(out[0].msg, "tok1"), false);
    const rej = room.handle(a.conn, { t: "set", patch: {}, cid: 10 });
    assert.equal(room.personalize(rej.out[0].msg, "tok1").ack, 10);
});

test("routeMessages sends self/others/all to the right sockets", () => {
    const { room } = makeRoom();
    const sent = { a: [], b: [], c: [] };
    const a = { token: "tok1", send: (t) => sent.a.push(JSON.parse(t)) };
    const b = { token: "tok2", send: (t) => sent.b.push(JSON.parse(t)) };
    const c = { token: null, send: (t) => sent.c.push(JSON.parse(t)) }; // not joined yet
    join(room);
    join(room);
    routeMessages(room, [
        { to: "self", msg: { t: "pong" } },
        { to: "others", msg: { t: "state", seq: 1 } },
        { to: "all", msg: { t: "state", seq: 2 } },
    ], [a, b, c], a);
    assert.deepEqual(sent.a.map((m) => m.t + (m.seq || "")), ["pong", "state2"]);
    assert.deepEqual(sent.b.map((m) => m.t + (m.seq || "")), ["state1", "state2"]);
    assert.equal(sent.c.length, 0);
    assert.equal(sent.b[0].you.pid, "p2");
});

test("reconnecting with the same token keeps the role", () => {
    const { room } = makeRoom();
    const a = join(room);
    room.handle(a.conn, { t: "claimRole", role: "patient" });
    const again = join(room, "tok1");
    assert.equal(again.conn.token, "tok1");
    assert.equal(again.welcome.you.role, "patient");
});

test("a third device is turned away; known tokens still get in", () => {
    const { room } = makeRoom();
    join(room);
    join(room);
    const conn = { token: null };
    const { out } = room.handle(conn, { t: "hello" });
    assert.equal(out[0].msg.t, "reject");
    assert.equal(out[0].msg.reason, "room_full");
    assert.equal(conn.token, null);
    assert.equal(join(room, "tok2").welcome.t, "welcome");
});

test("only one patient and one observer", () => {
    const { room } = makeRoom();
    const a = join(room);
    const b = join(room);
    room.handle(a.conn, { t: "claimRole", role: "patient" });
    const { out } = room.handle(b.conn, { t: "claimRole", role: "patient" });
    assert.equal(out[0].msg.reason, "role_taken");
    room.handle(b.conn, { t: "claimRole", role: "observer" });
    assert.equal(room.you("tok2").role, "observer");
    // Switching roles frees the old one
    room.handle(a.conn, { t: "claimRole", role: null });
    room.handle(b.conn, { t: "claimRole", role: "patient" });
    assert.equal(room.state.roles.patient, "tok2");
    assert.equal(room.state.roles.observer, null);
});

test("set merges game keys and broadcasts; bad patches are rejected", () => {
    const { room } = makeRoom();
    const a = join(room);
    const { out, dirty } = room.handle(a.conn, { t: "set", patch: { Points: 3, hasToy: true } });
    assert.equal(dirty, true);
    assert.equal(out[0].to, "all");
    assert.deepEqual(out[0].msg.snapshot.game, { currentPassage: "Role_Selection", passageSeq: 0, Points: 3, hasToy: true });
    for (const patch of [{ "bad key": 1 }, { x: { nested: 1 } }, { x: NaN }, {}, null]) {
        const r = room.handle(a.conn, { t: "set", patch });
        assert.equal(r.out[0].msg.reason, "bad_patch", JSON.stringify(patch));
        assert.equal(r.dirty, false);
    }
});

test("inc is atomic, so two devices adding at once both count", () => {
    const { room } = makeRoom();
    const a = join(room);
    const b = join(room);
    room.handle(a.conn, { t: "inc", key: "Points", by: 1 });
    room.handle(b.conn, { t: "inc", key: "Points", by: 1 });
    assert.equal(room.state.game.Points, 2);
    room.handle(a.conn, { t: "set", patch: { Energy: 1 } });
    room.handle(a.conn, { t: "inc", key: "Energy", by: -5, min: 0, max: 15 });
    assert.equal(room.state.game.Energy, 0);
    assert.equal(room.handle(a.conn, { t: "inc", key: "x y", by: 1 }).out[0].msg.reason, "bad_patch");
    assert.equal(room.handle(a.conn, { t: "inc", key: "Points", by: "1" }).out[0].msg.reason, "bad_patch");
});

test("navigate needs the current passageSeq; stale requests get the truth back", () => {
    const { room } = makeRoom();
    const a = join(room);
    const b = join(room);
    room.handle(a.conn, { t: "navigate", passage: "Waiting_Room", expectSeq: 0 });
    // b raced with the same old seq
    const { out } = room.handle(b.conn, { t: "navigate", passage: "Somewhere_Else", expectSeq: 0 });
    assert.equal(out[0].msg.reason, "stale_seq");
    assert.equal(out[0].msg.snapshot.passage, "Waiting_Room");
    assert.equal(room.state.game.passageSeq, 1);
});

test("messages before hello are refused", () => {
    const { room } = makeRoom();
    const { out } = room.handle({ token: null }, { t: "set", patch: { Points: 1 } });
    assert.equal(out[0].msg.reason, "not_joined");
});

test("presence reports whether each role is connected", () => {
    const { room } = makeRoom();
    const a = join(room);
    room.handle(a.conn, { t: "claimRole", role: "patient" });
    assert.equal(room.snapshot(new Set(["tok1"])).roles.patient.connected, true);
    const { out } = room.presenceChanged(new Set());
    assert.equal(out[0].msg.snapshot.roles.patient.connected, false);
});

test("state survives a save/load round trip (Durable Object eviction)", () => {
    const { room } = makeRoom();
    const a = join(room);
    room.handle(a.conn, { t: "claimRole", role: "observer", name: "Sam" });
    room.handle(a.conn, { t: "set", patch: { Energy: 7 } });
    const saved = JSON.parse(JSON.stringify(room.state));
    const { room: reloaded } = makeRoom(saved);
    assert.deepEqual(reloaded.you("tok1"), { pid: "p1", role: "observer", name: "Sam" });
    assert.equal(reloaded.snapshot().game.Energy, 7);
});

test("personalize adds each player's own role to broadcasts", () => {
    const { room } = makeRoom();
    const a = join(room);
    const b = join(room);
    const { out } = room.handle(a.conn, { t: "claimRole", role: "patient" });
    assert.equal(room.personalize(out[0].msg, "tok1").you.role, "patient");
    assert.equal(room.personalize(out[0].msg, "tok2").you.role, null);
    assert.equal(b.conn.token, "tok2");
});

test("names are trimmed, capped at 20 chars, and stripped of markup", () => {
    assert.equal(cleanName("  <b>Robin</b>  "), "bRobin/b");
    assert.equal(cleanName("x".repeat(30)).length, 20);
    assert.equal(cleanName(42), "");
});

test("ping answers with the server clock", () => {
    const { room, tick } = makeRoom();
    tick(500);
    const { out } = room.handle({ token: null }, { t: "ping", id: 7 });
    assert.deepEqual(out[0].msg, { t: "pong", serverNow: 1500, id: 7 });
});

/* ---- Milestone C: server-owned navigation, rolls, ops, timer, attempts ---- */

function makeRoomC({ random = () => 0.99 } = {}) {
    let n = 0;
    let clock = 1_000_000;
    const room = new RoomCore(null, {
        sessionCode: "TEST1",
        pairCode: "1",
        now: () => clock,
        makeToken: () => `tok${++n}`,
        random,
    });
    const a = join(room);
    const b = join(room);
    return { room, a, b, tick: (ms) => (clock += ms) };
}

test("navigate is compare-and-set on game.passageSeq and applies its patch atomically", () => {
    const { room, a, b } = makeRoomC();
    room.handle(a.conn, { t: "navigate", passage: "Good_Morning_Mr._Holland", expectSeq: 0, patch: { evalComplete: false } });
    assert.equal(room.state.game.currentPassage, "Good_Morning_Mr._Holland");
    assert.equal(room.state.game.passageSeq, 1);
    assert.equal(room.state.game.evalComplete, false);
    const lost = room.handle(b.conn, { t: "navigate", passage: "Grocery_Store_1", expectSeq: 0, cid: 4 });
    assert.equal(lost.out[0].msg.reason, "stale_seq");
    assert.equal(room.personalize(lost.out[0].msg, "tok2").ack, 4);
    assert.equal(room.state.game.currentPassage, "Good_Morning_Mr._Holland");
    for (const passage of ["", "bad<tag>", "x".repeat(81)]) {
        assert.equal(room.handle(a.conn, { t: "navigate", passage, expectSeq: 1 }).out[0].msg.reason, "bad_passage");
    }
});

test("the room clock runs, pauses on pausetimer passages, and stops at the debrief", () => {
    const { room, a, tick } = makeRoomC();
    const nav = (passage, timer) =>
        room.handle(a.conn, { t: "navigate", passage, expectSeq: room.state.game.passageSeq, timer });
    nav("Waiting_Room", "none");
    assert.equal(room.state.timer.startedAt, null);
    nav("Simulation_Hub", "run");
    tick(60_000);
    assert.equal(timerElapsed(room.state.timer, room.now()), 60_000);
    nav("Bedtime", "pause");
    tick(30_000); // time on a pausetimer passage doesn't count
    nav("Hallway", "run");
    tick(10_000);
    assert.equal(timerElapsed(room.state.timer, room.now()), 70_000);
    nav("Final_Report", "stop");
    tick(99_000);
    assert.equal(timerElapsed(room.state.timer, room.now()), 70_000);
    nav("Somewhere", "run"); // stays stopped until reset
    assert.equal(timerElapsed(room.state.timer, room.now()), 70_000);
});

test("game over (paused) then debrief keeps the time from when play stopped", () => {
    const { room, a, tick } = makeRoomC();
    const nav = (passage, timer) =>
        room.handle(a.conn, { t: "navigate", passage, expectSeq: room.state.game.passageSeq, timer });
    nav("Simulation_Hub", "run");
    tick(5_000);
    nav("Game_Over_Energy", "pause");
    tick(20_000);
    nav("Final_Report", "stop");
    assert.equal(timerElapsed(room.state.timer, room.now()), 5_000);
});

test("timer reset restarts the clock at zero", () => {
    const { room, a, tick } = makeRoomC();
    room.handle(a.conn, { t: "navigate", passage: "Simulation_Hub", expectSeq: 0, timer: "run" });
    tick(45_000);
    room.handle(a.conn, { t: "timer", action: "reset" });
    tick(1_000);
    assert.equal(timerElapsed(room.state.timer, room.now()), 1_000);
    assert.equal(room.handle(a.conn, { t: "timer", action: "explode" }).out[0].msg.reason, "bad_timer");
});

test("a roll happens once per key per passage, and both devices get the same number", () => {
    const rolls = [0.1, 0.9, 0.9, 0.9];
    const { room, a, b } = makeRoomC({ random: () => rolls.shift() });
    room.handle(a.conn, { t: "navigate", passage: "Grocery_Store_Router", expectSeq: 0 });
    room.handle(b.conn, { t: "roll", key: "groceryRoll", sides: 2 });
    room.handle(a.conn, { t: "roll", key: "groceryRoll", sides: 2 });
    assert.equal(room.state.game.groceryRoll, 1); // first roll (0.1) kept
    // A later visit (new passageSeq) rolls again
    room.handle(a.conn, { t: "navigate", passage: "Grocery_Store_Router", expectSeq: 1 });
    room.handle(a.conn, { t: "roll", key: "groceryRoll", sides: 2 });
    assert.equal(room.state.game.groceryRoll, 2);
    assert.equal(room.handle(a.conn, { t: "roll", key: "groceryRoll", sides: 1 }).out[0].msg.reason, "bad_roll");
});

test("errandsDrain runs once per passage even when both devices ask", () => {
    const { room, a, b } = makeRoomC();
    room.handle(a.conn, { t: "set", patch: { Energy: 12, errandsRun: 3 } });
    room.handle(a.conn, { t: "navigate", passage: "Whistle_Stop_In", expectSeq: 0 });
    room.handle(a.conn, { t: "op", name: "errandsDrain" });
    room.handle(b.conn, { t: "op", name: "errandsDrain" });
    assert.equal(room.state.game.Energy, 3);
    room.handle(a.conn, { t: "set", patch: { Energy: 2 } });
    room.handle(a.conn, { t: "navigate", passage: "Whistle_Stop_In", expectSeq: 1 });
    room.handle(a.conn, { t: "op", name: "errandsDrain" });
    assert.equal(room.state.game.Energy, 0); // clamped
    assert.equal(room.handle(a.conn, { t: "op", name: "hack" }).out[0].msg.reason, "bad_op");
});

test("Try Again starts a new attempt once, even if both players press it", () => {
    const { room, a, b, tick } = makeRoomC();
    room.handle(a.conn, { t: "set", patch: { Energy: 2, Points: 40, lobby_patient: true } });
    room.handle(a.conn, { t: "navigate", passage: "Final_Report", expectSeq: 0, timer: "stop" });
    tick(5_000);
    const defaults = { Energy: 10, Points: 0, pendingGameOver: "" };
    room.handle(a.conn, { t: "reset", fromAttempt: 1, game: defaults, passage: "Simulation_Hub" });
    const second = room.handle(b.conn, { t: "reset", fromAttempt: 1, game: defaults, passage: "Simulation_Hub" });
    assert.equal(second.out[0].msg.reason, "stale_attempt");
    assert.equal(room.state.attempt, 2);
    assert.equal(room.state.game.Energy, 10);
    assert.equal(room.state.game.Points, 0);
    assert.equal(room.state.game.lobby_patient, true); // lobby keys kept
    assert.equal(room.state.game.currentPassage, "Simulation_Hub");
    assert.equal(room.state.game.passageSeq, 2);
    assert.equal(timerElapsed(room.state.timer, room.now()), 0);
});

test("name sets the optional nickname", () => {
    const { room, a } = makeRoomC();
    room.handle(a.conn, { t: "name", name: "  Sam  " });
    assert.equal(room.you("tok1").name, "Sam");
});

test("Milestone A/B rooms (passage fields on state) upgrade into game keys", () => {
    const saved = {
        v: 1, sessionCode: "S", pairCode: "1", seq: 3, passage: "Waiting_Room", passageSeq: 4,
        attempt: 1, startedAt: null, endedAt: null, nextPid: 2,
        players: { t1: { pid: "p1", role: "patient", name: "" } }, roles: { patient: "t1", observer: null }, game: { Energy: 9 },
    };
    const room = new RoomCore(saved, {});
    assert.equal(room.state.game.currentPassage, "Waiting_Room");
    assert.equal(room.state.game.passageSeq, 4);
    assert.equal("passage" in room.state, false);
    assert.deepEqual(room.state.timer, { startedAt: null, pausedAt: null, pausedMs: 0, stoppedAt: null });
    assert.equal(room.snapshot().passageSeq, 4);
});

test("takeover: a new device can claim an offline seat (keeping its role), never an online one", () => {
    const { room, a, b } = makeRoomC();
    room.handle(a.conn, { t: "claimRole", role: "patient", name: "Robin" });
    room.handle(b.conn, { t: "claimRole", role: "observer" });
    // Both online: refused even with takeover
    const both = room.handle({ token: null }, { t: "hello", takeover: true }, new Set(["tok1", "tok2"]));
    assert.equal(both.out[0].msg.reason, "room_full");
    // Patient's device is gone; without takeover still refused
    const plain = room.handle({ token: null }, { t: "hello" }, new Set(["tok2"]));
    assert.equal(plain.out[0].msg.reason, "room_full");
    const conn = { token: null };
    const { out } = room.handle(conn, { t: "hello", takeover: true }, new Set(["tok2"]));
    assert.equal(out[0].msg.t, "welcome");
    assert.deepEqual(out[0].msg.you, { pid: "p1", role: "patient", name: "Robin" });
    assert.equal(room.state.roles.patient, conn.token);
    assert.equal(room.state.players.tok1, undefined); // old token no longer works
    assert.equal(room.handle({ token: null }, { t: "hello", token: "tok1" }, new Set([conn.token, "tok2"])).out[0].msg.reason, "room_full");
});
