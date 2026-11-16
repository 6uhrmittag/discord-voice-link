/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Audio self-test for one PC: two sessions inside the same window, wired
// directly to each other. Your microphone goes through the complete WebRTC path
// (capture, Opus, jitter buffer, playback) and comes out of the output device.
//
// Answers, without a second PC: can the mic be opened next to Discord, do the
// devices resolve, and how large is the jitter buffer on real audio hardware.
// Touches neither the link state nor anything in Discord.

import { describeMicError, RtcSession, RtcStats } from "./rtc";

export interface SelfTestOptions {
    inputDeviceId: string;
    outputDeviceId: string;
    volume: number;
    jitterBufferMs: number;
    durationMs?: number;
    /** How long the microphone may take to open before the test gives up. */
    openTimeoutMs?: number;
    /**
     * Measure the delay of the whole audio path. The user holds a headphone cup
     * against the microphone; a beep is played and timed on its way round.
     */
    measureDelay?: boolean;
}

export interface SelfTestState {
    running: boolean;
    connected: boolean;
    error: string | null;
    /** Stats of the receiving side, with the sending side's packet rate and frame size. */
    stats: RtcStats | null;
    log: string[];
    /** What the user should do right now, if anything. */
    hint: string | null;
    /** Measured delays of the single runs, and their median. */
    delayRunsMs: number[];
    delayMs: number | null;
}

const BEEP_MS = 4;
const BEEP_HZ = 2000;
/** The beep's own ringing is over after this; anything later is the copy that went round. */
const ECHO_GAP_MS = 30;
const SETTLE_MS = 5000;
const RUNS = 5;
const RUN_MS = 1200;

/**
 * Finds a beep and its first repetition in a microphone recording and returns
 * the time between the two. With a headphone held against the microphone the
 * recording contains the beep as played, then the same beep after it went
 * through the microphone, the audio link and the headphone again. The gap is
 * the delay of that whole path. The delay of the recording itself cancels out,
 * because both beeps are recorded the same way.
 */
export function findEchoDelay(samples: Float32Array, sampleRate: number): { delayMs: number; } | { error: string; } {
    const magnitudes = Array.from(samples, Math.abs);
    const sorted = [...magnitudes].sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length / 2)];
    const peak = sorted[sorted.length - 1] ?? 0;
    if (peak < Math.max(0.01, floor * 10)) return { error: "The microphone did not pick up the test beep" };

    const first = magnitudes.findIndex(m => m > peak * 0.3);
    const from = first + Math.round(ECHO_GAP_MS / 1000 * sampleRate);
    let echoPeak = 0;
    for (let i = from; i < magnitudes.length; i++) echoPeak = Math.max(echoPeak, magnitudes[i]);
    if (echoPeak < Math.max(floor * 10, peak * 0.05)) return { error: "The beep did not come back through the audio path" };

    let second = from;
    while (magnitudes[second] <= echoPeak * 0.3) second++;
    return { delayMs: (second - first) / sampleRate * 1000 };
}

export function median(values: number[]) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Plays one beep on the output device and records the microphone for RUN_MS. */
async function recordBeep(context: AudioContext, source: MediaStreamAudioSourceNode) {
    const chunks: Float32Array[] = [];
    // Deprecated, but needs no worklet module, which Discord's content security policy may block.
    const recorder = context.createScriptProcessor(1024, 1, 1);
    recorder.onaudioprocess = e => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    const silent = context.createGain();
    silent.gain.value = 0;
    source.connect(recorder).connect(silent).connect(context.destination);

    const beep = context.createOscillator();
    const envelope = context.createGain();
    const at = context.currentTime + 0.1;
    beep.frequency.value = BEEP_HZ;
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(0.8, at + 0.001);
    envelope.gain.linearRampToValueAtTime(0, at + BEEP_MS / 1000);
    beep.connect(envelope).connect(context.destination);
    beep.start(at);
    beep.stop(at + BEEP_MS / 1000 + 0.01);

    await new Promise(resolve => setTimeout(resolve, RUN_MS));
    recorder.disconnect();
    source.disconnect(recorder);

    const samples = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        samples.set(chunk, offset);
        offset += chunk.length;
    }
    return samples;
}

/** Starts the test. Returns a function that ends it early. */
export function runSelfTest(options: SelfTestOptions, onUpdate: (state: SelfTestState) => void) {
    let state: SelfTestState = { running: true, connected: false, error: null, stats: null, log: [], hint: null, delayRunsMs: [], delayMs: null };
    let ended = false;
    let statsTimer: ReturnType<typeof setInterval> | null = null;
    let endTimer: ReturnType<typeof setTimeout> | null = null;

    const update = (patch: Partial<SelfTestState>) => {
        state = { ...state, ...patch };
        onUpdate(state);
    };
    const log = (who: string) => (...args: unknown[]) => {
        const line = args.map(a => typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a)).join(" ");
        update({ log: [...state.log, `${who}: ${line}`] });
    };

    const end = (error: string | null = null) => {
        if (ended) return;
        ended = true;
        if (statsTimer) clearInterval(statsTimer);
        if (endTimer) clearTimeout(endTimer);
        sender.close();
        receiver.close();
        measureStream?.getTracks().forEach(t => t.stop());
        void measureContext?.close();
        update({ running: false, error, hint: null });
    };

    let measureStream: MediaStream | null = null;
    let measureContext: AudioContext | null = null;

    async function measure() {
        update({ hint: "Hold one headphone cup directly against the microphone and keep quiet. Beeps follow in a few seconds." });
        // The jitter buffer starts high and comes down during the first seconds.
        await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
        if (ended) return;

        const { inputDeviceId, outputDeviceId } = options;
        measureStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                ...(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : {})
            }
        });
        const context = measureContext = new AudioContext();
        if (outputDeviceId && "setSinkId" in context) {
            await (context as AudioContext & { setSinkId(id: string): Promise<void>; }).setSinkId(outputDeviceId);
        }
        const source = context.createMediaStreamSource(measureStream);

        const runs: number[] = [];
        let lastError = "";
        for (let i = 0; i < RUNS && !ended; i++) {
            update({ hint: `Measuring, beep ${i + 1} of ${RUNS}. Keep the headphone on the microphone.` });
            const result = findEchoDelay(await recordBeep(context, source), context.sampleRate);
            if ("error" in result) {
                lastError = result.error;
                log("test")(`beep ${i + 1}: ${result.error}`);
            } else {
                runs.push(result.delayMs);
                log("test")(`beep ${i + 1}: ${result.delayMs.toFixed(0)} ms`);
                update({ delayRunsMs: [...runs], delayMs: median(runs) });
            }
        }
        if (runs.length < 3) end(`${lastError || "Too few beeps came back"}. Press the headphone cup right onto the microphone and raise the LAN volume or the headphone volume.`);
        else end();
    }

    const common = {
        aid: "selftest",
        inputDeviceId: options.inputDeviceId,
        outputDeviceId: options.outputDeviceId,
        volume: options.volume,
        jitterBufferMs: options.jitterBufferMs,
        peerIp: null
    };

    const sender: RtcSession = new RtcSession({
        ...common,
        offerer: true,
        send: signal => receiver.handleSignal(signal),
        onConnected: () => { },
        onFailed: reason => end(`The sending side failed: ${reason}`),
        log: log("send")
    });
    const receiver: RtcSession = new RtcSession({
        ...common,
        offerer: false,
        send: signal => sender.handleSignal(signal),
        onConnected: () => update({ connected: true }),
        onFailed: reason => end(`The receiving side failed: ${reason}`),
        log: log("recv")
    });

    // One direction only, otherwise the microphone would be heard twice.
    sender.setSendEnabled(true);
    sender.setReceiveMuted(true);
    receiver.setSendEnabled(false);
    receiver.setReceiveMuted(false);

    // Report right away, so the caller never sits on a click that shows nothing.
    update({});
    log("test")(`input device: ${options.inputDeviceId || "system default"}, output device: ${options.outputDeviceId || "system default"}`);

    // getUserMedia can stay pending forever, for example when a permission request is never answered.
    const openTimeoutMs = options.openTimeoutMs ?? 8000;
    const openTimer = setTimeout(
        () => end(`The microphone did not open within ${openTimeoutMs / 1000} seconds. Discord's window never got an answer to its microphone request.`),
        openTimeoutMs
    );

    Promise.all([sender.start(), receiver.start()]).then(() => {
        clearTimeout(openTimer);
        if (ended) return;
        let seconds = 0;
        statsTimer = setInterval(async () => {
            const [received, sent] = await Promise.all([receiver.getStats(), sender.getStats()]);
            if (ended || !received) return;
            update({ stats: { ...received, sendPacketsPerSec: sent?.sendPacketsPerSec ?? null, sendFrameMs: sent?.sendFrameMs ?? null } });
            // Keep a trail: the jitter buffer starts high and may settle over time.
            if (++seconds % 5 === 0) {
                const ms = (value: number | null) => value == null ? "n/a" : `${value.toFixed(0)} ms`;
                log("test")(`after ${seconds} s: jitter buffer ${ms(received.jitterBufferMs)}, target ${ms(received.jitterBufferTargetMs)}, minimum ${ms(received.jitterBufferMinimumMs)}, network jitter ${ms(received.jitterMs)}`);
            }
        }, 1000);
        if (options.measureDelay) {
            measure().catch(err => end(`The measurement failed: ${err instanceof Error ? err.message : String(err)}`));
            return;
        }
        endTimer = setTimeout(() => end(state.connected ? null : "The two test sessions did not connect"), options.durationMs ?? 30000);
    }, err => {
        clearTimeout(openTimer);
        end(describeMicError(err));
    });

    return () => end();
}
