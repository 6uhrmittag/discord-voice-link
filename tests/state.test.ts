// Link state machine with a fake native transport and fake WebRTC sessions.
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";

import type { NativeEvent } from "../native";
import type { SignalBody } from "../protocol";
import type { RtcOptions } from "../rtc";
import { getLinkState, LinkConfig, LinkSession, setGates, setLinkDeps, startLink, stopLink } from "../state";

const LOW = "111111111111111111";
const HIGH = "222222222222222222";

interface FakeSession extends LinkSession {
    opts: RtcOptions;
    signals: SignalBody[];
    closed: boolean;
    sendEnabled: boolean | null;
    receiveMuted: boolean | null;
}

let sessions: FakeSession[];
let sent: SignalBody[];
let startError: Error | null;
let nativeStartError: string | undefined;
let events: NativeEvent[];
let waiting: ((ev: NativeEvent) => void) | null;
let nativeStops: number;

function emit(ev: NativeEvent) {
    if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(ev);
    } else {
        events.push(ev);
    }
}

/** Lets promise chains and the poll loop run. setImmediate is not mocked. */
async function flush() {
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
}

function config(uid: string, peerUid: string): LinkConfig {
    return {
        uid, peerUid, secret: "s", port: 47820, manualIp: "", volume: 1, jitterBufferMs: 0,
        resolveDevices: async () => ({ input: "mic", output: "phones" })
    };
}

async function start(uid = LOW, peerUid = HIGH) {
    await startLink(config(uid, peerUid));
    await flush();
}

async function peerAppears(sid = "s1") {
    emit({ t: "peer", addr: "192.168.1.2", sid });
    await flush();
}

const last = () => sessions[sessions.length - 1];

beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    sessions = [];
    sent = [];
    events = [];
    waiting = null;
    startError = null;
    nativeStartError = undefined;
    nativeStops = 0;
    mock.method(console, "log", () => { });

    setLinkDeps({
        native: {
            start: async () => ({ generation: 1, error: nativeStartError }),
            stop: async () => { nativeStops++; emit({ t: "stopped" }); },
            nextMessage: () => {
                const queued = events.shift();
                return queued ? Promise.resolve(queued) : new Promise<NativeEvent>(resolve => { waiting = resolve; });
            },
            send: async body => { sent.push(body); return true; }
        },
        createSession: opts => {
            const session: FakeSession = {
                opts,
                aid: opts.aid,
                signals: [],
                closed: false,
                sendEnabled: null,
                receiveMuted: null,
                start: async () => { if (startError) throw startError; },
                handleSignal: signal => { session.signals.push(signal); },
                setSendEnabled: enabled => { session.sendEnabled = enabled; },
                setReceiveMuted: muted => { session.receiveMuted = muted; },
                setVolume: () => { },
                getStats: async () => null,
                close: () => { session.closed = true; }
            };
            sessions.push(session);
            return session;
        }
    });
});

afterEach(async () => {
    await stopLink();
    mock.timers.reset();
    mock.restoreAll();
});

test("starts in discovering and creates no session before a peer is seen", async () => {
    await start();
    assert.equal(getLinkState().phase, "discovering");
    assert.equal(sessions.length, 0);
});

test("a port error from the native side ends in the error phase", async () => {
    nativeStartError = "Could not open UDP port 47820: EADDRINUSE";
    await start();
    assert.equal(getLinkState().phase, "error");
    assert.match(getLinkState().detail ?? "", /47820/);
});

test("the lower user id is the offerer and starts a session when the peer appears", async () => {
    await start(LOW, HIGH);
    await peerAppears();
    assert.equal(getLinkState().phase, "connecting");
    assert.equal(sessions.length, 1);
    assert.equal(last().opts.offerer, true);
    assert.equal(last().opts.peerIp, "192.168.1.2");
    assert.equal(last().opts.inputDeviceId, "mic");
    assert.equal(last().opts.outputDeviceId, "phones");
});

test("the higher user id waits for the offer and answers with the offer's attempt id", async () => {
    await start(HIGH, LOW);
    await peerAppears();
    assert.equal(sessions.length, 0);
    assert.equal(getLinkState().phase, "connecting");

    const offer: SignalBody = { t: "offer", aid: "attempt-1", sdp: "v=0" };
    emit({ t: "signal", body: offer });
    await flush();
    assert.equal(sessions.length, 1);
    assert.equal(last().opts.offerer, false);
    assert.equal(last().aid, "attempt-1");
    assert.deepEqual(last().signals, [offer]);
});

test("the offerer ignores offers from the peer", async () => {
    await start(LOW, HIGH);
    await peerAppears();
    emit({ t: "signal", body: { t: "offer", aid: "foreign", sdp: "v=0" } });
    await flush();
    assert.equal(sessions.length, 1);
    assert.deepEqual(last().signals, []);
});

test("candidates that arrive while the answerer's session is being set up are not lost", async () => {
    await start(HIGH, LOW);
    await peerAppears();
    const offer: SignalBody = { t: "offer", aid: "a1", sdp: "v=0" };
    const candidate: SignalBody = { t: "candidate", aid: "a1", candidate: { candidate: "c" } };
    const stale: SignalBody = { t: "candidate", aid: "old", candidate: { candidate: "x" } };
    // No flush in between: all three are handled before the session exists.
    emit({ t: "signal", body: offer });
    emit({ t: "signal", body: candidate });
    emit({ t: "signal", body: stale });
    await flush();
    assert.deepEqual(last().signals, [offer, candidate]);
});

test("connected resets the retry counter and applies the audio gates", async () => {
    setGates(true, false);
    await start();
    await peerAppears();
    assert.equal(last().sendEnabled, true);
    assert.equal(last().receiveMuted, false);
    last().opts.onConnected();
    assert.equal(getLinkState().phase, "connected");
    assert.equal(getLinkState().peerAddr, "192.168.1.2");

    setGates(false, true);
    assert.equal(last().sendEnabled, false);
    assert.equal(last().receiveMuted, true);
});

test("a lost link goes to lost, tells the peer and reconnects after the backoff", async () => {
    await start();
    await peerAppears();
    const first = last();
    first.opts.onConnected();
    first.opts.onFailed("Connection lost");
    await flush();
    assert.equal(getLinkState().phase, "lost");
    assert.deepEqual(sent, [{ t: "bye", aid: first.aid }]);
    assert.equal(sessions.length, 1);

    mock.timers.tick(999);
    await flush();
    assert.equal(sessions.length, 1);
    mock.timers.tick(1);
    await flush();
    assert.equal(sessions.length, 2);
    assert.notEqual(last().aid, first.aid);
    assert.equal(getLinkState().phase, "connecting");
});

test("an attempt that never connects times out and the backoff doubles up to 30 s", async () => {
    await start();
    await peerAppears();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
        const count = sessions.length;
        mock.timers.tick(8000);
        await flush();
        assert.equal(getLinkState().phase, "failed");
        assert.equal(last().closed, true);
        let waited = 0;
        while (sessions.length === count) {
            mock.timers.tick(500);
            waited += 500;
            await flush();
            assert.ok(waited <= 60000, "no retry within a minute");
        }
        delays.push(waited);
    }
    assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

test("a microphone error is terminal: error phase, no retry, later events ignored", async () => {
    startError = new DOMException("in use", "NotReadableError");
    await start();
    await peerAppears();
    assert.equal(getLinkState().phase, "error");
    assert.match(getLinkState().detail ?? "", /exclusive mode/);

    mock.timers.tick(120000);
    await peerAppears("s2");
    assert.equal(sessions.length, 1);
    assert.equal(getLinkState().phase, "error");
});

test("a bye for the current attempt closes it and the offerer retries", async () => {
    await start();
    await peerAppears();
    const first = last();
    first.opts.onConnected();
    emit({ t: "signal", body: { t: "bye", aid: first.aid } });
    await flush();
    assert.equal(first.closed, true);
    assert.equal(getLinkState().phase, "lost");
    mock.timers.tick(1000);
    await flush();
    assert.equal(sessions.length, 2);
});

test("a bye for an old attempt is ignored", async () => {
    await start();
    await peerAppears();
    last().opts.onConnected();
    emit({ t: "signal", body: { t: "bye", aid: "some-old-attempt" } });
    await flush();
    assert.equal(last().closed, false);
    assert.equal(getLinkState().phase, "connected");
});

test("the answerer does not start sessions by itself after a failure", async () => {
    await start(HIGH, LOW);
    await peerAppears();
    emit({ t: "signal", body: { t: "offer", aid: "a1", sdp: "v=0" } });
    await flush();
    last().opts.onConnected();
    last().opts.onFailed("Connection lost");
    await flush();
    assert.deepEqual(sent, [{ t: "bye", aid: "a1" }]);
    mock.timers.tick(60000);
    await flush();
    assert.equal(sessions.length, 1);
    assert.equal(getLinkState().phase, "connecting");
});

test("missing hellos do not tear down a connected link", async () => {
    await start();
    await peerAppears();
    last().opts.onConnected();
    emit({ t: "peer-lost" });
    await flush();
    assert.equal(getLinkState().phase, "connected");
    assert.equal(last().closed, false);

    // Hellos resume with the same session id: still nothing to do.
    await peerAppears("s1");
    assert.equal(sessions.length, 1);
    assert.equal(getLinkState().phase, "connected");
});

test("missing hellos while connecting go back to discovering", async () => {
    await start();
    await peerAppears();
    emit({ t: "peer-lost" });
    await flush();
    assert.equal(getLinkState().phase, "discovering");
    assert.equal(last().closed, true);
});

test("a restarted peer (new session id) gets a fresh session", async () => {
    await start();
    await peerAppears("s1");
    const first = last();
    first.opts.onConnected();
    await peerAppears("s2");
    assert.equal(first.closed, true);
    assert.equal(sessions.length, 2);
    assert.equal(getLinkState().phase, "connecting");
});

test("stopLink says bye, closes the session, stops the native side and is idle", async () => {
    await start();
    await peerAppears();
    const session = last();
    session.opts.onConnected();
    await stopLink();
    await flush();
    assert.deepEqual(sent, [{ t: "bye", aid: session.aid }]);
    assert.equal(session.closed, true);
    assert.equal(nativeStops, 1);
    assert.equal(getLinkState().phase, "disabled");

    // Nothing comes back to life afterwards.
    mock.timers.tick(120000);
    await flush();
    assert.equal(sessions.length, 1);
});

test("callbacks of a replaced session are ignored", async () => {
    await start();
    await peerAppears("s1");
    const first = last();
    await peerAppears("s2");
    first.opts.onConnected();
    first.opts.onFailed("late");
    await flush();
    assert.equal(getLinkState().phase, "connecting");
    assert.deepEqual(sent, []);
});
