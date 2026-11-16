/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Paragraph } from "@components/Paragraph";
import { debounce } from "@shared/debounce";
import { identity } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import { Select, showToast, useEffect, useState } from "@webpack/common";

import { createActivation, MuteRecord } from "./automute";
import * as discord from "./discord";
import { runSelfTest, SelfTestState } from "./selftest";
import { getLinkState, LinkState, log, setActive, setGates, setVolume, startLink, stopLink, subscribeLink } from "./state";

function DevicePicker({ kind, settingKey }: { kind: "audioinput" | "audiooutput"; settingKey: "inputDevice" | "outputDevice"; }) {
    const { [settingKey]: current } = settings.use([settingKey]);
    const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

    useEffect(() => {
        const refresh = () => navigator.mediaDevices.enumerateDevices()
            .then(all => setDevices(all.filter(d => d.kind === kind && d.deviceId !== "default" && d.deviceId !== "communications")));
        refresh();
        navigator.mediaDevices.addEventListener("devicechange", refresh);
        return () => navigator.mediaDevices.removeEventListener("devicechange", refresh);
    }, [kind]);

    const options = [
        { value: "", label: "Same as Discord" },
        ...devices.map((d, i) => ({ value: d.deviceId, label: d.label || `Device ${i + 1}` }))
    ];

    return (
        <div>
            <Paragraph weight="medium">{kind === "audioinput" ? "Input device" : "Output device"}</Paragraph>
            <Paragraph className="vc-lanlink-hint">
                {kind === "audioinput"
                    ? "Microphone sent over the LAN link."
                    : "Where the peer's LAN audio is played."}
            </Paragraph>
            <Select
                options={options}
                serialize={identity}
                isSelected={value => value === current}
                select={value => { settings.store[settingKey] = value; }}
            />
        </div>
    );
}

function useLinkState() {
    const [state, setState] = useState(getLinkState);
    useEffect(() => {
        setState(getLinkState());
        return subscribeLink(() => setState(getLinkState()));
    }, []);
    return state;
}

function describeState(state: LinkState) {
    const rtt = state.stats?.rttMs;
    switch (state.phase) {
        case "disabled": return state.detail ? `idle: ${state.detail}` : "idle";
        case "discovering": return "discovering";
        case "connecting": return state.detail ? `connecting (${state.detail})` : "connecting";
        case "connected": return `connected${rtt != null ? ` · ${rtt.toFixed(1)} ms RTT` : ""}${state.active ? "" : " · standby, not in the same voice channel"}`;
        case "failed":
        case "lost": return `${state.phase}: ${state.detail ?? "unknown"}. Retrying`;
        case "error": return `error: ${state.detail}`;
    }
}

function formatMs(value: number | null | undefined) {
    return value == null ? "n/a" : `${value.toFixed(1)} ms`;
}

function StatusPanel() {
    const state = useLinkState();
    const { showStats } = settings.use(["showStats"]);
    const { stats } = state;

    return (
        <div className="vc-lanlink-status">
            <Paragraph weight="medium">Status</Paragraph>
            <Paragraph className={`vc-lanlink-phase vc-lanlink-phase-${state.phase}`}>
                {describeState(state)}{state.peerAddr ? ` · peer at ${state.peerAddr}` : ""}
            </Paragraph>
            {showStats && state.phase === "connected" && (
                <Paragraph className="vc-lanlink-stats">
                    RTT {formatMs(stats?.rttMs)} · jitter buffer {formatMs(stats?.jitterBufferMs)} (target {formatMs(stats?.jitterBufferTargetMs)}, minimum {formatMs(stats?.jitterBufferMinimumMs)}) · jitter {formatMs(stats?.jitterMs)} · lost {stats?.packetsLost ?? 0} · sending {stats?.sendPacketsPerSec?.toFixed(0) ?? "n/a"} packets/s ({formatMs(stats?.sendFrameMs)} frames)
                </Paragraph>
            )}
            <SelfTest />
        </div>
    );
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string) {
    return Promise.race([
        promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000} seconds`)), ms))
    ]);
}

function describeSelfTest(test: SelfTestState) {
    if (test.error) return `Failed: ${test.error}`;
    if (test.running) return test.connected ? "Running. Speak: you should hear yourself with a very short delay." : "Starting...";
    return "Done.";
}

function SelfTest() {
    const [test, setTest] = useState<SelfTestState | null>(null);
    const [stop, setStop] = useState<(() => void) | null>(null);
    useEffect(() => () => stop?.(), [stop]);

    async function start() {
        const { inputDevice, outputDevice, lanVolume, jitterBufferMs } = settings.store;
        log("self-test: button pressed");
        setTest({ running: true, connected: false, error: null, stats: null, log: [] });

        let input = "", output = "";
        try {
            [input, output] = await withTimeout(Promise.all([
                discord.resolveBrowserDevice("audioinput", inputDevice),
                discord.resolveBrowserDevice("audiooutput", outputDevice)
            ]), 4000, "Listing the audio devices");
        } catch (err) {
            // Not fatal: carry on with the system default devices and say so.
            log("self-test: could not resolve devices, using the system defaults:", err);
        }

        const end = runSelfTest(
            { inputDeviceId: input, outputDeviceId: output, volume: lanVolume / 100, jitterBufferMs },
            state => {
                setTest(state);
                if (!state.running) log("self-test:", state.error ?? "done", state.stats, state.log);
            }
        );
        setStop(() => end);
    }

    const stats = test?.stats;
    return (
        <div className="vc-lanlink-selftest">
            <Button size="small" variant="secondary" disabled={test?.running} onClick={start}>
                Test audio on this PC (10 s)
            </Button>
            <Paragraph className="vc-lanlink-hint">
                Plays your own microphone back to you through the same path the LAN link uses. Needs no second PC. Wear headphones.
            </Paragraph>
            {test && <Paragraph className={test.error ? "vc-lanlink-phase-error" : undefined}>{describeSelfTest(test)}</Paragraph>}
            {stats && (
                <Paragraph className="vc-lanlink-stats">
                    jitter buffer {formatMs(stats.jitterBufferMs)} (target {formatMs(stats.jitterBufferTargetMs)}, minimum {formatMs(stats.jitterBufferMinimumMs)}) · sending {stats.sendPacketsPerSec?.toFixed(0) ?? "n/a"} packets/s ({formatMs(stats.sendFrameMs)} frames) · lost {stats.packetsLost}
                </Paragraph>
            )}
            {test && (!test.running || !test.connected) && test.log.map((line, i) => <Paragraph key={i} className="vc-lanlink-stats vc-lanlink-hint">{line}</Paragraph>)}
        </div>
    );
}

const reconfigure = debounce(() => configure(), 400);

const settings = definePluginSettings({
    status: {
        type: OptionType.COMPONENT,
        component: StatusPanel
    },
    enabled: {
        type: OptionType.BOOLEAN,
        description: "Link to the peer over the LAN when both of you are reachable.",
        default: true,
        onChange: reconfigure
    },
    peerUserId: {
        type: OptionType.STRING,
        description: "Discord user ID of the other person.",
        default: "",
        onChange: reconfigure
    },
    sharedSecret: {
        type: OptionType.STRING,
        description: "Shared secret. Both of you must enter exactly the same text.",
        default: "",
        onChange: reconfigure
    },
    port: {
        type: OptionType.NUMBER,
        description: "UDP port for discovery and signaling. Must be the same on both PCs.",
        default: 47820,
        onChange: reconfigure
    },
    manualPeerIp: {
        type: OptionType.STRING,
        description: "Peer's LAN IP address. Leave empty to find the peer by broadcast.",
        default: "",
        onChange: reconfigure
    },
    inputDevice: {
        type: OptionType.COMPONENT,
        default: "",
        component: () => <DevicePicker kind="audioinput" settingKey="inputDevice" />,
        onChange: reconfigure
    },
    outputDevice: {
        type: OptionType.COMPONENT,
        default: "",
        component: () => <DevicePicker kind="audiooutput" settingKey="outputDevice" />,
        onChange: reconfigure
    },
    lanVolume: {
        type: OptionType.SLIDER,
        description: "Volume of the peer's LAN audio. Discord's own volume slider for the peer has no effect while the link is active.",
        markers: [0, 25, 50, 75, 100],
        default: 100,
        stickToMarkers: false,
        onChange: (value: number) => setVolume(value / 100)
    },
    jitterBufferMs: {
        type: OptionType.SLIDER,
        description: "Jitter buffer target in milliseconds. 0 is the lowest latency. Raise it if the audio crackles.",
        markers: [0, 10, 20, 40, 60],
        default: 0,
        onChange: reconfigure
    },
    gateOnPushToTalk: {
        type: OptionType.BOOLEAN,
        description: "When Discord is in push to talk mode, only send LAN audio while the key is held.",
        default: true
    },
    showStats: {
        type: OptionType.BOOLEAN,
        description: "Show link statistics here and log them to the console every second.",
        default: false
    }
}).withPrivateSettings<{ muteRecord?: MuteRecord | null; }>();

let running = false;
let lastPhase = "disabled";
let watchdog: ReturnType<typeof setInterval> | null = null;
let unsubscribe: (() => void) | null = null;

// The rules for muting the peer in Discord and gating the LAN audio live in automute.ts.
const activation = createActivation({
    getPeerId: () => settings.store.peerUserId.trim(),
    isLinkConnected: () => getLinkState().phase === "connected",
    isPeerInMyVoiceChannel: discord.isPeerInMyVoiceChannel,
    isSelfMuted: discord.isSelfMuted,
    isSelfDeafened: discord.isSelfDeafened,
    isPushToTalk: discord.isPushToTalk,
    isSelfSpeaking: discord.isSelfSpeaking,
    gateOnPushToTalk: () => settings.store.gateOnPushToTalk,
    isLocallyMuted: discord.isLocallyMuted,
    getLocalVolume: discord.getLocalVolume,
    setLocallyMuted: discord.setLocallyMuted,
    getRecord: () => settings.store.muteRecord,
    setRecord: record => { settings.store.muteRecord = record; },
    setGates,
    setActive,
    log
});

function sync() {
    if (running) activation.sync();
}

function isIpv4(value: string) {
    const parts = value.split(".");
    return parts.length === 4 && parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function configure() {
    if (!running) return;
    const { enabled, peerUserId, sharedSecret, port, manualPeerIp, lanVolume, jitterBufferMs, inputDevice, outputDevice } = settings.store;
    const uid = discord.getOwnId();
    const peerUid = peerUserId.trim();
    const manualIp = manualPeerIp.trim();

    let problem: string | null = null;
    if (!enabled) problem = "";
    else if (!uid) problem = "Waiting for Discord to finish loading";
    else if (!/^\d{17,20}$/.test(peerUid)) problem = "Set the peer's user ID";
    else if (peerUid === uid) problem = "The peer's user ID is your own";
    else if (!sharedSecret) problem = "Set the shared secret";
    else if (!Number.isInteger(port) || port < 1024 || port > 65535) problem = "The port must be between 1024 and 65535";
    else if (manualIp && !isIpv4(manualIp)) problem = "The peer IP is not a valid IPv4 address";

    if (problem !== null || !uid) {
        void stopLink(problem || null);
        return;
    }

    void startLink({
        uid,
        peerUid,
        secret: sharedSecret,
        port,
        manualIp,
        volume: lanVolume / 100,
        jitterBufferMs,
        resolveDevices: async () => ({
            input: await discord.resolveBrowserDevice("audioinput", inputDevice),
            output: await discord.resolveBrowserDevice("audiooutput", outputDevice)
        })
    });
}

function onLinkChange() {
    const state = getLinkState();
    if (state.phase !== lastPhase) {
        if (state.phase === "connected") showToast({ text: "LanLink connected", variant: "success" });
        else if (lastPhase === "connected") showToast({ text: "LanLink disconnected, back on Discord audio" });
        else if (state.phase === "error") showToast({ text: `LanLink: ${state.detail}`, variant: "critical" });
        lastPhase = state.phase;
    }
    if (settings.store.showStats && state.stats) {
        const { rttMs, jitterBufferMs, jitterBufferTargetMs, jitterBufferMinimumMs, jitterMs, packetsLost, sendPacketsPerSec } = state.stats;
        log(`rtt=${formatMs(rttMs)} jitterBuffer=${formatMs(jitterBufferMs)} jbTarget=${formatMs(jitterBufferTargetMs)} jbMin=${formatMs(jitterBufferMinimumMs)} jitter=${formatMs(jitterMs)} lost=${packetsLost} sendPps=${sendPacketsPerSec?.toFixed(0) ?? "n/a"}`);
    }
    sync();
}

// Flux handlers can run before the stores have processed the same action.
const syncSoon = () => void setTimeout(sync, 0);

function LanBadge({ userId }: { userId: string; }) {
    const state = useLinkState();
    const { peerUserId } = settings.use(["peerUserId"]);
    if (!state.active || userId !== peerUserId.trim()) return null;
    return <span className="vc-lanlink-badge" title="Audio from this user comes over the LAN link">LAN</span>;
}

export default definePlugin({
    name: "LanLink",
    description: "Low latency voice over the LAN for two people who sit in the same room and share a Discord voice channel.",
    authors: [{ name: "Marv", id: 0n }],
    settings,

    patches: [
        {
            // Voice channel user row, same anchor as CallTimer.
            find: "VOICE_PANEL}}",
            replacement: {
                match: /#{intl::GUEST_NAME_SUFFIX}\)\]\}\):""(?=.*?userId:(\i\.\i))/,
                replace: "$&,$self.renderBadge($1)"
            }
        }
    ],

    flux: {
        VOICE_STATE_UPDATES: syncSoon,
        VOICE_CHANNEL_SELECT: syncSoon,
        AUDIO_TOGGLE_SELF_MUTE: syncSoon,
        AUDIO_TOGGLE_SELF_DEAF: syncSoon,
        AUDIO_SET_MODE: syncSoon,
        // The own user is not known yet when the plugin starts during Discord's boot.
        // Only then: a reconnect of Discord's gateway must not restart a healthy link.
        CONNECTION_OPEN() {
            if (getLinkState().phase === "disabled") reconfigure();
        },
        SPEAKING({ userId }: { userId: string; }) {
            if (userId === discord.getOwnId()) syncSoon();
        }
    },

    renderBadge(userId: string) {
        return (
            <ErrorBoundary noop>
                <LanBadge userId={userId} />
            </ErrorBoundary>
        );
    },

    start() {
        running = true;
        lastPhase = "disabled";
        // Left over from a crash or a killed Discord: undo it before anything else.
        activation.restore();
        unsubscribe = subscribeLink(onLinkChange);
        // Watchdog: a link that dies silently must never leave the peer muted in Discord.
        watchdog = setInterval(sync, 1000);
        window.addEventListener("beforeunload", activation.restore);
        configure();
    },

    stop() {
        running = false;
        if (watchdog) clearInterval(watchdog);
        watchdog = null;
        unsubscribe?.();
        unsubscribe = null;
        window.removeEventListener("beforeunload", activation.restore);
        void stopLink();
        activation.deactivate();
    }
});
