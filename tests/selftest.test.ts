import assert from "node:assert/strict";
import { test } from "node:test";

import { findEchoDelay, median } from "../selftest";

const RATE = 48000;

/** A recording with quiet noise and 4 ms beeps of the given loudness at the given times. */
function recording(beeps: [atMs: number, amplitude: number][], lengthMs = 1200, noise = 0.001) {
    const samples = new Float32Array(RATE * lengthMs / 1000);
    let seed = 1;
    for (let i = 0; i < samples.length; i++) {
        seed = (seed * 16807) % 2147483647;
        samples[i] = (seed / 2147483647 - 0.5) * 2 * noise;
    }
    for (const [atMs, amplitude] of beeps) {
        const start = Math.round(atMs / 1000 * RATE);
        for (let i = 0; i < RATE * 0.004; i++) samples[start + i] += amplitude * Math.sin(2 * Math.PI * 2000 * i / RATE);
    }
    return samples;
}

function delayOf(samples: Float32Array) {
    const result = findEchoDelay(samples, RATE);
    assert.ok("delayMs" in result, "error" in result ? result.error : "");
    return result.delayMs;
}

test("measures the gap between the beep and its copy", () => {
    assert.ok(Math.abs(delayOf(recording([[100, 0.5], [187, 0.3]])) - 87) < 1);
    assert.ok(Math.abs(delayOf(recording([[100, 0.5], [145, 0.3]])) - 45) < 1);
});

test("a copy that is much quieter than the beep is still found", () => {
    assert.ok(Math.abs(delayOf(recording([[100, 0.8], [220, 0.06]])) - 120) < 1);
});

test("a copy that is louder than the beep is still measured from the first beep", () => {
    assert.ok(Math.abs(delayOf(recording([[100, 0.3], [190, 0.8]])) - 90) < 1);
});

test("further rounds of the same beep do not change the result", () => {
    assert.ok(Math.abs(delayOf(recording([[100, 0.5], [180, 0.35], [260, 0.25], [340, 0.17]])) - 80) < 1);
});

test("the beep's own ringing right after it is not taken for the copy", () => {
    assert.ok(Math.abs(delayOf(recording([[100, 0.5], [110, 0.3], [170, 0.3]])) - 70) < 1);
});

test("silence is reported as: the microphone did not pick up the beep", () => {
    const result = findEchoDelay(recording([]), RATE);
    assert.ok("error" in result);
    assert.match(result.error, /did not pick up/);
});

test("a beep without a copy is reported as: did not come back", () => {
    const result = findEchoDelay(recording([[100, 0.5]]), RATE);
    assert.ok("error" in result);
    assert.match(result.error, /did not come back/);
});

test("median", () => {
    assert.equal(median([90, 80, 300]), 90);
    assert.equal(median([80, 90, 100, 300]), 95);
});
