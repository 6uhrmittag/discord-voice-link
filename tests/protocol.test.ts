import assert from "node:assert/strict";
import { test } from "node:test";

import { broadcastAddresses, isHelloFrom, isSignal, pack, PROTOCOL_VERSION, unpack } from "../protocol";

const hello = { t: "hello", v: PROTOCOL_VERSION, uid: "111", sid: "abc", nonce: "n" };

test("pack and unpack round trip with the same secret", () => {
    assert.deepEqual(unpack("secret", pack("secret", hello)), hello);
});

test("unpack rejects a different secret", () => {
    assert.equal(unpack("other", pack("secret", hello)), null);
});

test("unpack rejects a body that was changed after signing", () => {
    const outer = JSON.parse(pack("secret", hello).toString());
    outer.b = outer.b.replace("111", "222");
    assert.equal(unpack("secret", Buffer.from(JSON.stringify(outer))), null);
});

test("unpack rejects garbage, missing fields and non-object bodies", () => {
    assert.equal(unpack("secret", Buffer.from("not json")), null);
    assert.equal(unpack("secret", Buffer.from("{}")), null);
    assert.equal(unpack("secret", Buffer.from(JSON.stringify({ b: "{}", mac: "zz" }))), null);
    assert.equal(unpack("secret", Buffer.from(JSON.stringify({ b: 1, mac: 2 }))), null);
    assert.equal(unpack("secret", pack("secret", [1, 2])), null);
    assert.equal(unpack("secret", Buffer.from("null")), null);
});

test("the signature covers the whole body, including SDP", () => {
    const outer = JSON.parse(pack("secret", { t: "offer", aid: "a", sdp: "v=0 real" }).toString());
    outer.b = outer.b.replace("real", "evil");
    assert.equal(unpack("secret", Buffer.from(JSON.stringify(outer))), null);
});

test("isHelloFrom only accepts the configured peer and protocol version", () => {
    assert.equal(isHelloFrom(hello, "111"), true);
    assert.equal(isHelloFrom(hello, "999"), false);
    assert.equal(isHelloFrom({ ...hello, v: 2 }, "111"), false);
    assert.equal(isHelloFrom({ ...hello, sid: 5 }, "111"), false);
    assert.equal(isHelloFrom({ ...hello, t: "offer" }, "111"), false);
});

test("isSignal validates the shape of each message type", () => {
    assert.equal(isSignal({ t: "offer", aid: "a", sdp: "x" }), true);
    assert.equal(isSignal({ t: "answer", aid: "a", sdp: "x" }), true);
    assert.equal(isSignal({ t: "candidate", aid: "a", candidate: {} }), true);
    assert.equal(isSignal({ t: "bye", aid: "a" }), true);
    assert.equal(isSignal({ t: "offer", aid: "a" }), false);
    assert.equal(isSignal({ t: "offer", sdp: "x" }), false);
    assert.equal(isSignal({ t: "candidate", aid: "a", candidate: null }), false);
    assert.equal(isSignal({ t: "hello", aid: "a" }), false);
});

test("broadcastAddresses adds the directed broadcast of every real IPv4 adapter", () => {
    const addresses = broadcastAddresses({
        lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true }],
        eth: [
            { address: "192.168.178.23", netmask: "255.255.255.0", family: "IPv4", internal: false },
            { address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", internal: false }
        ],
        wsl: [{ address: "172.22.216.1", netmask: "255.255.240.0", family: "IPv4", internal: false }],
        gone: undefined
    });
    assert.deepEqual(addresses.sort(), ["172.22.223.255", "192.168.178.255", "255.255.255.255"]);
});
