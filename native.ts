/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Main process side: UDP discovery and signaling transport. No audio here.
// Every export is registered as an IPC handler, so export functions only.

import { randomBytes } from "crypto";
import { createSocket, Socket } from "dgram";
import type { IpcMainInvokeEvent } from "electron";
import { networkInterfaces } from "os";

import { broadcastAddresses, isHelloFrom, isSignal, pack, PROTOCOL_VERSION, SignalBody, unpack } from "./protocol";

export interface NativeConfig {
    uid: string;
    peerUid: string;
    secret: string;
    port: number;
    manualIp: string;
}

export type NativeEvent =
    | { t: "peer"; addr: string; sid: string; }
    | { t: "peer-lost"; }
    | { t: "signal"; body: SignalBody; }
    | { t: "error"; message: string; }
    | { t: "stopped"; };

const HELLO_INTERVAL_MS = 2000;
const PEER_TIMEOUT_MS = 7000;

let socket: Socket | null = null;
let config: NativeConfig | null = null;
let helloTimer: NodeJS.Timeout | null = null;
let generation = 0;
let sessionId = "";
let peer: { addr: string; port: number; sid: string; lastSeen: number; } | null = null;
let queue: NativeEvent[] = [];
let pending: ((ev: NativeEvent) => void) | null = null;

function emit(ev: NativeEvent) {
    if (pending) {
        const resolve = pending;
        pending = null;
        resolve(ev);
    } else {
        queue.push(ev);
        if (queue.length > 500) queue.shift();
    }
}

function sendHello() {
    if (!socket || !config) return;
    const packet = pack(config.secret, {
        t: "hello",
        v: PROTOCOL_VERSION,
        uid: config.uid,
        sid: sessionId,
        nonce: randomBytes(8).toString("hex")
    });
    const port = config.port;
    const targets = new Map<string, number>();
    if (config.manualIp) targets.set(config.manualIp, port);
    else for (const addr of broadcastAddresses(networkInterfaces())) targets.set(addr, port);
    // Always answer the peer directly too. Covers the case where only one
    // side has a manual IP set or the router eats broadcasts in one direction.
    if (peer) targets.set(peer.addr, peer.port);

    for (const [addr, p] of targets) socket.send(packet, p, addr, () => { });

    if (peer && Date.now() - peer.lastSeen > PEER_TIMEOUT_MS) {
        peer = null;
        emit({ t: "peer-lost" });
    }
}

function onMessage(data: Buffer, addr: string, port: number) {
    if (!config) return;
    const body = unpack(config.secret, data);
    if (!body) return;

    if (isHelloFrom(body, config.peerUid)) {
        const changed = !peer || peer.addr !== addr || peer.sid !== body.sid;
        peer = { addr, port, sid: body.sid, lastSeen: Date.now() };
        if (changed) {
            // Answer right away so the peer knows us before our first signaling message arrives.
            sendHello();
            emit({ t: "peer", addr, sid: body.sid });
        }
        return;
    }

    // Signaling is only accepted from the address the peer's hellos come from.
    if (!peer || peer.addr !== addr || !isSignal(body)) return;
    peer.lastSeen = Date.now();
    emit({ t: "signal", body: body as SignalBody });
}

function teardown() {
    generation++;
    if (helloTimer) clearInterval(helloTimer);
    helloTimer = null;
    if (socket) {
        socket.removeAllListeners();
        socket.on("error", () => { });
        try {
            socket.close();
        } catch { }
    }
    socket = null;
    peer = null;
    config = null;
    queue = [];
    // Unblock a long-poll left over from a previous renderer (Ctrl+R).
    if (pending) {
        const resolve = pending;
        pending = null;
        resolve({ t: "stopped" });
    }
}

/** Starts discovery. Returns the generation to pass to nextMessage. */
export function start(_: IpcMainInvokeEvent, cfg: NativeConfig): Promise<{ generation: number; error?: string; }> {
    teardown();
    const gen = generation;
    config = cfg;
    sessionId = randomBytes(8).toString("hex");

    return new Promise(resolve => {
        const sock = createSocket({ type: "udp4", reuseAddr: true });
        socket = sock;

        sock.once("error", err => {
            if (generation !== gen) return;
            teardown();
            resolve({ generation: gen, error: `Could not open UDP port ${cfg.port}: ${err.message}` });
        });

        sock.on("message", (data, rinfo) => {
            if (generation === gen) onMessage(data, rinfo.address, rinfo.port);
        });

        sock.bind(cfg.port, () => {
            if (generation !== gen) return;
            sock.removeAllListeners("error");
            sock.on("error", err => emit({ t: "error", message: err.message }));
            sock.setBroadcast(true);
            sendHello();
            helloTimer = setInterval(sendHello, HELLO_INTERVAL_MS);
            resolve({ generation: gen });
        });
    });
}

export function stop(_: IpcMainInvokeEvent) {
    teardown();
}

/** Long-poll. Resolves with the next event, or "stopped" once this generation is over. */
export function nextMessage(_: IpcMainInvokeEvent, gen: number): Promise<NativeEvent> {
    if (gen !== generation || !socket) return Promise.resolve({ t: "stopped" });
    const queued = queue.shift();
    if (queued) return Promise.resolve(queued);
    if (pending) pending({ t: "stopped" });
    return new Promise(resolve => {
        pending = resolve;
    });
}

/** Sends a signaling message to the discovered peer. False if there is no peer yet. */
export function send(_: IpcMainInvokeEvent, body: SignalBody) {
    if (!socket || !peer || !config) return false;
    const packet = pack(config.secret, body);
    socket.send(packet, peer.port, peer.addr, () => { });
    return true;
}
