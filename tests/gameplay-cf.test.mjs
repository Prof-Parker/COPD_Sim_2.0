/**
 * Gameplay on the Cloudflare backend: the real SimApp + CloudNet against the real room rules.
 * Covers the paths that used to depend on "host" (routers, errands drain, timer, Try Again).
 *
 * Run: npm run test:gameplay
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSyncedPair, MID_SIM_FIXTURE } from "./helpers/simapp-harness.mjs";

const tick = () => new Promise((r) => setTimeout(r, 0));

async function cfPair(roomOptions = {}) {
    const pair = await createSyncedPair({
        hostRole: "observer", // the observer joined first: proves nothing depends on the host
        clientRole: "patient",
        backend: "cf",
        roomOptions,
    });
    const patient = pair.getPatient();
    const observer = pair.getObserver();
    patient.sim._allowAdvanceWithoutPartner = true;
    return { pair, patient, observer };
}

describe("gameplay on Cloudflare", () => {
    it("router: one shared roll, both devices end on the same passage, room moves once", async () => {
        const { patient, observer } = await cfPair({ random: () => 0.7 }); // 0.7 → roll 2
        await patient.run(async () => {
            assert.equal(await patient.sim.goToSharedPassage("Grocery_Store_Router"), true);
        });
        const routerSeq = patient.playroom.getState("passageSeq");
        await observer.run(() => observer.sim.tetherToPassage());
        assert.equal(observer.currentPassage, "Grocery_Store_Router");

        const targets = ["Grocery_Store_1", "Grocery_Store_2"];
        const dest = await patient.run(() =>
            patient.sim._routeByRollNow("groceryRoll", targets, "visitedGrocery", "Grocery_Store_Router", routerSeq)
        );
        assert.equal(dest, "Grocery_Store_2");
        /* Observer's router fires late: it must follow, not roll again */
        const late = await observer.run(() =>
            observer.sim._routeByRollNow("groceryRoll", targets, "visitedGrocery", "Grocery_Store_Router", routerSeq)
        );
        await tick();
        assert.equal(late, null);
        assert.equal(observer.currentPassage, "Grocery_Store_2");
        assert.equal(patient.currentPassage, "Grocery_Store_2");
        assert.equal(patient.playroom.getState("passageSeq"), routerSeq + 1);
        assert.equal(observer.playroom.getState("groceryRoll"), 2);
        assert.equal(observer.playroom.getState("visitedGrocery"), true);
    });

    it("router: when both roll at the same visit they get the same number", async () => {
        const rolls = [0.1, 0.9];
        const { patient, observer } = await cfPair({ random: () => rolls.shift() });
        await patient.run(() => patient.sim.goToSharedPassage("Grocery_Store_Router"));
        await observer.run(() => observer.sim.tetherToPassage());
        await observer.run(() => observer.playroom.roll("groceryRoll", 2));
        await patient.run(() => patient.playroom.roll("groceryRoll", 2));
        await tick();
        assert.equal(patient.playroom.getState("groceryRoll"), 1);
        assert.equal(observer.playroom.getState("groceryRoll"), 1);
    });

    it("Whistle_Stop_In drains Energy by errandsRun² once, even though both devices render it", async () => {
        const { patient, observer } = await cfPair();
        await patient.run(async () => {
            patient.sim.setVal("Energy", 12, true);
            patient.sim.setVal("errandsRun", 3, true);
            await patient.sim.goToSharedPassage("Whistle_Stop_In");
            patient.sim.applyErrandsDrain();
            await tick();
        });
        await observer.run(async () => {
            observer.sim.tetherToPassage();
            observer.sim.applyErrandsDrain();
            await tick();
        });
        assert.equal(patient.playroom.getState("Energy"), 3);
        assert.equal(observer.playroom.getState("Energy"), 3);
    });

    it("counter updates from both players all count (atomic on the server)", async () => {
        const { patient, observer } = await cfPair();
        const start = MID_SIM_FIXTURE.Points;
        await observer.run(() => {
            observer.sim.applyPointsDelta(5);
            observer.sim.incrementBehavior("pursedLip", "satAndRested");
        });
        await patient.run(() => {
            patient.sim.applyPointsDelta(2);
            patient.sim.applyPatientChoiceStateOps([{ op: "add", key: "pursedLip", value: 1 }]);
        });
        await tick();
        assert.equal(patient.playroom.getState("Points"), start + 7);
        assert.equal(observer.playroom.getState("Points"), start + 7);
        assert.equal(observer.playroom.getState("pursedLip"), 2);
        assert.equal(observer.playroom.getState("satAndRested"), 1);
    });

    it("Energy is clamped to 0..15 on the server and schedules game over at 0", async () => {
        const { observer } = await cfPair();
        let scheduled = null;
        observer.sim.scheduleGameOver = (target) => {
            scheduled = target;
        };
        await observer.run(() => observer.sim.applyEnergyDelta(-50));
        await tick();
        assert.equal(observer.playroom.getState("Energy"), 0);
        assert.equal(scheduled, "Game_Over_Energy");
    });

    it("room clock: shared, paused on game over, stopped at the debrief", async () => {
        const { pair, patient, observer } = await cfPair();
        await patient.run(async () => {
            patient.sim.resetSimulationForStart();
            await tick();
        });
        pair.room.advance(65_000);
        await patient.run(() => patient.sim.goToSharedPassage("Hallway_Out"));
        await observer.run(() => {
            const t = observer.sim.getElapsedParts();
            assert.equal(t.totalMinutes, 1);
            assert.equal(t.seconds, 5);
            assert.equal(observer.sim.formatElapsed(), "00:01:05");
        });
        await patient.run(() => patient.sim.goToSharedPassage("Game_Over_Energy"));
        pair.room.advance(30_000); // time on Game Over does not count
        await observer.run(async () => {
            observer.sim.tetherToPassage();
            observer.sim.prepareFinalReport(false);
            assert.equal(await observer.sim.goToSharedPassage("Final_Report"), true);
        });
        pair.room.advance(120_000); // reading the debrief does not count either
        await patient.run(() => {
            assert.equal(patient.sim.formatElapsed(), "00:01:05");
            assert.equal(patient.playroom.getState("win"), false);
        });
    });

    it("Try Again from either player: new attempt, fresh stats, both back at the hub, double press is safe", async () => {
        const { pair, patient, observer } = await cfPair();
        await observer.run(() => observer.sim.goToSharedPassage("Final_Report"));
        await patient.run(() => patient.sim.syncFromPlayroom());
        pair.room.advance(10_000);

        await observer.run(async () => {
            observer.sim.restartFromDebrief();
            await tick();
            await tick();
        });
        assert.equal(observer.currentPassage, "Simulation_Hub");

        /* Patient presses Try Again too (before noticing) — must not start a third attempt */
        await patient.run(async () => {
            patient.sim.restartFromDebrief();
            await tick();
            await tick();
        });
        await patient.run(() => patient.sim.tetherToPassage());

        assert.equal(patient.playroom.attempt(), 2);
        assert.equal(patient.currentPassage, "Simulation_Hub");
        assert.equal(patient.playroom.getState("Energy"), 10);
        assert.equal(patient.playroom.getState("Points"), 0);
        assert.equal(patient.playroom.getState("lobby_patient"), true);
        assert.equal(patient.sim.getRole(), "patient");
        assert.equal(observer.sim.getRole(), "observer");
        assert.equal(patient.sim.formatElapsed(), "00:00:00");
    });
});
