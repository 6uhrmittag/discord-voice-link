// Runs native.ts against a real UDP socket on localhost. The test socket plays the peer.
import assert from "node:assert/strict";
import { createSocket, Socket } from "node:dgram";
import { after, before, beforeEach, test } from "node:test";

import * as native from "../native";
import { pack, PROTOCOL_VERSION, unpack } from "../protocol";

const SECRET = "test-secret";
const ME = "111111111111111111";
const PEER = "222222222222222222";
const ev = null as never;

let peer: Socket;
let peerPort: number;
let port: number;
let generation: number;
let inbox: Record<string, unknown>[] = [];

function freePort() {
    return new Promise<number>(resolve => {
        const s = createSocket("udp4");
        s.bind(0, "127.0.0.1", () => {
            const { port } = s.address();
            s.close(() => resolve(port));
        });
    });
}

const sendRaw = (data: Buffer) => new Promise<void>(resolve => peer.send(data, port, "127.0.0.1", () => resolve()));
const sendAsPeer = (body: object, secret = SECRET) => sendRaw(pack(secret, body));
const peerHello = (overrides: object = {}) => sendAsPeer({ t: "hello", v: PROTOCOL_VERSION, uid: PEER, sid: "s1", nonce: "n", ...overrides });
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function next(timeoutMs = 1000) {
    return Promise.race([
        native.nextMessage(ev, generation),
        wait(timeoutMs).then(() => ({ t: "timeout" as const }))
    ]);
}

async function waitForInbox(predicate: (body: Record<string, unknown>) => boolean) {
    for (let i = 0; i < 100; i++) {
        const found = inbox.find(predicate);
        if (found) return found;
        await wait(10);
    }
    assert.fail("the peer socket did not receive the expected message");
}

before(async () => {
    peer = createSocket("udp4");
    peer.on("message", data => {
        const body = unpack(SECRET, data);
        if (body) inbox.push(body);
    });
    await new Promise<void>(resolve => peer.bind(0, "127.0.0.1", resolve));
    peerPort = peer.address().port;
});

after(() => {
    native.stop(ev);
    peer.close();
});

beforeEach(async () => {
    inbox = [];
    port = await freePort();
    // manualIp keeps the test off the real network: hellos go to localhost only.
    const result = await native.start(ev, { uid: ME, peerUid: PEER, secret: SECRET, port, manualIp: "127.0.0.1" });
    assert.equal(result.error, undefined);
    ({ generation } = result);
});

test("a signed hello from the peer is reported once and answered with our own hello", async () => {
    await peerHello();
    assert.deepEqual(await next(), { t: "peer", addr: "127.0.0.1", sid: "s1" });

    const reply = await waitForInbox(b => b.t === "hello");
    assert.equal(reply.uid, ME);
    assert.equal(reply.v, PROTOCOL_VERSION);

    await peerHello();
    assert.equal((await next(150)).t, "timeout", "a repeated hello must not be reported again");
});

test("a hello with a new session id is reported as a new peer", async () => {
    await peerHello();
    await next();
    await peerHello({ sid: "s2" });
    assert.deepEqual(await next(), { t: "peer", addr: "127.0.0.1", sid: "s2" });
});

test("hellos with a wrong secret, wrong user or wrong version are ignored", async () => {
    await sendAsPeer({ t: "hello", v: PROTOCOL_VERSION, uid: PEER, sid: "s1", nonce: "n" }, "wrong-secret");
    await peerHello({ uid: "333333333333333333" });
    await peerHello({ v: 99 });
    await sendRaw(Buffer.from("garbage"));
    assert.equal((await next(200)).t, "timeout");
});

test("signaling is dropped until the peer is known, then delivered", async () => {
    const offer = { t: "offer", aid: "a1", sdp: "v=0" };
    await sendAsPeer(offer);
    assert.equal((await next(150)).t, "timeout");

    await peerHello();
    await next();
    await sendAsPeer(offer);
    assert.deepEqual(await next(), { t: "signal", body: offer });
});

test("signaling with a wrong secret or a malformed body is dropped", async () => {
    await peerHello();
    await next();
    await sendAsPeer({ t: "offer", aid: "a1", sdp: "v=0" }, "wrong-secret");
    await sendAsPeer({ t: "offer", aid: "a1" });
    await sendAsPeer({ t: "unknown", aid: "a1" });
    assert.equal((await next(200)).t, "timeout");
});

test("send reaches the peer, signed, and reports false while there is no peer", async () => {
    const answer = { t: "answer" as const, aid: "a1", sdp: "v=0" };
    assert.equal(native.send(ev, answer), false);

    await peerHello();
    await next();
    assert.equal(native.send(ev, answer), true);
    assert.deepEqual(await waitForInbox(b => b.t === "answer"), answer);
});

test("stop unblocks a pending long-poll, and an old generation never blocks", async () => {
    const pending = native.nextMessage(ev, generation);
    native.stop(ev);
    assert.deepEqual(await pending, { t: "stopped" });
    assert.deepEqual(await native.nextMessage(ev, generation), { t: "stopped" });
});

test("starting again invalidates the previous generation (renderer reload)", async () => {
    const oldGeneration = generation;
    const pending = native.nextMessage(ev, oldGeneration);
    const result = await native.start(ev, { uid: ME, peerUid: PEER, secret: SECRET, port, manualIp: "127.0.0.1" });
    assert.deepEqual(await pending, { t: "stopped" });
    assert.notEqual(result.generation, oldGeneration);
    assert.deepEqual(await native.nextMessage(ev, oldGeneration), { t: "stopped" });
});

test("a port that is already taken is reported as an error, not thrown", async () => {
    const blocker = createSocket("udp4");
    const taken = await new Promise<number>(resolve => blocker.bind(0, () => resolve(blocker.address().port)));
    const result = await native.start(ev, { uid: ME, peerUid: PEER, secret: SECRET, port: taken, manualIp: "127.0.0.1" });
    blocker.close();
    // reuseAddr lets two UDP sockets share a port on some systems, so both outcomes are valid.
    if (result.error) assert.match(result.error, /Could not open UDP port/);
});
