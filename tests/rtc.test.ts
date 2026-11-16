import assert from "node:assert/strict";
import { test } from "node:test";

import { describeMicError, mungeOpus, rewriteMdnsCandidate } from "../rtc";

// Shape of a Chromium audio offer, shortened.
const CHROME_SDP = [
    "v=0",
    "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8",
    "c=IN IP4 0.0.0.0",
    "a=mid:0",
    "a=sendrecv",
    "a=rtcp-mux",
    "a=rtpmap:111 opus/48000/2",
    "a=rtcp-fb:111 transport-cc",
    "a=fmtp:111 minptime=10;useinbandfec=1",
    "a=rtpmap:63 red/48000/2",
    "a=fmtp:63 111/111",
    "a=rtpmap:9 G722/8000",
    "a=ssrc:1234 cname:abc",
    ""
].join("\r\n");

const lines = (sdp: string) => sdp.split("\r\n");

test("mungeOpus sets the Opus parameters and keeps unrelated fmtp lines", () => {
    const out = lines(mungeOpus(CHROME_SDP));
    assert.ok(out.includes("a=fmtp:111 minptime=10;useinbandfec=0;stereo=0;usedtx=0;maxaveragebitrate=64000"));
    assert.ok(out.includes("a=fmtp:63 111/111"));
    assert.ok(!out.some(l => l.includes("useinbandfec=1")));
});

test("mungeOpus asks for 10 ms frames once, inside the audio section", () => {
    const out = lines(mungeOpus(CHROME_SDP));
    assert.equal(out.filter(l => l === "a=ptime:10").length, 1);
    assert.equal(out.filter(l => l === "a=maxptime:10").length, 1);
    assert.ok(out.indexOf("a=ptime:10") > out.indexOf("m=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8"));
    assert.equal(out[out.length - 1], "", "the SDP must still end with a line break");
});

test("mungeOpus is idempotent", () => {
    const once = mungeOpus(CHROME_SDP);
    assert.equal(mungeOpus(once), once);
});

test("mungeOpus replaces an existing ptime and keeps extra Opus parameters", () => {
    const sdp = CHROME_SDP
        .replace("a=fmtp:111 minptime=10;useinbandfec=1", "a=fmtp:111 minptime=20;useinbandfec=1;cbr=1")
        .replace("a=rtcp-mux", "a=rtcp-mux\r\na=ptime:20\r\na=maxptime:60");
    const out = lines(mungeOpus(sdp));
    assert.ok(!out.includes("a=ptime:20"));
    assert.ok(!out.includes("a=maxptime:60"));
    assert.ok(out.includes("a=fmtp:111 minptime=10;useinbandfec=0;cbr=1;stereo=0;usedtx=0;maxaveragebitrate=64000"));
});

test("mungeOpus adds an fmtp line when Opus has none", () => {
    const out = lines(mungeOpus(CHROME_SDP.replace("a=fmtp:111 minptime=10;useinbandfec=1\r\n", "")));
    const rtpmap = out.indexOf("a=rtpmap:111 opus/48000/2");
    assert.equal(out[rtpmap + 1], "a=fmtp:111 minptime=10;useinbandfec=0;stereo=0;usedtx=0;maxaveragebitrate=64000");
});

test("mungeOpus leaves other media sections alone", () => {
    const video = ["m=video 9 UDP/TLS/RTP/SAVPF 96", "a=mid:1", "a=rtpmap:96 VP8/90000", "a=fmtp:96 x=1", ""].join("\r\n");
    const out = lines(mungeOpus(CHROME_SDP + video));
    const videoStart = out.indexOf("m=video 9 UDP/TLS/RTP/SAVPF 96");
    assert.ok(out.indexOf("a=maxptime:10") < videoStart, "ptime belongs to the audio section");
    assert.deepEqual(out.slice(videoStart), lines(video));
});

test("mungeOpus keeps LF-only line endings", () => {
    const out = mungeOpus(CHROME_SDP.replaceAll("\r\n", "\n"));
    assert.ok(!out.includes("\r"));
    assert.ok(out.includes("\na=ptime:10\n"));
});

test("mungeOpus does not touch an SDP without Opus", () => {
    const sdp = ["v=0", "m=audio 9 RTP/AVP 0", "a=rtpmap:0 PCMU/8000", ""].join("\r\n");
    assert.equal(mungeOpus(sdp), sdp);
});

test("rewriteMdnsCandidate replaces a .local host with the discovered peer address", () => {
    const candidate = {
        candidate: "candidate:1 1 udp 2113937151 6f8a1b2c-0d3e-4f5a-9b7c-1e2d3f4a5b6c.local 54321 typ host generation 0",
        sdpMid: "0",
        sdpMLineIndex: 0
    };
    assert.deepEqual(rewriteMdnsCandidate(candidate, "192.168.178.42"), {
        ...candidate,
        candidate: "candidate:1 1 udp 2113937151 192.168.178.42 54321 typ host generation 0"
    });
});

test("rewriteMdnsCandidate leaves IP candidates, empty candidates and an unknown peer alone", () => {
    const ip = { candidate: "candidate:1 1 udp 2113937151 192.168.178.7 54321 typ host generation 0" };
    const mdns = { candidate: "candidate:1 1 udp 2113937151 abc.local 54321 typ host generation 0" };
    assert.equal(rewriteMdnsCandidate(ip, "192.168.178.42"), ip);
    assert.equal(rewriteMdnsCandidate(mdns, null), mdns);
    assert.deepEqual(rewriteMdnsCandidate({ candidate: "" }, "192.168.178.42"), { candidate: "" });
});

test("describeMicError explains the exclusive mode case", () => {
    assert.match(describeMicError(new DOMException("x", "NotReadableError")), /exclusive mode/);
    assert.match(describeMicError(new DOMException("x", "NotAllowedError")), /denied/);
    assert.match(describeMicError(new DOMException("x", "OverconstrainedError")), /not found/);
    assert.match(describeMicError(new Error("boom")), /boom/);
});
