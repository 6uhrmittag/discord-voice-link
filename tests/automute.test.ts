import assert from "node:assert/strict";
import { test } from "node:test";

import { ActivationDeps, createActivation, MuteRecord } from "../automute";

const PEER = "222";

/** A fake Discord: plain state plus the deps the activation logic needs. */
function setup(initial: Partial<ReturnType<typeof makeWorld>> = {}) {
    const world = { ...makeWorld(), ...initial };
    const deps: ActivationDeps = {
        getPeerId: () => world.peerId,
        isLinkConnected: () => world.connected,
        isPeerInMyVoiceChannel: id => world.sameChannel && id === world.peerId,
        isSelfMuted: () => world.selfMuted || world.selfDeafened,
        isSelfDeafened: () => world.selfDeafened,
        isPushToTalk: () => world.pushToTalk,
        isSelfSpeaking: () => world.speaking,
        gateOnPushToTalk: () => world.gateOnPtt,
        isLocallyMuted: id => world.muted.has(id),
        getLocalVolume: () => 100,
        setLocallyMuted: (id, muted) => {
            if (world.muteBroken) return world.muted.has(id) === muted;
            if (muted) world.muted.add(id);
            else world.muted.delete(id);
            world.muteCalls.push(`${id}:${muted}`);
            return true;
        },
        getRecord: () => world.record,
        setRecord: record => { world.record = record; },
        setGates: (send, receiveMuted) => { world.gates = { send, receiveMuted }; },
        setActive: active => { world.active = active; },
        log: () => { }
    };
    return { world, activation: createActivation(deps) };
}

function makeWorld() {
    return {
        peerId: PEER,
        connected: false,
        sameChannel: false,
        selfMuted: false,
        selfDeafened: false,
        pushToTalk: false,
        speaking: false,
        gateOnPtt: true,
        muteBroken: false,
        muted: new Set<string>(),
        muteCalls: [] as string[],
        record: null as MuteRecord | null,
        gates: { send: true, receiveMuted: false },
        active: false
    };
}

test("inactive while not connected: nothing is muted, audio is gated off", () => {
    const { world, activation } = setup({ sameChannel: true });
    activation.sync();
    assert.equal(world.active, false);
    assert.equal(world.muted.has(PEER), false);
    assert.deepEqual(world.gates, { send: false, receiveMuted: true });
});

test("connected but in different channels: standby, no mute, no audio", () => {
    const { world, activation } = setup({ connected: true });
    activation.sync();
    assert.equal(world.active, false);
    assert.equal(world.muted.has(PEER), false);
    assert.deepEqual(world.gates, { send: false, receiveMuted: true });
});

test("activation mutes the peer in Discord, records the prior state and opens the audio", () => {
    const { world, activation } = setup({ connected: true, sameChannel: true });
    activation.sync();
    assert.equal(world.active, true);
    assert.equal(world.muted.has(PEER), true);
    assert.deepEqual(world.record, { peerId: PEER, wasMuted: false, volume: 100 });
    assert.deepEqual(world.gates, { send: true, receiveMuted: false });
});

for (const [name, change] of [
    ["the link drops", (w: ReturnType<typeof makeWorld>) => { w.connected = false; }],
    ["someone leaves or switches channel", (w: ReturnType<typeof makeWorld>) => { w.sameChannel = false; }]
] as const) {
    test(`when ${name}, the peer is unmuted again and the record is cleared`, () => {
        const { world, activation } = setup({ connected: true, sameChannel: true });
        activation.sync();
        change(world);
        activation.sync();
        assert.equal(world.active, false);
        assert.equal(world.muted.has(PEER), false);
        assert.equal(world.record, null);
        assert.deepEqual(world.gates, { send: false, receiveMuted: true });
    });
}

test("a peer who was already muted before activation stays muted afterwards", () => {
    const { world, activation } = setup({ connected: true, sameChannel: true, muted: new Set([PEER]) });
    activation.sync();
    assert.equal(world.record?.wasMuted, true);
    world.connected = false;
    activation.sync();
    assert.equal(world.muted.has(PEER), true);
    assert.equal(world.record, null);
});

test("crash recovery: a leftover record is undone by restore()", () => {
    const { world, activation } = setup({
        muted: new Set([PEER]),
        record: { peerId: PEER, wasMuted: false, volume: 100 }
    });
    activation.restore();
    assert.equal(world.muted.has(PEER), false);
    assert.equal(world.record, null);
});

test("crash recovery: a leftover record is also undone by the first sync (watchdog)", () => {
    const { world, activation } = setup({
        muted: new Set([PEER]),
        record: { peerId: PEER, wasMuted: false, volume: 100 }
    });
    activation.sync();
    assert.equal(world.muted.has(PEER), false);
    assert.equal(world.record, null);
});

test("a leftover record is not overwritten when the link activates again before a restore", () => {
    // Crash while active, restart, link comes straight back: wasMuted must stay "false".
    const { world, activation } = setup({
        connected: true,
        sameChannel: true,
        muted: new Set([PEER]),
        record: { peerId: PEER, wasMuted: false, volume: 100 }
    });
    activation.sync();
    assert.equal(world.record?.wasMuted, false);
    world.connected = false;
    activation.sync();
    assert.equal(world.muted.has(PEER), false);
});

test("the peer is muted once per activation: a manual unmute is not fought", () => {
    const { world, activation } = setup({ connected: true, sameChannel: true });
    activation.sync();
    world.muted.delete(PEER);
    activation.sync();
    activation.sync();
    assert.equal(world.muted.has(PEER), false);
    assert.deepEqual(world.muteCalls, [`${PEER}:true`]);
});

test("restore is retried while Discord refuses the unmute, and the record is kept until it works", () => {
    const { world, activation } = setup({ connected: true, sameChannel: true });
    activation.sync();
    world.connected = false;
    world.muteBroken = true;
    activation.sync();
    assert.notEqual(world.record, null);
    assert.equal(world.muted.has(PEER), true);

    world.muteBroken = false;
    activation.sync();
    assert.equal(world.record, null);
    assert.equal(world.muted.has(PEER), false);
});

test("changing the peer id restores the old peer before muting the new one", () => {
    const { world, activation } = setup({
        connected: true,
        sameChannel: true,
        peerId: "333",
        muted: new Set([PEER]),
        record: { peerId: PEER, wasMuted: false, volume: 100 }
    });
    activation.sync();
    assert.equal(world.muted.has(PEER), false);
    assert.equal(world.muted.has("333"), true);
    assert.equal(world.record?.peerId, "333");
});

test("self-mute stops outgoing audio but keeps incoming audio", () => {
    const { world, activation } = setup({ connected: true, sameChannel: true, selfMuted: true });
    activation.sync();
    assert.deepEqual(world.gates, { send: false, receiveMuted: false });
});

test("self-deafen stops both directions", () => {
    const { world, activation } = setup({ connected: true, sameChannel: true, selfDeafened: true });
    activation.sync();
    assert.deepEqual(world.gates, { send: false, receiveMuted: true });
});

test("push to talk: outgoing audio follows the speaking state", () => {
    const { world, activation } = setup({ connected: true, sameChannel: true, pushToTalk: true });
    activation.sync();
    assert.equal(world.gates.send, false);
    world.speaking = true;
    activation.sync();
    assert.equal(world.gates.send, true);
});

test("push to talk gating can be switched off", () => {
    const { world, activation } = setup({ connected: true, sameChannel: true, pushToTalk: true, gateOnPtt: false });
    activation.sync();
    assert.equal(world.gates.send, true);
});

test("deactivate (plugin stop) restores Discord and gates the audio off", () => {
    const { world, activation } = setup({ connected: true, sameChannel: true });
    activation.sync();
    activation.deactivate();
    assert.equal(world.muted.has(PEER), false);
    assert.equal(world.record, null);
    assert.equal(world.active, false);
    assert.deepEqual(world.gates, { send: false, receiveMuted: true });
});

test("after a deactivate the next activation mutes again", () => {
    const { world, activation } = setup({ connected: true, sameChannel: true });
    activation.sync();
    activation.deactivate();
    activation.sync();
    assert.equal(world.muted.has(PEER), true);
    assert.deepEqual(world.record, { peerId: PEER, wasMuted: false, volume: 100 });
});
