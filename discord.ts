/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Everything that touches Discord internals lives here. When a Discord update
// breaks LanLink, this is the file to fix.

import { MediaEngineStore, SelectedChannelStore, SpeakingStore, UserStore, VoiceActions, VoiceStateStore } from "@webpack/common";

export function getOwnId(): string | null {
    return UserStore.getCurrentUser()?.id ?? null;
}

/** True when we are in a voice channel and the peer is in the same one. */
export function isPeerInMyVoiceChannel(peerId: string) {
    const channelId = SelectedChannelStore.getVoiceChannelId();
    if (!channelId) return false;
    return VoiceStateStore.getVoiceStateForChannel(channelId, peerId) != null;
}

export function isSelfMuted() {
    return MediaEngineStore.isSelfMute() || MediaEngineStore.isSelfDeaf();
}

export function isSelfDeafened() {
    return MediaEngineStore.isSelfDeaf();
}

export function isPushToTalk() {
    return MediaEngineStore.getMode() === "PUSH_TO_TALK";
}

export function isSelfSpeaking() {
    const id = getOwnId();
    return id != null && SpeakingStore.isSpeaking(id);
}

export function isLocallyMuted(userId: string) {
    return MediaEngineStore.isLocalMute(userId);
}

export function getLocalVolume(userId: string) {
    return MediaEngineStore.getLocalVolume(userId);
}

/**
 * Sets the local (client side only) mute for a user in the normal voice context.
 * Discord only offers a toggle, so this reads the state first and reports
 * whether the store ended up where we wanted it.
 */
export function setLocallyMuted(userId: string, muted: boolean) {
    if (isLocallyMuted(userId) !== muted) VoiceActions.toggleLocalMute(userId);
    return isLocallyMuted(userId) === muted;
}

function normalize(name: string) {
    return name.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Discord's device ids are not browser deviceIds, so the device Discord uses is
 * matched to a browser device by its label. Returns "" (system default) if
 * nothing matches.
 */
export async function resolveBrowserDevice(kind: "audioinput" | "audiooutput", configuredId: string) {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === kind);
    if (configuredId) {
        return devices.some(d => d.deviceId === configuredId) ? configuredId : "";
    }

    const discordId = kind === "audioinput" ? MediaEngineStore.getInputDeviceId() : MediaEngineStore.getOutputDeviceId();
    const discordDevices = kind === "audioinput" ? MediaEngineStore.getInputDevices() : MediaEngineStore.getOutputDevices();
    const discordName = discordDevices[discordId]?.name;
    if (!discordName || discordId === "default") return "";

    const wanted = normalize(discordName);
    const real = devices.filter(d => d.deviceId !== "default" && d.deviceId !== "communications" && d.label);
    const match = real.find(d => normalize(d.label) === wanted)
        ?? real.find(d => normalize(d.label).startsWith(wanted) || wanted.startsWith(normalize(d.label)));
    return match?.deviceId ?? "";
}
