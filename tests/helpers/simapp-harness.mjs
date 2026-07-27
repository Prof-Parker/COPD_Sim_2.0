/**
 * Load production SimApp from StoryScript and build dual-client test fixtures.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRoom } from "./playroom-mock.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const TWEE_PATH = path.join(ROOT, "COPD simulation 2.0.4.twee");

/** Mid-sim fixture values that differ from DEFAULT_GAME_STATE */
export const MID_SIM_FIXTURE = {
    currentPassage: "Breakfast",
    passageSeq: 7,
    Energy: 6,
    Points: 3,
    Inhaler: 2,
    hasInhaler: false,
    errandsRun: 2,
    visitedGrocery: true,
    lobby_patient: true,
    lobby_observer: true
};

const PASSAGE_TAGS = {
    Breakfast: ["simulation", "activity"],
    Hallway_Out: ["simulation", "activity"],
    Simulation_Hub: ["simulation", "briefing"],
    Role_Selection: [],
    Waiting_Room: [],
    Start: [],
    Final_Report: ["simulation", "briefing"],
    Game_Over_Energy: ["pausetimer"],
    Game_Over_Inhaler: ["pausetimer"]
};

/** Minimal jQuery-like stub so SimApp banner/footer helpers do not throw. */
function createJqueryStub() {
    const chain = {
        length: 0,
        addClass() {
            return chain;
        },
        removeClass() {
            return chain;
        },
        text() {
            return chain;
        },
        html() {
            return chain;
        },
        empty() {
            return chain;
        },
        append() {
            return chain;
        },
        appendTo() {
            return chain;
        },
        remove() {
            return chain;
        },
        find() {
            return chain;
        },
        on() {
            return chain;
        },
        prop() {
            return chain;
        },
        attr() {
            return chain;
        },
        hasClass() {
            return false;
        }
    };
    function $(sel) {
        if (typeof sel === "function") {
            sel();
            return chain;
        }
        return chain;
    }
    return $;
}

/** Persistent stub — banner hide timers may fire after a test's `run()` ends */
const GLOBAL_JQ = createJqueryStub();
globalThis.$ = GLOBAL_JQ;

let cachedSimAppTemplate = null;

/**
 * Extract and evaluate `window.SimApp = { ... };` from StoryScript in the .twee file.
 * @returns {object}
 */
export function loadSimAppTemplate() {
    if (cachedSimAppTemplate) {
        return cachedSimAppTemplate;
    }

    const raw = fs.readFileSync(TWEE_PATH, "utf8");
    const startMarker = "window.SimApp = {";
    const start = raw.indexOf(startMarker);
    if (start === -1) {
        throw new Error("Could not locate window.SimApp start in StoryScript");
    }
    const endMarkers = [
        "\r\n};\r\n\r\n/* --- 3. SugarCube macros (faculty-facing)",
        "\n};\n\n/* --- 3. SugarCube macros (faculty-facing)"
    ];
    let markerIdx = -1;
    let marker = "";
    for (const candidate of endMarkers) {
        const idx = raw.indexOf(candidate, start);
        if (idx !== -1) {
            markerIdx = idx;
            marker = candidate;
            break;
        }
    }
    if (markerIdx === -1) {
        throw new Error("Could not locate window.SimApp end in StoryScript");
    }

    /* Slice object literal only (`{ ... }`), not the trailing semicolon */
    const bodyStart = start + "window.SimApp = ".length;
    const braceInMarker = marker.indexOf("}");
    const bodyEnd = markerIdx + braceInMarker + 1;
    const objectLiteral = raw.slice(bodyStart, bodyEnd);
    const factory = new Function("return (" + objectLiteral + ");");
    cachedSimAppTemplate = factory();
    return cachedSimAppTemplate;
}

/**
 * Deep-ish clone of SimApp template (methods shared by reference is OK; own fields copied).
 * @param {object} template
 */
function cloneSimApp(template) {
    const clone = Object.assign({}, template);
    /* Per-instance mutable fields */
    clone.players = {};
    clone.myRole = "";
    clone._syncTimer = null;
    clone._gameOverInterval = null;
    clone._gameOverFinalizing = false;
    clone._lastAppliedPassageSeq = -1;
    clone._recovering = false;
    clone._recoverDebounceUntil = 0;
    clone._passageCommitInFlight = false;
    clone._allowAdvanceWithoutPartner = false;
    clone._wakeHandlersRegistered = false;
    clone._hasJoinedRoom = false;
    clone._syncBannerHideTimer = null;
    clone._partnerAbsent = false;
    clone._playerHandlersRegistered = false;
    clone._disconnectHandlerRegistered = false;
    clone._patientNextConfig = null;
    clone._patientNextTimer = null;
    clone._patientChoicesMounted = false;
    clone._patientChoiceResolved = false;
    clone._patientChoicesSkipEval = false;
    clone._observerEvalMounted = false;
    clone.RECOVER_DEBOUNCE_MS = 0;
    clone.PASSAGE_COMMIT_TIMEOUT_MS = 200;
    return clone;
}

/**
 * @param {object} opts
 * @param {object} opts.playroom
 * @param {object} opts.sim
 */
function createClientContext(opts) {
    const playroom = opts.playroom;
    let currentPassage = "Start";
    const state = { variables: {} };

    const Story = {
        has(name) {
            return Object.prototype.hasOwnProperty.call(PASSAGE_TAGS, name) || name === "Breakfast";
        },
        get(name) {
            return {
                title: name,
                tags: PASSAGE_TAGS[name] || ["simulation"]
            };
        }
    };

    const Engine = {
        play(name) {
            currentPassage = name;
        },
        minDomActionDelay: 0
    };

    const ctx = {
        playroom,
        sim: opts.sim,
        state,
        get currentPassage() {
            return currentPassage;
        },
        set currentPassage(v) {
            currentPassage = v;
        },
        /**
         * Run fn with this client's globals bound (Playroom, State, Engine, etc.).
         * @template T
         * @param {() => T | Promise<T>} fn
         * @returns {Promise<T>}
         */
        async run(fn) {
            const prev = {
                Playroom: globalThis.Playroom,
                State: globalThis.State,
                Story: globalThis.Story,
                Engine: globalThis.Engine,
                passage: globalThis.passage,
                $: globalThis.$,
                document: globalThis.document,
                window: globalThis.window
            };

            globalThis.Playroom = playroom;
            globalThis.State = state;
            globalThis.Story = Story;
            globalThis.Engine = Engine;
            globalThis.passage = () => currentPassage;
            globalThis.$ = GLOBAL_JQ;
            globalThis.document = globalThis.document || {
                visibilityState: "visible",
                addEventListener() {},
                querySelector() {
                    return null;
                }
            };
            globalThis.window = globalThis.window || globalThis;
            if (!globalThis.window.addEventListener) {
                globalThis.window.addEventListener = () => {};
            }

            try {
                return await fn();
            } finally {
                if (opts.sim._syncBannerHideTimer) {
                    clearTimeout(opts.sim._syncBannerHideTimer);
                    opts.sim._syncBannerHideTimer = null;
                }
                globalThis.Playroom = prev.Playroom;
                globalThis.State = prev.State;
                globalThis.Story = prev.Story;
                globalThis.Engine = prev.Engine;
                globalThis.passage = prev.passage;
                globalThis.$ = GLOBAL_JQ;
            }
        },
        /**
         * Wipe local SugarCube-like state (simulates browser refresh before recover).
         */
        wipeLocal() {
            state.variables = {};
            opts.sim.myRole = "";
            opts.sim._lastAppliedPassageSeq = -1;
            opts.sim._recovering = false;
            opts.sim._recoverDebounceUntil = 0;
            opts.sim._passageCommitInFlight = false;
            opts.sim._allowAdvanceWithoutPartner = false;
            opts.sim._partnerAbsent = false;
            currentPassage = "Start";
        }
    };

    return ctx;
}

/**
 * Snapshot keys used for preservation assertions.
 * @param {object} playroom
 * @param {object} [localState]
 */
export function readPreservedSnapshot(playroom, localState) {
    const keys = [
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
    const room = {};
    keys.forEach((k) => {
        room[k] = playroom.getState(k);
    });
    const local = {};
    if (localState && localState.variables) {
        keys.forEach((k) => {
            if (localState.variables[k] !== undefined) {
                local[k] = localState.variables[k];
            }
        });
    }
    return { room, local };
}

/**
 * @param {{ hostRole: "patient"|"observer", clientRole: "patient"|"observer" }} layout
 */
export async function createSyncedPair(layout) {
    if (layout.hostRole === layout.clientRole) {
        throw new Error("hostRole and clientRole must differ");
    }

    const room = createRoom();
    const hostPlayroom = room.createClientView({ id: "player-host", isHost: true });
    const clientPlayroom = room.createClientView({ id: "player-client", isHost: false });

    const template = loadSimAppTemplate();
    const hostSim = cloneSimApp(template);
    const clientSim = cloneSimApp(template);

    const host = createClientContext({ playroom: hostPlayroom, sim: hostSim });
    const client = createClientContext({ playroom: clientPlayroom, sim: clientSim });

    /* Wire peer maps for both (connected count >= 2) */
    const hostPlayer = hostPlayroom.myPlayer();
    const clientPlayer = clientPlayroom.myPlayer();
    hostSim.players = {
        [hostPlayer.id]: hostPlayer,
        [clientPlayer.id]: clientPlayer
    };
    clientSim.players = {
        [hostPlayer.id]: hostPlayer,
        [clientPlayer.id]: clientPlayer
    };

    await host.run(async () => {
        hostSim.isPlayroomLoaded = true;
        hostSim._hasJoinedRoom = true;
        hostSim.initRoomState();

        /* Assign roles */
        hostPlayer.setState("role", layout.hostRole, true);
        hostSim.myRole = layout.hostRole;
        host.state.variables.myRole = layout.hostRole;
        hostSim.setVal("lobby_" + layout.hostRole, true, true);
        hostSim.setVal(layout.hostRole + "PlayerId", hostPlayer.id, true);

        clientPlayer.setState("role", layout.clientRole, true);
        hostSim.setVal("lobby_" + layout.clientRole, true, true);
        hostSim.setVal(layout.clientRole + "PlayerId", clientPlayer.id, true);

        /* Seed mid-sim room snapshot */
        Object.keys(MID_SIM_FIXTURE).forEach((key) => {
            hostSim.setVal(key, MID_SIM_FIXTURE[key], true);
        });
        hostSim._lastAppliedPassageSeq = MID_SIM_FIXTURE.passageSeq;
        host.currentPassage = MID_SIM_FIXTURE.currentPassage;
        hostSim.syncFromPlayroom();
    });

    await client.run(async () => {
        clientSim.isPlayroomLoaded = true;
        clientSim._hasJoinedRoom = true;
        clientSim.myRole = layout.clientRole;
        client.state.variables.myRole = layout.clientRole;
        clientSim._lastAppliedPassageSeq = MID_SIM_FIXTURE.passageSeq;
        client.currentPassage = MID_SIM_FIXTURE.currentPassage;
        clientSim.syncFromPlayroom();
    });

    function getPatient() {
        return layout.hostRole === "patient" ? host : client;
    }

    function getObserver() {
        return layout.hostRole === "observer" ? host : client;
    }

    return {
        room,
        host,
        client,
        getPatient,
        getObserver,
        layout,
        fixture: { ...MID_SIM_FIXTURE }
    };
}
