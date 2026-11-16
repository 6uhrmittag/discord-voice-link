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
}

export interface SelfTestState {
    running: boolean;
    connected: boolean;
    error: string | null;
    /** Stats of the receiving side, with the sending side's packet rate and frame size. */
    stats: RtcStats | null;
    log: string[];
}

/** Starts the test. Returns a function that ends it early. */
export function runSelfTest(options: SelfTestOptions, onUpdate: (state: SelfTestState) => void) {
    let state: SelfTestState = { running: true, connected: false, error: null, stats: null, log: [] };
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
        update({ running: false, error });
    };

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
        statsTimer = setInterval(async () => {
            const [received, sent] = await Promise.all([receiver.getStats(), sender.getStats()]);
            if (!ended && received) update({ stats: { ...received, sendPacketsPerSec: sent?.sendPacketsPerSec ?? null, sendFrameMs: sent?.sendFrameMs ?? null } });
        }, 1000);
        endTimer = setTimeout(() => end(state.connected ? null : "The two test sessions did not connect"), options.durationMs ?? 10000);
    }, err => {
        clearTimeout(openTimer);
        end(describeMicError(err));
    });

    return () => end();
}
