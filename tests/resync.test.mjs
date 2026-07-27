/**
 * Resync unit tests — host/client × patient/observer matrix.
 *
 * Run: npm run test:resync
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
    createSyncedPair,
    loadSimAppTemplate,
    readPreservedSnapshot,
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
 * @param {Awaited<ReturnType<typeof createSyncedPair>>} pair
 * @param {ReturnType<typeof createSyncedPair> extends Promise<infer P> ? P["host"] : never} actor
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
    });
}
