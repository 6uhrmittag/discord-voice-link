/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Link state machine. Drives discovery (native.ts) and the audio session
// (rtc.ts). Knows nothing about Discord's stores: whether the link is "active"
// (peer muted in Discord, audio flowing) is decided in index.tsx and pushed in
// through setGates/setActive.
//
//   disabled → discovering → connecting → connected
//                   ↑             │            │
//                   └──── failed ←┴── lost ←───┘
//
// "error" is terminal until the link is restarted (bad config, port in use,
// microphone unavailable).

import type { PluginNative } from "@utils/types";

import type { NativeEvent } from "./native";
import type { SignalBody } from "./protocol";
import { describeMicError, RtcOptions, RtcSession, RtcStats } from "./rtc";

export type NativeApi = PluginNative<typeof import("./native")>;
export type LinkSession = Pick<RtcSession, "aid" | "start" | "handleSignal" | "setSendEnabled" | "setReceiveMuted" | "setVolume" | "getStats" | "close">;

// Replaceable so the state machine can be tested without Electron or WebRTC.
const deps: { native: NativeApi | null; createSession(opts: RtcOptions): LinkSession; } = {
    native: null,
    createSession: opts => new RtcSession(opts)
};

export function setLinkDeps(overrides: Partial<typeof deps>) {
    Object.assign(deps, overrides);
}

const Native: NativeApi = {
    start: cfg => getNative().start(cfg),
    stop: () => getNative().stop(),
    nextMessage: gen => getNative().nextMessage(gen),
    send: body => getNative().send(body)
};

function getNative() {
    return deps.native ??= VencordNative.pluginHelpers.LanLink as NativeApi;
}

export type LinkPhase = "disabled" | "discovering" | "connecting" | "connected" | "failed" | "lost" | "error";

export interface LinkState {
    phase: LinkPhase;
    detail: string | null;
    peerAddr: string | null;
    /** connected and both users are in the same voice channel */
    active: boolean;
    stats: RtcStats | null;
}

export interface LinkConfig {
    uid: string;
    peerUid: string;
    secret: string;
    port: number;
    manualIp: string;
    volume: number;
    jitterBufferMs: number;
    lowLatencyOutput: boolean;
    resolveDevices(): Promise<{ input: string; output: string; }>;
}

const CONNECT_TIMEOUT_MS = 8000;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30000;
const STATS_INTERVAL_MS = 1000;

export function log(...args: unknown[]) {
    console.log("[LanLink]", ...args);
}

export const NOT_STARTED = "Plugin not started. Restart Discord if you just enabled it";

let state: LinkState = { phase: "disabled", detail: NOT_STARTED, peerAddr: null, active: false, stats: null };
const listeners = new Set<() => void>();

let config: LinkConfig | null = null;
let runId = 0;
let peer: { addr: string; sid: string; } | null = null;
let session: LinkSession | null = null;
let attempts = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let connectTimer: ReturnType<typeof setTimeout> | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;
let gates = { sendEnabled: false, receiveMuted: true };
// Signals that arrive while a session for their attempt is still being set up.
let startingAid: string | null = null;
let earlySignals: SignalBody[] = [];

export function getLinkState() {
    return state;
}

export function subscribeLink(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
}

function update(patch: Partial<LinkState>) {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
}

function setPhase(phase: LinkPhase, detail: string | null = null) {
    if (phase !== state.phase || detail !== state.detail) log(`state: ${phase}${detail ? ` (${detail})` : ""}`);
    update({ phase, detail, peerAddr: peer?.addr ?? null, ...(phase === "connected" ? {} : { stats: null }) });
}

export function setActive(active: boolean) {
    if (state.active !== active) update({ active });
}

/** Applies the audio gates to the current session and every later one. */
export function setGates(sendEnabled: boolean, receiveMuted: boolean) {
    gates = { sendEnabled, receiveMuted };
    session?.setSendEnabled(sendEnabled);
    session?.setReceiveMuted(receiveMuted);
}

export function setVolume(volume: number) {
    if (config) config.volume = volume;
    session?.setVolume(volume);
}

function isOfferer() {
    // Lower Discord user id offers. Deterministic, so there is no glare.
    return config != null && BigInt(config.uid) < BigInt(config.peerUid);
}

function clearTimers() {
    if (retryTimer) clearTimeout(retryTimer);
    if (connectTimer) clearTimeout(connectTimer);
    if (statsTimer) clearInterval(statsTimer);
    retryTimer = connectTimer = statsTimer = null;
}

function closeSession() {
    clearTimers();
    startingAid = null;
    session?.close();
    session = null;
}

function scheduleRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    const delay = Math.min(RETRY_BASE_MS * 2 ** attempts, RETRY_MAX_MS);
    attempts++;
    const run = runId;
    retryTimer = setTimeout(() => {
        retryTimer = null;
        if (run !== runId) return;
        if (!peer) setPhase("discovering");
        else if (isOfferer()) void beginSession(newAttemptId());
        else setPhase("connecting", "Waiting for the peer to reconnect");
    }, delay);
}

function newAttemptId() {
    return crypto.randomUUID();
}

function onSessionFailed(failed: LinkSession, reason: string) {
    if (session !== failed) return;
    const wasConnected = state.phase === "connected";
    const { aid } = failed;
    closeSession();
    setPhase(wasConnected ? "lost" : "failed", reason);
    // Tell the other side so it does not sit on a dead session.
    void Native.send({ t: "bye", aid });
    scheduleRetry();
}

async function beginSession(aid: string, offer?: SignalBody) {
    const cfg = config;
    if (!cfg || !peer) return;
    const run = runId;
    closeSession();
    startingAid = aid;
    earlySignals = [];
    setPhase("connecting");

    // Device lookup must never stall or break a connection attempt: fall back to the system defaults.
    const devices = await Promise.race([
        cfg.resolveDevices(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 4000))
    ]).catch(err => {
        log("could not resolve the audio devices, using the system defaults:", err);
        return { input: "", output: "" };
    });
    if (run !== runId || session || startingAid !== aid) return;
    startingAid = null;

    const created: LinkSession = deps.createSession({
        aid,
        offerer: isOfferer(),
        inputDeviceId: devices.input,
        outputDeviceId: devices.output,
        volume: cfg.volume,
        jitterBufferMs: cfg.jitterBufferMs,
        lowLatencyOutput: cfg.lowLatencyOutput,
        peerIp: peer.addr,
        send: signal => void Native.send(signal),
        onConnected: () => {
            if (session !== created) return;
            if (connectTimer) clearTimeout(connectTimer);
            connectTimer = null;
            attempts = 0;
            setPhase("connected");
            statsTimer = setInterval(async () => {
                const stats = await created.getStats();
                if (session === created && stats) update({ stats });
            }, STATS_INTERVAL_MS);
        },
        onFailed: reason => onSessionFailed(created, reason),
        log
    });
    session = created;
    created.setSendEnabled(gates.sendEnabled);
    created.setReceiveMuted(gates.receiveMuted);

    connectTimer = setTimeout(() => {
        if (session !== created) return;
        created.close();
        onSessionFailed(created, "Connection attempt timed out");
    }, CONNECT_TIMEOUT_MS);

    try {
        const started = created.start();
        if (offer) created.handleSignal(offer);
        for (const signal of earlySignals) created.handleSignal(signal);
        earlySignals = [];
        await started;
    } catch (err) {
        if (session !== created) return;
        // No retry loop here: a mic that cannot be opened will not fix itself.
        closeSession();
        setPhase("error", describeMicError(err));
    }
}

function onNativeEvent(ev: NativeEvent) {
    if (state.phase === "error") return;

    switch (ev.t) {
        case "peer": {
            const same = peer?.addr === ev.addr && peer.sid === ev.sid;
            peer = { addr: ev.addr, sid: ev.sid };
            // Hellos resuming for a session that never dropped: nothing to do.
            if (same && session) return;
            log(`peer found at ${ev.addr}`);
            attempts = 0;
            closeSession();
            if (isOfferer()) void beginSession(newAttemptId());
            else setPhase("connecting", "Waiting for the peer's offer");
            break;
        }
        case "peer-lost":
            // While connected, ICE decides whether the link is dead, not missing hellos.
            if (state.phase === "connected") return;
            peer = null;
            closeSession();
            setPhase("discovering");
            break;
        case "signal": {
            const { body } = ev;
            if (body.t === "offer") {
                if (!isOfferer()) void beginSession(body.aid, body);
            } else if (body.t === "bye") {
                if (session?.aid !== body.aid) return;
                const wasConnected = state.phase === "connected";
                closeSession();
                setPhase(wasConnected ? "lost" : "failed", "The peer closed the link");
                scheduleRetry();
            } else if (session) {
                // Messages from an earlier attempt must not reach the current session.
                if (session.aid === body.aid) session.handleSignal(body);
            } else if (body.aid === startingAid) {
                earlySignals.push(body);
            }
            break;
        }
        case "error":
            log("socket error:", ev.message);
            break;
    }
}

async function pollLoop(run: number, generation: number) {
    while (run === runId) {
        const ev = await Native.nextMessage(generation);
        if (run !== runId || ev.t === "stopped") return;
        try {
            onNativeEvent(ev);
        } catch (err) {
            log("failed to handle", ev.t, err);
        }
    }
}

export async function startLink(cfg: LinkConfig) {
    const run = ++runId;
    closeSession();
    peer = null;
    attempts = 0;
    config = cfg;
    setPhase("discovering");

    const result = await Native.start({
        uid: cfg.uid,
        peerUid: cfg.peerUid,
        secret: cfg.secret,
        port: cfg.port,
        manualIp: cfg.manualIp
    });
    if (run !== runId) return;
    if (result.error) {
        setPhase("error", `${result.error}. Is another program using the port?`);
        return;
    }
    void pollLoop(run, result.generation);
}

export async function stopLink(detail: string | null = null) {
    runId++;
    if (session) void Native.send({ t: "bye", aid: session.aid });
    closeSession();
    peer = null;
    config = null;
    setPhase("disabled", detail);
    await Native.stop();
}
