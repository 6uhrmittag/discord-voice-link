/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Decides whether the link is "active" and makes Discord and the LAN audio
// agree with that. No Discord imports: everything comes in through deps, so the
// rules below are unit tested (tests/automute.test.ts).
//
// The failure this file exists to prevent: the link dies, the peer stays
// locally muted in Discord, and the two can't hear each other at all.

export interface MuteRecord {
    peerId: string;
    wasMuted: boolean;
    /** Never changed by LanLink. Recorded so a restore can be checked by hand. */
    volume: number;
}

export interface ActivationDeps {
    getPeerId(): string;
    isLinkConnected(): boolean;
    isPeerInMyVoiceChannel(peerId: string): boolean;
    isSelfMuted(): boolean;
    isSelfDeafened(): boolean;
    isPushToTalk(): boolean;
    isSelfSpeaking(): boolean;
    gateOnPushToTalk(): boolean;
    isLocallyMuted(userId: string): boolean;
    getLocalVolume(userId: string): number;
    /** Returns whether the peer ended up in the requested state. */
    setLocallyMuted(userId: string, muted: boolean): boolean;
    /** Persistent storage. Must survive a crash of the client. */
    getRecord(): MuteRecord | null | undefined;
    setRecord(record: MuteRecord | null): void;
    setGates(sendEnabled: boolean, receiveMuted: boolean): void;
    setActive(active: boolean): void;
    log(...args: unknown[]): void;
}

export function createActivation(deps: ActivationDeps) {
    let wasActive = false;

    /**
     * Puts the peer's Discord local mute back to what it was before LanLink
     * muted them. Safe to call at any time and from every exit path.
     */
    function restore() {
        const record = deps.getRecord();
        if (!record) return;
        if (!record.wasMuted && !deps.setLocallyMuted(record.peerId, false)) {
            deps.log("could not unmute the peer in Discord, will retry");
            return;
        }
        deps.setRecord(null);
        deps.log("restored Discord audio for the peer");
    }

    /**
     * Active means: link connected and the peer is in our voice channel.
     * Called on every relevant event and from a watchdog timer.
     */
    function sync() {
        const peerId = deps.getPeerId();
        const active = deps.isLinkConnected() && deps.isPeerInMyVoiceChannel(peerId);

        let send = active && !deps.isSelfMuted();
        if (send && deps.gateOnPushToTalk() && deps.isPushToTalk()) send = deps.isSelfSpeaking();
        deps.setGates(send, !active || deps.isSelfDeafened());

        if (active && !wasActive) {
            // Only on the activation edge. If the user unmutes the peer by hand
            // while the link is active, that choice is left alone.
            const existing = deps.getRecord();
            if (existing && existing.peerId !== peerId) restore();
            if (!deps.getRecord()) {
                // Persist before muting, so a crash right after can still be undone.
                deps.setRecord({
                    peerId,
                    wasMuted: deps.isLocallyMuted(peerId),
                    volume: deps.getLocalVolume(peerId)
                });
            }
            if (!deps.setLocallyMuted(peerId, true)) deps.log("could not mute the peer in Discord");
        } else if (!active) {
            restore();
        }

        wasActive = active;
        deps.setActive(active);
        return active;
    }

    /** Forces the inactive state: audio gated off, Discord restored. */
    function deactivate() {
        wasActive = false;
        deps.setGates(false, true);
        deps.setActive(false);
        restore();
    }

    return { sync, restore, deactivate };
}
