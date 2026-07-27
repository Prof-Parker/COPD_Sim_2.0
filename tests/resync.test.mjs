/**
 * Resync unit tests — host/client × patient/observer matrix + desync regressions.
 *
 * Run: npm run test:resync
 */
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
    createSyncedPair,
    loadSimAppTemplate,
    readPreservedSnapshot,
    resetBrowserStubs,
    MID_SIM_FIXTURE
} from "./helpers/simapp-harness.mjs";

const LAYOUTS = [
    { name: "patient-host / observer-client", hostRole: "patient", clientRole: "observer" },
    { name: "observer-host / patient-client", hostRole: "observer", clientRole: "patient" }
];

const PRESERVE_KEYS = [
    "Energy",
    "Points",
    "Inhaler",
    "hasInhaler",
    "errandsRun",
    "visitedGrocery",
    "currentPassage",
    "passageSeq",
    "patientPlayerId",
    "observerPlayerId",
    "lobby_patient",
    "lobby_observer",
    "roomStarted"
];

function assertRoomMatchesFixture(playroom, fixture = MID_SIM_FIXTURE) {
    assert.equal(playroom.getState("roomStarted"), true);
    assert.equal(playroom.getState("currentPassage"), fixture.currentPassage);
    assert.equal(playroom.getState("passageSeq"), fixture.passageSeq);
    assert.equal(playroom.getState("Energy"), fixture.Energy);
    assert.equal(playroom.getState("Points"), fixture.Points);
    assert.equal(playroom.getState("Inhaler"), fixture.Inhaler);
    assert.equal(playroom.getState("hasInhaler"), fixture.hasInhaler);
    assert.equal(playroom.getState("errandsRun"), fixture.errandsRun);
    assert.equal(playroom.getState("visitedGrocery"), fixture.visitedGrocery);
    assert.equal(playroom.getState("lobby_patient"), true);
    assert.equal(playroom.getState("lobby_observer"), true);
}

function assertLocalSynced(ctx, fixture = MID_SIM_FIXTURE) {
    const v = ctx.state.variables;
    assert.equal(v.Energy, fixture.Energy);
    assert.equal(v.Points, fixture.Points);
    assert.equal(v.Inhaler, fixture.Inhaler);
    assert.equal(v.hasInhaler, fixture.hasInhaler);
    assert.equal(v.errandsRun, fixture.errandsRun);
    assert.equal(v.visitedGrocery, fixture.visitedGrocery);
    assert.equal(ctx.currentPassage, fixture.currentPassage);
    assert.equal(ctx.sim._lastAppliedPassageSeq, fixture.passageSeq);
}

/**
 * Soft-refresh one client: wipe local UI state, disconnect, reconnect, recover.
 * @param {Awaited<ReturnType<typeof createSyncedPair>>} pair
 * @param {*} actor
 * @param {string} expectedRole
 * @param {string} reason
 */
async function simulateReconnect(pair, actor, expectedRole, reason, options = {}) {
    const promoteOtherHost = options.promoteOtherHost !== false;
    const before = readPreservedSnapshot(actor.playroom);
    actor.wipeLocal();
    actor.playroom.disconnect({ promoteOtherHost });
    assert.equal(actor.playroom.myPlayer(), undefined);

    /* Partner view should see one fewer connected peer while this actor is down */
    const other = actor === pair.host ? pair.client : pair.host;
    delete other.sim.players[actor.playroom.id];
    delete actor.sim.players[actor.playroom.id];

    await actor.playroom.reconnect();
    if (options.restoreHost) {
        actor.playroom.becomeHost();
    }

    const hostP = pair.host.playroom.myPlayer();
    const clientP = pair.client.playroom.myPlayer();
    if (hostP && clientP) {
        const map = {
            [hostP.id]: hostP,
            [clientP.id]: clientP
        };
        actor.sim.players = map;
        other.sim.players = { ...map };
    }

    actor.sim.isPlayroomLoaded = true;
    actor.sim._hasJoinedRoom = true;

    const ok = await actor.run(() => actor.sim.recoverSession({ reason }));
    assert.equal(ok, true);
    assert.equal(actor.sim.getRole(), expectedRole);
    assert.equal(actor.currentPassage, before.room.currentPassage);
    assert.equal(actor.sim._lastAppliedPassageSeq, before.room.passageSeq);
    assert.equal(actor.sim._recovering, false);
    assert.equal(actor.sim._passageCommitInFlight, false);

    const after = readPreservedSnapshot(actor.playroom, actor.state);
    for (const key of PRESERVE_KEYS) {
        assert.equal(
            after.room[key],
            before.room[key],
            `room.${key} changed after recover (${before.room[key]} → ${after.room[key]})`
        );
    }
    assertLocalSynced(actor, {
        currentPassage: before.room.currentPassage,
        passageSeq: before.room.passageSeq,
        Energy: before.room.Energy,
        Points: before.room.Points,
        Inhaler: before.room.Inhaler,
        hasInhaler: before.room.hasInhaler,
        errandsRun: before.room.errandsRun,
        visitedGrocery: before.room.visitedGrocery
    });
}

describe("SimApp load", () => {
    it("extracts SimApp template from StoryScript", () => {
        const template = loadSimAppTemplate();
        assert.equal(typeof template.recoverSession, "function");
        assert.equal(typeof template.commitPassageChange, "function");
        assert.equal(typeof template.restoreRoleFromRoom, "function");
        assert.equal(typeof template.isRejoinAttempt, "function");
        assert.equal(typeof template.restoreRoomHashBeforeConnect, "function");
        assert.ok(Array.isArray(template.STATE_KEYS));
        assert.equal(template.RECONNECT_GRACE_MS, 600000);
    });
});

for (const layout of LAYOUTS) {
    describe(`resync: ${layout.name}`, () => {
        /** @type {Awaited<ReturnType<typeof createSyncedPair>>} */
        let pair;

        before(async () => {
            pair = await createSyncedPair({
                hostRole: layout.hostRole,
                clientRole: layout.clientRole
            });
            assertRoomMatchesFixture(pair.host.playroom);
        });

        it("seeds mid-sim state on both clients", async () => {
            assertLocalSynced(pair.host);
            assertLocalSynced(pair.client);
            assert.equal(pair.host.sim.getRole(), layout.hostRole);
            assert.equal(pair.client.sim.getRole(), layout.clientRole);
            assert.equal(pair.host.playroom.isHost(), true);
            assert.equal(pair.client.playroom.isHost(), false);
        });

        it("patient reconnects and preserves simulation state", async () => {
            pair = await createSyncedPair({
                hostRole: layout.hostRole,
                clientRole: layout.clientRole
            });
            const patient = pair.getPatient();
            await simulateReconnect(pair, patient, "patient", "connect");
        });

        it("observer reconnects after autolock (visibility) and preserves state", async () => {
            pair = await createSyncedPair({
                hostRole: layout.hostRole,
                clientRole: layout.clientRole
            });
            const observer = pair.getObserver();
            await simulateReconnect(pair, observer, "observer", "visibility");
        });

        it("host reconnect does not wipe room mid-sim", async () => {
            pair = await createSyncedPair({
                hostRole: layout.hostRole,
                clientRole: layout.clientRole
            });
            const before = readPreservedSnapshot(pair.host.playroom);
            await simulateReconnect(pair, pair.host, layout.hostRole, "connect", {
                promoteOtherHost: false,
                restoreHost: true
            });
            const after = readPreservedSnapshot(pair.host.playroom);
            assert.equal(after.room.Energy, before.room.Energy);
            assert.equal(after.room.Points, before.room.Points);
            assert.equal(after.room.currentPassage, before.room.currentPassage);
            assert.equal(after.room.passageSeq, before.room.passageSeq);
            assert.equal(after.room.roomStarted, true);
            /* Defaults would be Energy 10 / Points 0 / Role_Selection */
            assert.notEqual(after.room.Energy, 10);
            assert.notEqual(after.room.currentPassage, "Role_Selection");
            assert.equal(pair.host.playroom.isHost(), true);
        });

        it("client reconnect while host stays preserves room and host view", async () => {
            pair = await createSyncedPair({
                hostRole: layout.hostRole,
                clientRole: layout.clientRole
            });
            const hostBeforePassage = pair.host.currentPassage;
            const hostBeforeEnergy = pair.host.state.variables.Energy;
            const roomBefore = readPreservedSnapshot(pair.client.playroom);

            await simulateReconnect(pair, pair.client, layout.clientRole, "connect");

            assert.equal(pair.host.currentPassage, hostBeforePassage);
            assert.equal(pair.host.state.variables.Energy, hostBeforeEnergy);
            const roomAfter = readPreservedSnapshot(pair.client.playroom);
            for (const key of PRESERVE_KEYS) {
                assert.equal(roomAfter.room[key], roomBefore.room[key]);
            }
        });

        it("after both recover, patient advance bumps passageSeq and observer tethers", async () => {
            pair = await createSyncedPair({
                hostRole: layout.hostRole,
                clientRole: layout.clientRole
            });
            const patient = pair.getPatient();
            const observer = pair.getObserver();

            await simulateReconnect(pair, patient, "patient", "connect");
            await simulateReconnect(pair, observer, "observer", "visibility");

            const seqBefore = patient.playroom.getState("passageSeq");

            await patient.run(async () => {
                patient.sim._allowAdvanceWithoutPartner = true;
                const ok = await patient.sim.commitPassageChange("Hallway_Out", {
                    resetEval: true,
                    playLocal: true
                });
                assert.equal(ok, true);
            });

            assert.equal(patient.playroom.getState("currentPassage"), "Hallway_Out");
            assert.equal(patient.playroom.getState("passageSeq"), seqBefore + 1);
            assert.equal(patient.currentPassage, "Hallway_Out");

            await observer.run(() => {
                observer.sim.tetherToPassage();
            });

            assert.equal(observer.currentPassage, "Hallway_Out");
            assert.equal(observer.sim._lastAppliedPassageSeq, seqBefore + 1);
        });

        it("blocks patient advance when partner disconnected; Continue anyway overrides", async () => {
            pair = await createSyncedPair({
                hostRole: layout.hostRole,
                clientRole: layout.clientRole
            });
            const patient = pair.getPatient();
            const observer = pair.getObserver();

            observer.playroom.disconnect({ promoteOtherHost: true });
            delete patient.sim.players[observer.playroom.id];

            await patient.run(() => {
                patient.sim._allowAdvanceWithoutPartner = false;
                assert.equal(patient.sim.hasPartnerConnected(), false);
                assert.equal(patient.sim.canPatientAdvance(), false);
                patient.sim._allowAdvanceWithoutPartner = true;
                assert.equal(patient.sim.canPatientAdvance(), true);
            });
        });

        it("repeated soft refresh on host still preserves mid-sim and clears sync locks", async () => {
            pair = await createSyncedPair({
                hostRole: layout.hostRole,
                clientRole: layout.clientRole
            });
            await simulateReconnect(pair, pair.host, layout.hostRole, "connect", {
                promoteOtherHost: false,
                restoreHost: true
            });
            await simulateReconnect(pair, pair.host, layout.hostRole, "connect", {
                promoteOtherHost: false,
                restoreHost: true
            });
            assertRoomMatchesFixture(pair.host.playroom);
            assert.equal(pair.host.sim._recovering, false);
            assert.equal(pair.host.sim._passageCommitInFlight, false);
        });
    });
}

describe("desync regressions", () => {
    beforeEach(() => {
        resetBrowserStubs();
    });

    it("roomCodeToHash uses Playroom R-prefix (#r=R…)", () => {
        const sim = Object.assign({}, loadSimAppTemplate());
        assert.equal(sim.roomCodeToHash("8PVM"), "#r=R8PVM");
        assert.equal(sim.roomCodeToHash("R8PVM"), "#r=R8PVM");
        assert.equal(sim.parseStoredRoomCode("R8PVM"), "8PVM");
        assert.equal(sim.parseStoredRoomCode("#r=R8PVM"), "8PVM");
    });

    it("restoreRoomHashBeforeConnect rebuilds #r= from localStorage when hash was stripped", async () => {
        resetBrowserStubs({ hash: "", storage: { simRoomCode: "8PVM" } });
        const pair = await createSyncedPair({
            hostRole: "patient",
            clientRole: "observer"
        });
        await pair.host.run(() => {
            assert.equal(pair.host.sim.isRejoinAttempt(), true);
            const result = pair.host.sim.restoreRoomHashBeforeConnect();
            assert.equal(result.restored, true);
            assert.equal(result.hash, "#r=R8PVM");
            assert.equal(globalThis.location.hash, "#r=R8PVM");
        });
    });

    it("persistRoomJoinHint keeps hash on host after join so refresh can rejoin", async () => {
        resetBrowserStubs({ hash: "" });
        const pair = await createSyncedPair({
            hostRole: "patient",
            clientRole: "observer"
        });
        await pair.host.run(() => {
            pair.host.sim.persistRoomJoinHint("TESTROOM");
            assert.equal(globalThis.localStorage.getItem("simRoomCode"), "TESTROOM");
            assert.equal(globalThis.location.hash, "#r=RTESTROOM");
            assert.equal(pair.host.sim.getInviteUrl().includes("#r=RTESTROOM"), true);
        });
    });

    it("host recover with snapshot lag does not wipe mid-sim when rejoining", async () => {
        resetBrowserStubs({ hash: "#r=RTESTROOM", storage: { simRoomCode: "TESTROOM" } });
        const pair = await createSyncedPair({
            hostRole: "patient",
            clientRole: "observer"
        });
        const before = readPreservedSnapshot(pair.host.playroom);
        let initCalls = 0;
        const origInit = pair.host.sim.initRoomState.bind(pair.host.sim);
        pair.host.sim.initRoomState = function () {
            initCalls += 1;
            return origInit();
        };

        pair.host.wipeLocal();
        pair.host.playroom.disconnect({ promoteOtherHost: false });
        await pair.host.playroom.reconnect();
        pair.host.playroom.becomeHost();
        pair.host.sim.isPlayroomLoaded = true;
        pair.host.sim._hasJoinedRoom = true;

        /* Simulate Playroom returning empty state briefly after refresh */
        pair.room.setStateOpaque(true);
        assert.equal(pair.host.playroom.getState("currentPassage"), undefined);
        assert.equal(pair.host.sim.isRoomActive(), false);

        await pair.host.run(async () => {
            assert.equal(pair.host.sim.isRejoinAttempt(), true);
            const ok = await pair.host.sim.recoverSession({ reason: "connect" });
            assert.equal(ok, true);
        });

        assert.equal(initCalls, 0, "initRoomState must not run on rejoin during snapshot lag");
        pair.room.setStateOpaque(false);

        const after = readPreservedSnapshot(pair.host.playroom);
        for (const key of PRESERVE_KEYS) {
            assert.equal(after.room[key], before.room[key], `room.${key} wiped on laggy rejoin`);
        }
        assert.notEqual(after.room.currentPassage, "Role_Selection");
    });

    it("fresh host without rejoin hint still initializes empty room", async () => {
        resetBrowserStubs({ hash: "" });
        const pair = await createSyncedPair({
            hostRole: "patient",
            clientRole: "observer"
        });
        await pair.host.run(() => {
            pair.host.playroom.setState("roomStarted", false);
            pair.host.playroom.setState("currentPassage", "Role_Selection");
            pair.host.playroom.setState("passageSeq", 0);
            pair.host.playroom.setState("lobby_patient", false);
            pair.host.playroom.setState("lobby_observer", false);
            pair.host.playroom.setState("patientPlayerId", "");
            pair.host.playroom.setState("observerPlayerId", "");
            assert.equal(pair.host.sim.isRejoinAttempt(), false);
            assert.equal(pair.host.sim.isRoomActive(), false);
            pair.host.sim.initRoomState();
            assert.equal(pair.host.playroom.getState("roomStarted"), true);
            assert.equal(pair.host.playroom.getState("currentPassage"), "Role_Selection");
        });
    });

    it("broadcastLobbyAdvance does not re-commit Simulation_Hub mid-sim", async () => {
        const pair = await createSyncedPair({
            hostRole: "patient",
            clientRole: "observer"
        });
        const seqBefore = pair.host.playroom.getState("passageSeq");
        const passageBefore = pair.host.playroom.getState("currentPassage");

        await pair.host.run(async () => {
            assert.equal(pair.host.sim.checkReadyState(), true);
            pair.host.sim.broadcastLobbyAdvance();
            await new Promise((r) => setTimeout(r, 50));
        });

        assert.equal(pair.host.playroom.getState("passageSeq"), seqBefore);
        assert.equal(pair.host.playroom.getState("currentPassage"), passageBefore);
        assert.equal(pair.host.sim._passageCommitInFlight, false);
        assert.equal(pair.host.sim._recovering, false);
    });

    it("restores role from localStorage hint when player role state is empty after refresh", async () => {
        resetBrowserStubs({
            hash: "#r=RTESTROOM",
            storage: { simRoomCode: "TESTROOM", simRole_TESTROOM: "patient" }
        });
        const pair = await createSyncedPair({
            hostRole: "patient",
            clientRole: "observer"
        });
        const me = pair.host.playroom.myPlayer();
        me.setState("role", "");
        pair.host.wipeLocal();
        pair.host.sim.isPlayroomLoaded = true;
        pair.host.sim._hasJoinedRoom = true;

        await pair.host.run(async () => {
            const role = pair.host.sim.restoreRoleFromRoom();
            assert.equal(role, "patient");
            assert.equal(pair.host.sim.getRole(), "patient");
            assert.equal(me.getState("role"), "patient");
        });
    });

    it("connect uses skipLobby and skips init wipe when rejoining active room", async () => {
        resetBrowserStubs({
            hash: "#r=RTESTROOM",
            storage: { simRoomCode: "TESTROOM", simRole_TESTROOM: "patient" }
        });
        const pair = await createSyncedPair({
            hostRole: "patient",
            clientRole: "observer"
        });
        let initCalls = 0;
        pair.host.sim.initRoomState = function () {
            initCalls += 1;
        };

        pair.host.wipeLocal();
        pair.host.playroom.disconnect({ promoteOtherHost: false });
        pair.host.sim.isPlayroomLoaded = true;
        pair.host.sim._hasJoinedRoom = false;
        pair.host.sim._connectInFlight = false;
        pair.host.sim._playerHandlersRegistered = true;
        pair.host.sim._wakeHandlersRegistered = true;
        pair.host.sim.PASSAGE_COMMIT_TIMEOUT_MS = 50;
        pair.host.sim.startSyncLoop = function () {};
        pair.host.sim.showInviteModal = function () {};
        pair.host.sim.wireDevCaptionControls = function () {};
        pair.host.sim.waitForRoomSnapshot = async function () {
            return {
                ready: true,
                active: true,
                timedOut: false,
                currentPassage: MID_SIM_FIXTURE.currentPassage,
                roomStarted: true
            };
        };

        await pair.host.run(async () => {
            pair.host.playroom.becomeHost();
            await pair.host.sim.connect();
        });

        assert.equal(pair.host.playroom.lastInsertCoinOptions.skipLobby, true);
        assert.equal(initCalls, 0);
        assert.equal(pair.host.sim._recovering, false);
        assert.equal(pair.host.sim._passageCommitInFlight, false);
        assert.equal(pair.host.sim._connectInFlight, false);
        assertRoomMatchesFixture(pair.host.playroom);
    });

    it("second connect while in-flight is ignored (no overlapping recover)", async () => {
        const pair = await createSyncedPair({
            hostRole: "patient",
            clientRole: "observer"
        });
        pair.host.sim._connectInFlight = true;
        let recoverCalls = 0;
        const origRecover = pair.host.sim.recoverSession.bind(pair.host.sim);
        pair.host.sim.recoverSession = async function (opts) {
            recoverCalls += 1;
            return origRecover(opts);
        };

        await pair.host.run(async () => {
            await pair.host.sim.connect();
        });

        assert.equal(recoverCalls, 0);
        assert.equal(pair.host.sim._connectInFlight, true);
    });
});
