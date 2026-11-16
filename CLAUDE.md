# LanLink — Equicord userplugin for local voice between two PCs

Repo: https://github.com/6uhrmittag/discord-voice-link (public)
Project brief for Claude Code. You are starting cold; everything you need is here.

---

## Why this exists

Marv and Void (Void uses they/them) sit next to each other at two Windows gaming PCs and talk
over a Discord voice call, both on wired headphones (Marv's are noise-canceling). Discord adds
roughly 100–200 ms mouth-to-ear. At arm's length that is confusing: you half-hear the real
voice, then the delayed copy.

LanLink opens a direct WebRTC audio link between their two Discord clients when both are in
the same voice channel and on the same LAN, and **locally mutes each other in Discord**. Remote
friends keep hearing both through Discord.

**Goal:** ~35–60 ms mouth-to-ear. Below ~40 ms the LAN audio fuses with the leaked real voice
instead of sounding like an echo. That is the goal, not a benchmark number.

**This is a prototype for two specific PCs.** Not for upstream Equicord.

Both PCs: Windows, Ethernet, same router, wired headphones, USB mics.

---

## How we work

- **Marv is usually gaming while you work.** Don't block on him. Make the reasonable call, say
  what you decided, keep going. Only stop for irreversible choices.
- **This project is 100% AI-written and we say so openly** (README disclaimer). Keep that.
- **Be exact about what is proven.** "Tested" means CI ran it. Anything that needs two real PCs
  stays in the README's "Not tested yet" list until Marv or Void report it worked. Never tick
  those boxes yourself.
- **README is the only user guide.** Written for Void: a person who installs things but does
  not build software. Plain words, no internals in the user sections.
- **CI builds and releases.** Every push to `main` that passes becomes a release Void's Discord
  updates to by itself. So `main` must always be something you'd let Void run tonight. Work on
  a branch + PR when a change is risky; small safe fixes can go to `main` directly.
- Never force-push `main`.
- Don't run heavy local work on Marv's PC while he plays (no local Equicord builds on the
  Windows side). The WSL side and CI are fine.

### What only Marv and Void can do

Anything in the README's "Not tested yet" list: installing on a real PC, audio between two PCs,
restore paths in the real client, the pill, push to talk, the clap test. When they report
results, update the README (tick the box, fill the latency table) in the same change as any fix.

---

## Guardrails (hard rules)

- **LAN only.** No STUN/TURN, no external endpoints. If ICE can't connect on host candidates,
  that is a bug to fix, not a reason to add a server.
- **Don't touch Discord's voice transport.** No patching of `discord_voice`, no reading or
  injecting Discord's RTP. LanLink runs next to Discord's voice engine, not inside it.
- **No Discord API automation.** No messages, no REST calls on the user's behalf. Signaling
  goes over the LAN socket only.
- **Local-only effects.** Local mute is the only thing changed in Discord. Nothing remote
  users can see.
- **Restore Discord audio on every exit path.** Matters more than any feature. The failure to
  avoid: link dies silently, the peer stays muted in Discord, they can't hear each other at
  all. Every change to `automute.ts` or its wiring needs a test.
- **No native audio addon** (PortAudio etc.). It would need recompiling for every Electron
  bump. If WebRTC latency is not good enough, report the measured numbers and stop; the
  fallback is SonoBus for audio, with LanLink reduced to discovery + auto-mute + pill.
- **No secrets in the repo.** User IDs and the shared secret live in plugin settings only.

---

## Architecture

```
index.tsx     plugin definition, settings, flux listeners, pill patch, status UI (renderer)
automute.ts   "active" = connected && same voice channel; mute/restore + audio gates. Pure, deps injected
state.ts      link state machine; drives native.ts and rtc.ts. Deps replaceable for tests
rtc.ts        WebRTC session. No imports at all, runs in plain Chrome (dev/rtc-test.html)
selftest.ts   one-PC audio test (two RtcSessions wired together), button in the settings panel
native.ts     Electron main process: UDP socket, hellos, signaling transport, long-poll to renderer
protocol.ts   wire format + HMAC. Pure
discord.ts    ALL access to Discord stores/actions. Discord updates break things here: one file to fix
```

- Renderer has WebRTC but no UDP sockets; main process has UDP but no WebRTC. So `native.ts`
  discovers and carries signaling, the renderer does audio.
- Every export of `native.ts` becomes an IPC handler: export functions only, first parameter is
  the IPC event. Helpers go in `protocol.ts`.
- Main → renderer is a long-poll (`nextMessage(generation)`). The main process outlives a
  renderer reload (Ctrl+R), so `start()` resets everything and bumps the generation.
- State machine: `disabled → discovering → connecting → connected`, `failed`/`lost` retry with
  backoff (1 s … 30 s), `error` is terminal until restart (port in use, mic unavailable).
- Lower user ID offers. Messages carry an attempt id (`aid`); hellos carry a per-start session
  id (`sid`) so a restarted peer is noticed.
- Audio is gated on **active**, not on connected. Otherwise the mic would be live to the peer
  whenever both Discords are open.
- Opus: 10 ms frames, FEC off, DTX off, via SDP munging on local *and* remote descriptions.
  `jitterBufferTarget = 0` on the receiver. Proof it took: ~100 packets/s, and the jitter
  buffer numbers in the stats.

### Packaging

Equicord compiles userplugins in; there is no runtime loading. So a release is a whole
Equicord build (`desktop.asar`) with LanLink inside:

- `equicord.ref` pins the Equicord commit. CI builds with `EQUICORD_REMOTE` = this repo and
  `EQUICORD_HASH` = our commit, so the build's own updater follows **our** releases.
- Equicord's updater takes the commit from the **last word of the release title** and downloads
  the asset named `desktop.asar`. Don't change either.
- `tools/install.ps1` swaps `%APPDATA%\Equicord\equicord.asar` on a PC that has the normal
  Equicord installer build.
- Daily schedule: build against Equicord's newest commit; if green, bump `equicord.ref` on
  `main` and trigger a release run. If red, the old pin stays and the run fails visibly.

---

## Testing

```
npm ci
npm test            # node:test via tsx: protocol, native (real UDP on localhost), automute, state, rtc helpers
npm run test:rtc    # two RtcSessions in headless Chrome with a fake mic
```

CI additionally type-checks and builds the plugin inside Equicord. To do that locally (WSL):
clone Equicord somewhere outside this repo, copy `*.ts *.tsx *.css` into
`src/userplugins/lanLink/` (a real copy, the build ignores symlinks), `pnpm install`,
`pnpm testTsc`, `pnpm build`. Equicord needs Node 22+ and the pnpm version in its `package.json`.

`pnpm build` is esbuild and does **not** type-check; always run `pnpm testTsc` too.

The Chrome test checks the frame size as captured audio per packet (`sendFrameMs`), not as
packets per second: the fake microphone's timer slips when the machine is busy.

Code style follows Equicord where cheap: SPDX header on every source file, no `any`, natural
text in messages. Equicord's own `CLAUDE.md` is guidance for upstream contributions; this
plugin keeps its multi-file split on purpose (testability).

---

## Open questions (as of the first release)

1. Does `getUserMedia` open the mic while Discord's voice engine holds it? Discord's
   permission handlers allow it for its own origin (checked in `discord_desktop_core`), but it
   has not run on real hardware.
2. Jitter buffer floor. Headless Chrome reported 40–260 ms minimum regardless of target. Likely
   an artifact of the fake audio device. First thing to read on real PCs: the self-test button
   in the settings shows it without a second PC.
3. The pill patch uses the same anchor as Equicord's CallTimer (`VOICE_PANEL}}` /
   `GUEST_NAME_SUFFIX`). Not verified against a live Discord bundle.
4. Push to talk: do own `SPEAKING` events fire for PTT? If not, document it and keep voice
   activity as the supported mode.
