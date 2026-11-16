/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Wire format of LanLink's UDP messages. Pure functions, used by native.ts.
//
// Every datagram is JSON: { b: "<json body>", mac: hmac_sha256(secret, b) }.
// The MAC covers the whole body, so SDP and candidates are authenticated too,
// not just hellos.

import { createHmac, timingSafeEqual } from "crypto";

export const PROTOCOL_VERSION = 1;

export type SignalBody =
    | { t: "offer"; aid: string; sdp: string; }
    | { t: "answer"; aid: string; sdp: string; }
    | { t: "candidate"; aid: string; candidate: RTCIceCandidateInit; }
    | { t: "bye"; aid: string; };

export interface HelloBody {
    t: "hello";
    v: number;
    uid: string;
    /** Random per start of the sender. A change means the peer restarted. */
    sid: string;
    nonce: string;
}

export function sign(secret: string, payload: string) {
    return createHmac("sha256", secret).update(payload).digest("hex");
}

export function pack(secret: string, body: object) {
    const b = JSON.stringify(body);
    return Buffer.from(JSON.stringify({ b, mac: sign(secret, b) }));
}

/** Returns the body if the datagram is well formed and signed with the secret, else null. */
export function unpack(secret: string, data: Buffer): Record<string, unknown> | null {
    try {
        const outer = JSON.parse(data.toString("utf8"));
        if (typeof outer?.b !== "string" || typeof outer?.mac !== "string") return null;
        const expected = Buffer.from(sign(secret, outer.b), "hex");
        const got = Buffer.from(outer.mac, "hex");
        if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
        const body = JSON.parse(outer.b);
        return body && typeof body === "object" && !Array.isArray(body) ? body : null;
    } catch {
        return null;
    }
}

export function isHelloFrom(body: Record<string, unknown>, peerUid: string): body is Record<string, unknown> & HelloBody {
    return body.t === "hello" && body.v === PROTOCOL_VERSION && body.uid === peerUid && typeof body.sid === "string";
}

export function isSignal(body: Record<string, unknown>): boolean {
    if (typeof body.aid !== "string") return false;
    switch (body.t) {
        case "offer":
        case "answer": return typeof body.sdp === "string";
        case "candidate": return typeof body.candidate === "object" && body.candidate !== null;
        case "bye": return true;
        default: return false;
    }
}

export interface Ipv4Interface {
    address: string;
    netmask: string;
    family: string | number;
    internal: boolean;
}

/**
 * The limited broadcast plus the directed broadcast of every real IPv4 adapter.
 * Some routers drop 255.255.255.255, and on a PC with virtual adapters (WSL,
 * VPN) it may leave on the wrong one.
 */
export function broadcastAddresses(interfaces: Record<string, Ipv4Interface[] | undefined>) {
    const out = new Set<string>(["255.255.255.255"]);
    for (const list of Object.values(interfaces)) {
        for (const iface of list ?? []) {
            if ((iface.family !== "IPv4" && iface.family !== 4) || iface.internal) continue;
            const ip = iface.address.split(".").map(Number);
            const mask = iface.netmask.split(".").map(Number);
            out.add(ip.map((octet, i) => (octet | (~mask[i] & 255))).join("."));
        }
    }
    return [...out];
}
