/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// WebRTC audio session. No Discord imports, so this file also runs in plain
// Chrome (see dev/rtc-test.html).

// Same shape as SignalBody in protocol.ts. Repeated here so this file has no imports.
export type RtcSignal =
    | { t: "offer"; aid: string; sdp: string; }
    | { t: "answer"; aid: string; sdp: string; }
    | { t: "candidate"; aid: string; candidate: RTCIceCandidateInit; }
    | { t: "bye"; aid: string; };

export interface RtcStats {
    rttMs: number | null;
    jitterBufferMs: number | null;
    /** Delay the jitter buffer is aiming for. Shows whether a 0 ms target is honoured. */
    jitterBufferTargetMs: number | null;
    /** Lowest delay the jitter buffer considers possible, per its own estimate. */
    jitterBufferMinimumMs: number | null;
    jitterMs: number | null;
    packetsLost: number;
    sendPacketsPerSec: number | null;
}

export interface RtcOptions {
    /** Attempt id. Signals carrying a different id are ignored. */
    aid: string;
    offerer: boolean;
    /** Browser deviceId, or "" for the system default. */
    inputDeviceId: string;
    /** Browser sink id, or "" for the system default. */
    outputDeviceId: string;
    /** 0..1 */
    volume: number;
    jitterBufferMs: number;
    /** Peer address known from discovery. Used to replace mDNS (.local) host candidates. */
    peerIp: string | null;
    send(signal: RtcSignal): void;
    onConnected(): void;
    /** Called at most once. The session is closed afterwards. */
    onFailed(reason: string): void;
    log(...args: unknown[]): void;
}

const DISCONNECT_GRACE_MS = 3000;

const OPUS_PARAMS: Record<string, string> = {
    minptime: "10",
    useinbandfec: "0",
    stereo: "0",
    usedtx: "0",
    maxaveragebitrate: "64000"
};

/**
 * Forces 10 ms Opus frames with FEC and DTX off. These attributes describe what
 * the describing side wants to receive, so this is applied to both local and
 * remote descriptions. Idempotent.
 */
export function mungeOpus(sdp: string) {
    const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
    const lines = sdp.split(/\r?\n/);
    const out: string[] = [];
    let inAudio = false;
    let opusPt: string | null = null;
    let sawFmtp = false;
    let rtpmapIndex = -1;

    const fmtpLine = (existing: string) => {
        const params = new Map<string, string>();
        for (const part of existing.split(";")) {
            const [key, value] = part.trim().split("=");
            if (key) params.set(key, value ?? "");
        }
        for (const [key, value] of Object.entries(OPUS_PARAMS)) params.set(key, value);
        return `a=fmtp:${opusPt} ${[...params].map(([k, v]) => v === "" ? k : `${k}=${v}`).join(";")}`;
    };

    const closeAudio = () => {
        if (!inAudio || !opusPt) return;
        if (!sawFmtp) out.splice(rtpmapIndex + 1, 0, fmtpLine(""));
        out.push("a=ptime:10", "a=maxptime:10");
    };

    for (const line of lines) {
        if (line.startsWith("m=")) {
            closeAudio();
            inAudio = line.startsWith("m=audio");
            opusPt = null;
            sawFmtp = false;
        }
        if (inAudio) {
            if (line.startsWith("a=ptime:") || line.startsWith("a=maxptime:")) continue;
            const rtpmap = /^a=rtpmap:(\d+) opus\/48000/i.exec(line);
            if (rtpmap) {
                opusPt = rtpmap[1];
                rtpmapIndex = out.length;
            } else if (opusPt && line.startsWith(`a=fmtp:${opusPt} `)) {
                sawFmtp = true;
                out.push(fmtpLine(line.slice(line.indexOf(" ") + 1)));
                continue;
            }
        }
        out.push(line);
    }

    // The SDP ends with an empty line; keep the appended attributes before it.
    const trailing = out.length && out[out.length - 1] === "" ? out.pop() : undefined;
    closeAudio();
    if (trailing !== undefined) out.push(trailing);
    return out.join(eol);
}

/** Replaces an obfuscated "<uuid>.local" host address with the peer's real LAN address. */
export function rewriteMdnsCandidate(candidate: RTCIceCandidateInit, peerIp: string | null): RTCIceCandidateInit {
    if (!peerIp || !candidate.candidate) return candidate;
    const parts = candidate.candidate.split(" ");
    if (parts.length < 8 || !parts[4].endsWith(".local")) return candidate;
    parts[4] = peerIp;
    return { ...candidate, candidate: parts.join(" ") };
}

export function describeMicError(err: unknown) {
    const name = err instanceof DOMException ? err.name : "";
    if (name === "NotReadableError") return "The microphone could not be opened. Another app probably has it in exclusive mode (Windows Sound settings, Advanced, exclusive control).";
    if (name === "NotAllowedError") return "Microphone access was denied for the Discord window.";
    if (name === "NotFoundError" || name === "OverconstrainedError") return "The selected input device was not found. Pick another one in the LanLink settings.";
    return `Could not open the microphone: ${err instanceof Error ? err.message : String(err)}`;
}

export class RtcSession {
    private pc: RTCPeerConnection | null = null;
    private micStream: MediaStream | null = null;
    private audio: HTMLAudioElement | null = null;
    private pendingCandidates: RTCIceCandidateInit[] = [];
    private remoteSet = false;
    private closed = false;
    private everConnected = false;
    private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private sendEnabled = false;
    private receiveMuted = true;
    private lastStats: { at: number; delay: number; target: number; minimum: number; emitted: number; sent: number; } | null = null;
    // Signals are processed strictly in order, and only once start() has finished.
    private chain: Promise<void> = Promise.resolve();

    constructor(private readonly opts: RtcOptions) { }

    get aid() {
        return this.opts.aid;
    }

    /** Opens the mic and, for the offerer, sends the offer. Rejects if the mic cannot be opened. */
    start() {
        const started = this.open();
        this.chain = started.catch(() => { });
        return started;
    }

    /** Queues a signal from the peer. Safe to call before start() has resolved. */
    handleSignal(signal: RtcSignal) {
        this.chain = this.chain
            .then(() => this.process(signal))
            .catch(err => this.opts.log(`failed to process ${signal.t}:`, err));
    }

    private async open() {
        const { inputDeviceId } = this.opts;
        const constraints = {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 1,
            // "latency" is honoured by Chromium but missing from the TS lib types.
            latency: 0,
            ...(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : {})
        } as MediaTrackConstraints;

        const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
        if (this.closed) {
            stream.getTracks().forEach(t => t.stop());
            return;
        }
        this.micStream = stream;
        const [track] = stream.getAudioTracks();
        track.enabled = this.sendEnabled;
        this.opts.log("mic opened:", track.label, track.getSettings());

        const pc = this.pc = new RTCPeerConnection({ iceServers: [] });
        pc.addTrack(track, stream);

        pc.onicecandidate = e => {
            if (e.candidate) this.opts.send({ t: "candidate", aid: this.aid, candidate: e.candidate.toJSON() });
        };
        pc.oniceconnectionstatechange = () => this.onIceState();
        pc.ontrack = e => this.onTrack(e);

        if (this.opts.offerer) {
            const offer = await pc.createOffer();
            const sdp = mungeOpus(offer.sdp ?? "");
            await pc.setLocalDescription({ type: "offer", sdp });
            this.opts.send({ t: "offer", aid: this.aid, sdp });
        }
    }

    private async process(signal: RtcSignal) {
        const { pc } = this;
        if (this.closed || !pc || signal.aid !== this.aid) return;

        if (signal.t === "offer" && !this.opts.offerer) {
            await pc.setRemoteDescription({ type: "offer", sdp: mungeOpus(signal.sdp) });
            await this.flushCandidates();
            const answer = await pc.createAnswer();
            const sdp = mungeOpus(answer.sdp ?? "");
            await pc.setLocalDescription({ type: "answer", sdp });
            this.opts.send({ t: "answer", aid: this.aid, sdp });
        } else if (signal.t === "answer" && this.opts.offerer) {
            await pc.setRemoteDescription({ type: "answer", sdp: mungeOpus(signal.sdp) });
            await this.flushCandidates();
        } else if (signal.t === "candidate") {
            const candidate = rewriteMdnsCandidate(signal.candidate, this.opts.peerIp);
            if (!this.remoteSet) this.pendingCandidates.push(candidate);
            else await pc.addIceCandidate(candidate).catch(err => this.opts.log("addIceCandidate failed:", err));
        }
    }

    private async flushCandidates() {
        this.remoteSet = true;
        const queued = this.pendingCandidates;
        this.pendingCandidates = [];
        for (const candidate of queued) {
            await this.pc?.addIceCandidate(candidate).catch(err => this.opts.log("addIceCandidate failed:", err));
        }
    }

    private onIceState() {
        const state = this.pc?.iceConnectionState;
        this.opts.log("ice state:", state);
        if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
        this.disconnectTimer = null;

        if (state === "connected" || state === "completed") {
            if (!this.everConnected) {
                this.everConnected = true;
                this.opts.onConnected();
            }
        } else if (state === "failed") {
            this.fail("ICE failed");
        } else if (state === "disconnected") {
            this.disconnectTimer = setTimeout(() => this.fail("Connection lost"), DISCONNECT_GRACE_MS);
        }
    }

    private onTrack(e: RTCTrackEvent) {
        const { jitterBufferMs, outputDeviceId, volume, log } = this.opts;
        const { receiver } = e;

        if ("jitterBufferTarget" in receiver) {
            receiver.jitterBufferTarget = jitterBufferMs;
            log(`jitterBufferTarget set to ${jitterBufferMs} ms`);
        } else if ("playoutDelayHint" in receiver) {
            (receiver as { playoutDelayHint: number; }).playoutDelayHint = jitterBufferMs / 1000;
            log(`playoutDelayHint (legacy) set to ${jitterBufferMs} ms`);
        } else {
            log("no jitter buffer control available on this Chromium");
        }

        // Remote WebRTC audio only plays reliably through a media element.
        const audio = this.audio = new Audio();
        audio.autoplay = true;
        audio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
        audio.volume = volume;
        audio.muted = this.receiveMuted;
        if (outputDeviceId) {
            audio.setSinkId(outputDeviceId).catch(err => log("setSinkId failed, using default output:", err));
        }
        audio.play().catch(err => log("audio.play failed:", err));
    }

    private fail(reason: string) {
        if (this.closed) return;
        this.close();
        this.opts.onFailed(reason);
    }

    /** Gates the outgoing mic track. */
    setSendEnabled(enabled: boolean) {
        this.sendEnabled = enabled;
        const track = this.micStream?.getAudioTracks()[0];
        if (track) track.enabled = enabled;
    }

    /** Silences incoming LAN audio. */
    setReceiveMuted(muted: boolean) {
        this.receiveMuted = muted;
        if (this.audio) this.audio.muted = muted;
    }

    setVolume(volume: number) {
        this.opts.volume = volume;
        if (this.audio) this.audio.volume = volume;
    }

    async getStats(): Promise<RtcStats | null> {
        if (!this.pc || this.closed) return null;
        const report = await this.pc.getStats();
        const stats: RtcStats = { rttMs: null, jitterBufferMs: null, jitterBufferTargetMs: null, jitterBufferMinimumMs: null, jitterMs: null, packetsLost: 0, sendPacketsPerSec: null };
        let delay = 0, target = 0, minimum = 0, emitted = 0, sent = 0;

        report.forEach(s => {
            if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded" && typeof s.currentRoundTripTime === "number") {
                stats.rttMs = s.currentRoundTripTime * 1000;
            } else if (s.type === "inbound-rtp" && s.kind === "audio") {
                delay = s.jitterBufferDelay ?? 0;
                target = s.jitterBufferTargetDelay ?? 0;
                minimum = s.jitterBufferMinimumDelay ?? 0;
                emitted = s.jitterBufferEmittedCount ?? 0;
                stats.packetsLost = s.packetsLost ?? 0;
                if (typeof s.jitter === "number") stats.jitterMs = s.jitter * 1000;
            } else if (s.type === "outbound-rtp" && s.kind === "audio") {
                sent = s.packetsSent ?? 0;
            }
        });

        // Report the jitter buffer delays over the last interval, not the lifetime average.
        const now = performance.now();
        const last = this.lastStats ?? { at: now, delay: 0, target: 0, minimum: 0, emitted: 0, sent: 0 };
        const samples = emitted - last.emitted;
        if (samples > 0) {
            stats.jitterBufferMs = (delay - last.delay) / samples * 1000;
            stats.jitterBufferTargetMs = (target - last.target) / samples * 1000;
            stats.jitterBufferMinimumMs = (minimum - last.minimum) / samples * 1000;
        }
        if (this.lastStats) stats.sendPacketsPerSec = (sent - last.sent) / ((now - last.at) / 1000);
        this.lastStats = { at: now, delay, target, minimum, emitted, sent };
        return stats;
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
        this.micStream?.getTracks().forEach(t => t.stop());
        if (this.audio) {
            this.audio.pause();
            this.audio.srcObject = null;
        }
        if (this.pc) {
            this.pc.onicecandidate = this.pc.oniceconnectionstatechange = this.pc.ontrack = null;
            this.pc.close();
        }
        this.micStream = null;
        this.audio = null;
        this.pc = null;
    }
}
