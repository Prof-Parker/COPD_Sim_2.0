/**
 * Static passage-flow validator for COPD simulation .twee
 * Usage: node scripts/validate-flow.mjs [path/to/story.twee]
 */
import path from "path";
import { fileURLToPath } from "url";
import { loadStory, SYSTEM_PASSAGES } from "./parse-twee.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Playroom lobby navigation (StoryScript — not in passage macros) */
const LOBBY_EDGES = [
    ["Start", "Role_Selection"],
    ["Role_Selection", "Waiting_Room"],
    ["Role_Selection", "Simulation_Hub"],
    ["Waiting_Room", "Simulation_Hub"],
    ["Waiting_Room", "Role_Selection"],
];

const TERMINAL_PASSAGES = new Set([
    "Final_Report",
    "Game_Over_Energy",
    "Game_Over_Inhaler",
]);

const ROUTER_PASSAGES = new Set([
    "Grocery_Store_Router",
    "Pharmacy_Router",
    "Toy_Store_Router",
    "Wildcard_Router",
]);

const ERRAND_BUTTONS = [
    { flag: "visitedGrocery", target: "Grocery_Store_Router" },
    { flag: "visitedPharmacy", target: "Pharmacy_Router" },
    { flag: "visitedClinic", target: "Pulmonary_Clinic" },
    { flag: "visitedToyStore", target: "Toy_Store_Router" },
];

const ENTRY_POINTS = [
    "Start",
    "Good_Morning_Mr._Holland",
    "Wildcard_Router",
    "Whistle_Stop_Out",
    "Game_Over_Energy",
    "Game_Over_Inhaler",
];

/**
 * @typedef {object} FlowState
 * @property {number} visitedGrocery
 * @property {number} visitedPharmacy
 * @property {number} visitedClinic
 * @property {number} visitedToyStore
 * @property {number} wildRoll
 * @property {number} groceryRoll
 * @property {number} pharmacyRoll
 * @property {number} toyStoreRoll
 */

/** @returns {FlowState} */
function initialState() {
    return {
        visitedGrocery: 0,
        visitedPharmacy: 0,
        visitedClinic: 0,
        visitedToyStore: 0,
        wildRoll: 0,
        groceryRoll: 0,
        pharmacyRoll: 0,
        toyStoreRoll: 0,
    };
}

/** @param {FlowState} s */
function stateKey(s) {
    return [
        s.visitedGrocery,
        s.visitedPharmacy,
        s.visitedClinic,
        s.visitedToyStore,
        s.wildRoll,
        s.groceryRoll,
        s.pharmacyRoll,
        s.toyStoreRoll,
    ].join(":");
}

/**
 * @param {Map<string, object>} passages
 * @param {Set<string>} passageNames
 */
function validatePassages(passages, passageNames) {
    const failures = [];
    const warnings = [];
    let passCount = 0;

    for (const [name, model] of passages) {
        if (model.isSystem) {
            continue;
        }

        passCount++;

        const { patient, observer, isRouter, isTerminal, tags } = model;
        const isGameplay =
            tags.some((t) => t.includes("simulation") || t.includes("briefing")) ||
            (!model.isSystem && !isTerminal);

        for (const target of patient.allTargets) {
            if (!passageNames.has(target)) {
                failures.push({
                    type: "broken-target",
                    passage: name,
                    message: `Broken navigation target "${target}"`,
                });
            }
        }

        for (const bad of patient.malformedNext) {
            failures.push({
                type: "malformed-macro",
                passage: name,
                message: `Malformed <<patient-next>>: ${bad}`,
            });
        }

        if (isTerminal) {
            if (name === "Final_Report") {
                passCount++;
            }
            if (name.startsWith("Game_Over_") && !patient.linkTargets.includes("Final_Report")) {
                failures.push({
                    type: "missing-debrief",
                    passage: name,
                    message: "Game Over passage missing debrief link to Final_Report",
                });
            }
            continue;
        }

        const hasGameplayTag = tags.some(
            (t) =>
                t === "simulation" ||
                t.includes("activity") ||
                t.includes("briefing")
        );

        if (
            hasGameplayTag &&
            !isRouter &&
            patient.allTargets.length === 0 &&
            model.autoTargets.length === 0
        ) {
            failures.push({
                type: "dead-end",
                passage: name,
                message: "Patient branch has no navigation out",
            });
        }

        if (patient.hasChoices && !patient.skipEval && !observer.hasDynamicEval) {
            failures.push({
                type: "eval-deadlock",
                passage: name,
                message:
                    "Patient choices require Observer eval but passage has no <<dynamic-eval>>",
            });
        }

        if (
            patient.hasChoices &&
            !patient.hasNext &&
            patient.choiceTargets.length === 0
        ) {
            failures.push({
                type: "choices-without-exit",
                passage: name,
                message:
                    "<<patient-choices>> without <<patient-next>> and no field-6 next-passage overrides",
            });
        }

        if (
            patient.hasNext &&
            !patient.hasChoices &&
            !observer.hasDynamicEval &&
            hasGameplayTag &&
            !isRouter &&
            tags.some((t) => t.includes("activity"))
        ) {
            passCount++;
        }

        if (
            patient.hasNext &&
            !patient.hasChoices &&
            observer.hasDynamicEval &&
            !isRouter
        ) {
            warnings.push({
                type: "early-advance",
                passage: name,
                message:
                    "Patient has <<patient-next>> only; Observer has <<dynamic-eval>> — runtime may not block Patient until eval (Playroom sync only after choice stations)",
            });
        }
    }

    return { failures, warnings, passCount };
}

/**
 * @param {string} passageName
 * @param {object} model
 * @param {FlowState} state
 * @returns {{ targets: string[], nextStates: FlowState[] }}
 */
function getOutgoing(passageName, model, state) {
    const targets = [];
    const nextStates = [];

    const push = (target, stateUpdate) => {
        targets.push(target);
        nextStates.push({ ...state, ...stateUpdate });
    };

    if (LOBBY_EDGES.some(([from, to]) => from === passageName && to)) {
        for (const [from, to] of LOBBY_EDGES) {
            if (from === passageName) {
                push(to, {});
            }
        }
        return { targets, nextStates };
    }

    if (passageName === "Errands_Hub") {
        for (const btn of ERRAND_BUTTONS) {
            if (!state[btn.flag]) {
                push(btn.target, { [btn.flag]: 1 });
            }
        }
        push("Whistle_Stop_In", {});
        return { targets, nextStates };
    }

    if (passageName === "Wildcard_Router") {
        for (let roll = 1; roll <= 6; roll++) {
            const wildTarget = model.autoTargets[roll - 1] || inferWildcardTarget(model, roll);
            if (wildTarget) {
                push(wildTarget, { wildRoll: roll });
            }
        }
        return { targets, nextStates };
    }

    if (passageName === "Grocery_Store_Router") {
        push("Grocery_Store_1", { groceryRoll: 1, visitedGrocery: 1 });
        push("Grocery_Store_2", { groceryRoll: 2, visitedGrocery: 1 });
        return { targets, nextStates };
    }

    if (passageName === "Pharmacy_Router") {
        push("Pharmacy_1", { pharmacyRoll: 1, visitedPharmacy: 1 });
        push("Pharmacy_2", { pharmacyRoll: 2, visitedPharmacy: 1 });
        return { targets, nextStates };
    }

    if (passageName === "Toy_Store_Router") {
        push("Toy_Store_1", { toyStoreRoll: 1, visitedToyStore: 1 });
        push("Toy_Store_2", { toyStoreRoll: 2, visitedToyStore: 1 });
        return { targets, nextStates };
    }

    if (model.isRouter && model.autoTargets.length) {
        for (const t of model.autoTargets) {
            push(t, {});
        }
        return { targets, nextStates };
    }

    const { patient } = model;

    for (const t of patient.buttonTargets) {
        push(t, {});
    }
    for (const t of patient.linkTargets) {
        push(t, {});
    }
    for (const t of patient.choiceTargets) {
        push(t, {});
    }
    for (const t of patient.nextTargets) {
        push(t, {});
    }

    return { targets, nextStates };
}

/**
 * @param {object} model
 * @param {number} roll
 */
function inferWildcardTarget(model, roll) {
    const names = [
        "Wildcard1",
        "Wildcard2",
        "Wildcard3",
        "Wildcard4",
        "Wildcard5",
        "Wildcard6",
    ];
    return model.autoTargets[roll - 1] || names[roll - 1];
}

/**
 * @param {Map<string, object>} passages
 * @param {Set<string>} passageNames
 */
function walkGraph(passages, passageNames) {
    const reachable = new Set();
    /** @type {Array<{ passage: string, state: FlowState }>} */
    const queue = [];
    const visited = new Set();

    for (const entry of ENTRY_POINTS) {
        if (passageNames.has(entry)) {
            queue.push({ passage: entry, state: initialState() });
        }
    }

    while (queue.length) {
        const { passage, state } = queue.shift();
        const key = `${passage}|${stateKey(state)}`;
        if (visited.has(key)) {
            continue;
        }
        visited.add(key);
        reachable.add(passage);

        const model = passages.get(passage);
        if (!model) {
            continue;
        }

        const { targets, nextStates } = getOutgoing(passage, model, state);
        targets.forEach((target, i) => {
            if (passageNames.has(target)) {
                queue.push({ passage: target, state: nextStates[i] });
            }
        });
    }

    const unreachable = [];
    for (const [name, model] of passages) {
        if (model.isSystem) {
            continue;
        }
        if (TERMINAL_PASSAGES.has(name)) {
            continue;
        }
        if (!reachable.has(name)) {
            unreachable.push(name);
        }
    }

    return { reachable, unreachable };
}

/**
 * @param {object} result
 */
function printReport(result) {
    const { failures, warnings, passCount, unreachable, reachableCount } = result;

    console.log("");
    console.log("=== Passage Flow Validator ===");
    console.log(`PASS  ${passCount} checks`);
    console.log(`REACHABLE  ${reachableCount} gameplay passages`);

    if (warnings.length) {
        console.log(`WARN  ${warnings.length}`);
        for (const w of warnings) {
            console.log(`  [${w.passage}] ${w.message}`);
        }
    } else {
        console.log("WARN  0");
    }

    if (failures.length) {
        console.log(`FAIL  ${failures.length}`);
        for (const f of failures) {
            console.log(`  [${f.passage}] (${f.type}) ${f.message}`);
        }
    } else {
        console.log("FAIL  0");
    }

    if (unreachable.length) {
        console.log(`UNREACHABLE  ${unreachable.length}`);
        for (const name of unreachable.sort()) {
            console.log(`  ${name}`);
        }
    } else {
        console.log("UNREACHABLE  0");
    }

    console.log("");
    if (failures.length || unreachable.length) {
        console.log("Result: FAILED");
        return 1;
    }
    console.log("Result: PASSED");
    return 0;
}

export function runValidation(tweePath) {
    const { passages, passageNames } = loadStory(tweePath);
    const { failures, warnings, passCount } = validatePassages(
        passages,
        passageNames
    );
    const { reachable, unreachable } = walkGraph(passages, passageNames);

    return {
        failures,
        warnings,
        passCount,
        unreachable,
        reachableCount: reachable.size,
    };
}

function main() {
    const tweeArg = process.argv[2];
    const tweePath = tweeArg
        ? path.resolve(tweeArg)
        : path.join(__dirname, "..", "COPD simulation 2.0.4.twee");

    const result = runValidation(tweePath);
    const code = printReport(result);
    process.exit(code);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
