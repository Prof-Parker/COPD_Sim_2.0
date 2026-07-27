/**
 * Shared-room Playroom mock for dual-client resync unit tests.
 * Models refresh / autolock: disconnect clears myPlayer; reconnect restores the same id.
 */

/**
 * @typedef {object} MockPlayer
 * @property {string} id
 * @property {(key: string) => any} getState
 * @property {(key: string, val: any, reliable?: boolean) => void} setState
 * @property {(cb: Function) => void} onQuit
 */

/**
 * @returns {{
 *   globalState: Map<string, any>,
 *   players: Map<string, { state: Map<string, any>, quitHandlers: Function[] }>,
 *   hostId: string | null,
 *   createClientView: (opts: { id: string, isHost?: boolean }) => object,
 *   setHost: (id: string) => void,
 *   setStateOpaque: (opaque: boolean) => void
 * }}
 */
export function createRoom() {
    const globalState = new Map();
    /** @type {Map<string, { state: Map<string, any>, quitHandlers: Function[] }>} */
    const players = new Map();
    let hostId = null;
    /** When true, getState returns undefined (simulates Playroom snapshot lag after rejoin). */
    let stateOpaque = false;

    function ensurePlayer(id) {
        if (!players.has(id)) {
            players.set(id, { state: new Map(), quitHandlers: [] });
        }
        return players.get(id);
    }

    function createPlayerApi(id) {
        const record = ensurePlayer(id);
        /** @type {MockPlayer} */
        const api = {
            id,
            getState(key) {
                return record.state.get(key);
            },
            setState(key, val) {
                record.state.set(key, val);
            },
            onQuit(cb) {
                record.quitHandlers.push(cb);
            }
        };
        return api;
    }

    function setHost(id) {
        hostId = id;
    }

    /**
     * @param {{ id: string, isHost?: boolean }} opts
     */
    function createClientView(opts) {
        const id = opts.id;
        ensurePlayer(id);
        if (opts.isHost || hostId === null) {
            hostId = id;
        }

        let connected = true;
        let playerApi = createPlayerApi(id);

        const view = {
            id,
            lastInsertCoinOptions: null,
            get connected() {
                return connected;
            },
            insertCoin: async function (options) {
                view.lastInsertCoinOptions = options || {};
                connected = true;
                playerApi = createPlayerApi(id);
                return undefined;
            },
            myPlayer() {
                return connected ? playerApi : undefined;
            },
            isHost() {
                return connected && hostId === id;
            },
            getState(key) {
                if (stateOpaque) {
                    return undefined;
                }
                return globalState.has(key) ? globalState.get(key) : undefined;
            },
            setState(key, val) {
                globalState.set(key, val);
            },
            getRoomCode() {
                return "TESTROOM";
            },
            onPlayerJoin(cb) {
                /* Tests wire players onto SimApp.players directly */
                void cb;
            },
            onDisconnect(cb) {
                view._onDisconnect = cb;
            },
            /**
             * Simulate refresh / network drop / autolock suspend.
             * @param {{ promoteOtherHost?: boolean }} [options]
             */
            disconnect(options = {}) {
                if (!connected) {
                    return;
                }
                connected = false;
                const record = players.get(id);
                if (record) {
                    record.quitHandlers.forEach((fn) => {
                        try {
                            fn();
                        } catch {
                            /* ignore */
                        }
                    });
                }
                if (typeof view._onDisconnect === "function") {
                    view._onDisconnect({ code: 1001, reason: "test-disconnect" });
                }
                if (hostId === id && options.promoteOtherHost !== false) {
                    const other = [...players.keys()].find((pid) => pid !== id);
                    if (other) {
                        hostId = other;
                    }
                }
            },
            /** Rejoin same room / same player id (within grace period). */
            async reconnect() {
                return view.insertCoin();
            },
            /** Promote this client to host (migration). */
            becomeHost() {
                hostId = id;
            }
        };

        return view;
    }

    return {
        globalState,
        players,
        get hostId() {
            return hostId;
        },
        setHost,
        createClientView,
        /** Hide shared state reads (lag); writes still apply and become visible when cleared. */
        setStateOpaque(opaque) {
            stateOpaque = !!opaque;
        },
        get stateOpaque() {
            return stateOpaque;
        }
    };
}
