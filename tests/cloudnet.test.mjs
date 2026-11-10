/**
 * CloudNet client tests — the real client from the .twee against the real room-core rules.
 *
 * Run: npm run test:cloudnet
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRoom, loadCloudNetFactory } from "./helpers/cloudnet-mock.mjs";
import { createSyncedPair } from "./helpers/simapp-harness.mjs";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("CloudNet client", () => {
    it("is extracted from StoryScript", () => {
        assert.equal(typeof loadCloudNetFactory(), "function");
    });

    it("cf resync pairs really run on CloudNet", async () => {
        const pair = await createSyncedPair({ hostRole: "patient", clientRole: "observer", backend: "cf" });
        assert.equal(pair.host.playroom.backend, "cf");
        assert.equal(pair.client.playroom.backend, "cf");
        assert.equal(pair.host.playroom.id, "p1");
        assert.equal(pair.client.playroom.id, "p2");
    });

    it("writes are visible locally at once and reach the partner after the batch flushes", async () => {
        const room = createRoom();
        const a = await room.createClientView();
        const b = await room.createClientView();
        a.setState("Energy", 7);
        a.setState("Points", 4);
        assert.equal(a.getState("Energy"), 7);
        assert.equal(b.getState("Energy"), undefined);
        await tick();
        assert.equal(b.getState("Energy"), 7);
        assert.equal(b.getState("Points"), 4);
        assert.equal(room.core.state.game.Points, 4);
    });

    it("a refreshed page (new client, same storage) gets its role back", async () => {
        const room = createRoom();
        const a = await room.createClientView();
        await room.createClientView();
        a.myPlayer().setState("role", "observer");
        await tick();
        assert.equal(room.core.state.roles.observer !== null, true);
        a.disconnect();
        assert.equal(a.myPlayer(), undefined);
        await a.reconnect();
        assert.equal(a.myPlayer().getState("role"), "observer");
        assert.equal(a.id, "p1");
    });

    it("onReconnect fires when the socket comes back, not on the first connect", async () => {
        const room = createRoom();
        const a = await room.createClientView();
        let reconnects = 0;
        a.onReconnect(() => {
            reconnects += 1;
        });
        await room.createClientView();
        assert.equal(reconnects, 0);
        a.disconnect();
        assert.equal(reconnects, 0);
        await a.reconnect();
        assert.equal(reconnects, 1);
        assert.equal(a.connected, true);
    });

    it("a refused role claim falls back to the server's answer", async () => {
        const room = createRoom();
        const a = await room.createClientView();
        const b = await room.createClientView();
        a.myPlayer().setState("role", "patient");
        await tick();
        b.myPlayer().setState("role", "patient");
        assert.equal(b.myPlayer().getState("role"), "patient"); // optimistic
        await tick();
        assert.equal(b.myPlayer().getState("role"), ""); // refused: role_taken
        assert.equal(b.lastError, "role_taken");
    });

    it("host is the first player; it moves to the partner while the first is offline", async () => {
        const room = createRoom();
        const a = await room.createClientView();
        const b = await room.createClientView();
        assert.equal(a.isHost(), true);
        assert.equal(b.isHost(), false);
        a.disconnect();
        await tick();
        assert.equal(b.isHost(), true);
        await a.reconnect();
        await tick();
        assert.equal(a.isHost(), true);
        assert.equal(b.isHost(), false);
    });

    it("onPlayerJoin and onQuit fire as the partner comes and goes", async () => {
        const room = createRoom();
        const a = await room.createClientView();
        const joined = [];
        let quits = 0;
        a.onPlayerJoin((p) => {
            joined.push(p.id);
            p.onQuit(() => {
                quits += 1;
            });
        });
        assert.deepEqual(joined, ["p1"]); // self, already connected
        const b = await room.createClientView();
        await tick();
        assert.deepEqual(joined, ["p1", "p2"]);
        b.disconnect();
        await tick();
        assert.equal(quits, 1);
        await b.reconnect();
        await tick();
        assert.deepEqual(joined, ["p1", "p2", "p2"]);
    });

    it("writes made while offline are sent after reconnecting", async () => {
        const room = createRoom();
        const a = await room.createClientView();
        const b = await room.createClientView();
        a.disconnect();
        a.setState("hasToy", true);
        await tick();
        assert.equal(b.getState("hasToy"), undefined);
        await a.reconnect();
        await tick();
        assert.equal(b.getState("hasToy"), true);
    });

    it("inc from both players at once counts both", async () => {
        const room = createRoom();
        const a = await room.createClientView();
        const b = await room.createClientView();
        a.inc("Points", 1);
        b.inc("Points", 1);
        await tick();
        assert.equal(a.getState("Points"), 2);
        assert.equal(b.getState("Points"), 2);
    });

    it("a third device is refused with room_full", async () => {
        const room = createRoom();
        await room.createClientView();
        await room.createClientView();
        await assert.rejects(room.createClientView(), /room_full/);
    });

    it("a student on a new device can take back their offline seat (and role)", async () => {
        const room = createRoom();
        const a = await room.createClientView();
        const b = await room.createClientView();
        a.myPlayer().setState("role", "patient");
        await tick();
        a.disconnect(); // old phone gone
        await tick();
        const newPhone = await room.createClientView().catch((e) => e);
        assert.match(String(newPhone), /room_full/);
        // Same room, fresh device: takeover
        const c = await room.createClientView({ takeover: true });
        assert.equal(c.myPlayer().getState("role"), "patient");
        assert.equal(c.id, "p1");
        assert.equal(b.isHost(), false);
        await tick();
        assert.equal(c.isHost(), true);
    });

    it("invite link carries the session and pair codes", async () => {
        const room = createRoom({ session: "REGN-1109", pair: "07" });
        const a = await room.createClientView();
        assert.equal(a.getRoomCode(), "REGN-1109-07");
        assert.equal(a.inviteUrl(), "http://test/?s=REGN-1109&p=07");
        assert.equal(a.isRejoin(), true);
    });

    it("a link without a session code is refused before connecting", async () => {
        const createCloudNet = loadCloudNetFactory();
        const net = createCloudNet({
            WebSocket: class {
                constructor() {
                    throw new Error("should not open a socket");
                }
            },
            storage: null,
            location: { search: "", protocol: "http:", host: "test", pathname: "/", hash: "" },
            history: { replaceState() {} },
            setTimeout: () => 0,
            clearTimeout: () => {},
            listenVisibility: false,
        });
        await assert.rejects(net.insertCoin(), /session_required/);
    });

    it("a session link with no pair code makes one and writes it into the URL", () => {
        const createCloudNet = loadCloudNetFactory();
        let replaced = "";
        const net = createCloudNet({
            storage: null,
            location: { search: "?s=regn-1109&net=cf", protocol: "http:", host: "test", pathname: "/", hash: "" },
            history: { replaceState: (_s, _t, url) => (replaced = url) },
            setTimeout: () => 0,
            clearTimeout: () => {},
            listenVisibility: false,
        });
        assert.equal(net.session, "REGN-1109");
        assert.match(net.pair, /^[A-Z0-9]{4}$/);
        assert.equal(replaced, `/?s=regn-1109&net=cf&p=${net.pair}`);
    });
});
