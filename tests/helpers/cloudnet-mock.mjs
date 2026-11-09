/**
 * Cloudflare-backend test room: the real CloudNet client (extracted from the .twee) talking
 * through an in-memory fake WebSocket to the real server rules (cloud/src/room-core.js).
 *
 * createRoom().createClientView() returns the same shape as playroom-mock.mjs, so the resync
 * tests can run unchanged against both backends:
 *   view.getState/setState/myPlayer/isHost/insertCoin/getRoomCode/onPlayerJoin/onDisconnect
 *   view.disconnect(), view.reconnect(), view.becomeHost(), view.id, view.connected
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { RoomCore, routeMessages } from "../../cloud/src/room-core.js";
import { createMemoryStorage } from "./simapp-harness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TWEE_PATH = path.resolve(__dirname, "../../COPD simulation 2.0.4.twee");

let cachedFactory = null;

/** Evaluates the `CLOUDNET:BEGIN … CLOUDNET:END` block from StoryScript and returns createCloudNet. */
export function loadCloudNetFactory() {
    if (cachedFactory) {
        return cachedFactory;
    }
    const raw = fs.readFileSync(TWEE_PATH, "utf8");
    const begin = raw.indexOf("/* CLOUDNET:BEGIN");
    const end = raw.indexOf("/* CLOUDNET:END */");
    if (begin < 0 || end < 0) {
        throw new Error("Could not locate CLOUDNET:BEGIN/END in StoryScript");
    }
    const code = raw.slice(begin, end);
    const factory = new Function("window", code + "\nreturn window.createCloudNet;");
    cachedFactory = factory({});
    return cachedFactory;
}

export function createRoom(opts = {}) {
    const session = opts.session || "TEST";
    const pair = opts.pair || "1";
    let tokenN = 0;
    /* One shared fake clock for server and clients (advance with room.advance(ms)). */
    let clock = opts.startTime || 1_700_000_000_000;
    const now = () => clock;
    const core = new RoomCore(null, {
        sessionCode: session,
        pairCode: pair,
        makeToken: () => `token-${++tokenN}`,
        now,
        random: opts.random,
    });
    /** Server-side ends of open sockets: { token, send, ws } */
    const serverEnds = new Set();

    function connectedTokens(except) {
        const set = new Set();
        for (const e of serverEnds) {
            if (e !== except && e.token) set.add(e.token);
        }
        return set;
    }

    class FakeWebSocket {
        constructor() {
            this.readyState = 0;
            const end = {
                token: null,
                ws: this,
                /* Deliver asynchronously and in order, like a real socket. Synchronous delivery
                   would let a reply sent from inside onmessage overtake older messages. */
                send: (text) => {
                    queueMicrotask(() => {
                        if (this.readyState === 1 && this.onmessage) this.onmessage({ data: text });
                    });
                },
            };
            this._end = end;
            serverEnds.add(end);
            queueMicrotask(() => {
                if (this.readyState !== 0) return;
                this.readyState = 1;
                if (this.onopen) this.onopen();
            });
        }
        send(text) {
            if (this.readyState !== 1) throw new Error("socket not open");
            if (text === "ping") {
                this._end.send("pong"); // Cloudflare auto-response
                return;
            }
            const { out } = core.handle(this._end, JSON.parse(text), connectedTokens());
            routeMessages(core, out, [...serverEnds], this._end);
        }
        close() {
            if (this.readyState >= 2) return;
            this.readyState = 3;
            serverEnds.delete(this._end);
            if (this.onclose) this.onclose({ code: 1000 });
            const { out } = core.presenceChanged(connectedTokens());
            routeMessages(core, out.map((o) => ({ ...o, to: "others" })), [...serverEnds], this._end);
        }
    }

    const createCloudNet = loadCloudNetFactory();

    /**
     * @param {{ id?: string, isHost?: boolean }} _viewOpts  ids come from the server (p1, p2…);
     *   the first view created is the host, matching Playroom's "first to join".
     */
    async function createClientView(_viewOpts = {}) {
        const net = createCloudNet({
            WebSocket: FakeWebSocket,
            storage: createMemoryStorage(),
            location: { search: `?s=${session}&p=${pair}`, protocol: "http:", host: "test", pathname: "/", hash: "" },
            history: { replaceState() {} },
            setTimeout: () => 0, // no auto-reconnect / keepalive timers in tests
            clearTimeout: () => {},
            listenVisibility: false,
            now,
        });
        Object.defineProperty(net, "id", {
            get() {
                return net.you ? net.you.pid : undefined;
            },
        });
        const view = Object.assign(net, {
            lastInsertCoinOptions: null,
            disconnect() {
                net._drop();
            },
            async reconnect() {
                return view.insertCoin();
            },
            becomeHost() {
                /* Host is derived (lowest connected player); nothing to force. */
            },
        });
        const origInsert = net.insertCoin;
        view.insertCoin = function (options) {
            view.lastInsertCoinOptions = options || {};
            return origInsert.apply(net, arguments);
        };
        if (_viewOpts.takeover) {
            await net.takeoverSeat();
        } else {
            await view.insertCoin();
        }
        return view;
    }

    return {
        core,
        createClientView,
        /** Move the shared fake clock forward. */
        advance(ms) {
            clock += ms;
        },
        /** Flush batched setState messages (CloudNet sends them in a microtask). */
        async settle() {
            await new Promise((r) => setTimeout(r, 0));
        },
    };
}
