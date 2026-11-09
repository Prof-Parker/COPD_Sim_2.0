import { test } from "node:test";
import assert from "node:assert/strict";
import { RoomCore, cleanName, routeMessages } from "../src/room-core.js";

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
    assert.deepEqual(out[0].msg.snapshot.game, { Points: 3, hasToy: true });
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
    assert.equal(room.state.passageSeq, 1);
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
