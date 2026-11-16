# LanLink 🎧

**Talk to the person sitting next to you without the Discord delay.**

Two people, same room, two PCs, one Discord voice channel, both on headphones. Through Discord your voice takes roughly 100–200 ms to reach the other headset, so you half-hear the real voice and then the delayed copy. LanLink is an [Equicord](https://github.com/Equicord/Equicord) plugin that sends your voice straight over the home network instead and mutes the Discord copy, only between the two of you. Everyone else in the channel hears you through Discord as usual.

```
your mic ──┬──► Discord voice ──► Discord servers ──► remote friends
           └──► LanLink (WebRTC, LAN only) ──► the headphones next to you
                              (who has you locally muted in Discord)
```

> 🤖 **Disclaimer:** This project's code is 100% written by AI and driven by human ideas (and two people who got tired of hearing each other twice). Without AI it simply wouldn't exist — so take it or leave it. 💛

> 🚧 **Status: prototype, not yet proven on real hardware.** Everything that can be tested without two PCs is tested in CI. The first real evening with two PCs is still ahead. See [What is tested](#what-is-tested).

## What it is (and isn't)

- ✅ A direct audio link between exactly two Discord clients on the same home network
- ✅ Finds the other PC by itself; mutes and unmutes the other person in Discord for you
- ✅ LAN only: no server, no account, no STUN/TURN, nothing leaves your network
- ✅ Only changes things on your own client (a local mute). Nobody else sees a difference
- ❌ Not for people in different places. It only helps when you're on the same network
- ❌ Doesn't touch Discord's own voice connection and doesn't automate your account
- ❌ Not an official Equicord plugin, and not meant to become one

## Install

Requirements: Windows, Discord desktop, both PCs on the same home network (cable recommended), wired headphones. Bluetooth headphones add 150–250 ms on their own and cancel out everything LanLink saves.

Both people do this:

1. Install **Equicord** with its normal installer from [equicord.org](https://equicord.org/download) and start Discord once.
2. In PowerShell:

   ```
   irm https://raw.githubusercontent.com/6uhrmittag/discord-voice-link/main/tools/install.ps1 -OutFile install.ps1
   powershell -ExecutionPolicy Bypass -File install.ps1
   ```

   This swaps Equicord's file for a build of Equicord with LanLink compiled in, made by [GitHub Actions](.github/workflows/ci.yml) from the commit the release names. Discord is closed for a moment and started again. Your Equicord settings, plugins and themes stay.
3. In Discord: **Settings → Equicord → Plugins → LanLink**, switch it on and restart Discord when asked.
4. Windows asks whether Discord may accept network connections: allow it on **Private** networks.
5. Open the LanLink settings and set:
   - **Peer user ID**: the other person's Discord user ID (Settings → Advanced → Developer Mode, then right-click them → Copy User ID)
   - **Shared secret**: any text, the same on both PCs

**Try it alone first:** the LanLink settings have a button **Test audio on this PC (30 s)**. It plays your own microphone back to you through the same path the link uses, no second PC needed. You should hear yourself with a very short delay. If it fails, the message says why (usually the microphone).

Join the same voice channel. The status line in the LanLink settings goes `discovering` → `connecting` → `connected`, and a green **LAN** pill appears next to the other person in the voice channel.

**Updates** come by themselves: this build's updater (Settings → Equicord → Updater) looks at this repository's releases. Running `install.ps1` again does the same by hand.

**Going back:** `powershell -ExecutionPolicy Bypass -File install.ps1 -Restore` puts the original Equicord file back. Running the Equicord installer again does too.

Why a whole Equicord build? Equicord has no way to load a plugin at runtime; third-party plugins are compiled in. The build follows Equicord: once a day CI builds against Equicord's newest commit and, if that works, releases it. Which Equicord commit a release contains is in its notes.

### The PCs don't find each other

Stuck on `discovering`? In this order:

1. **Windows Firewall.** Windows Security → Firewall → "Allow an app through firewall": every `Discord.exe` entry needs **Private** ticked. The rule is tied to the full path of `Discord.exe`, and Discord installs each of its own updates into a new folder, so the question can come back after a Discord update.
2. The network must be set to **Private** in Windows, not Public.
3. Same user ID / secret / port on both sides? The secret is case-sensitive.
4. Set **Manual peer IP** on one PC to the other PC's address (`ipconfig` → IPv4 address). Needed on guest networks and some mesh setups that block broadcasts.

## Settings

| Setting | Meaning |
|---|---|
| Status | `idle`, `discovering`, `connecting`, `connected · 0.4 ms RTT`, `failed` / `lost` (retrying by itself) or `error: …` |
| Enabled | Master switch for the link |
| Peer user ID | Discord user ID of the other person |
| Shared secret | Any text, identical on both PCs. Packets signed with another secret are ignored |
| Port | UDP port for finding each other and setting up the link. Default 47820, same on both PCs |
| Manual peer IP | The other PC's LAN address. Empty = find it by broadcast. One side is enough |
| Input device | Microphone for the LAN link. "Same as Discord" picks Discord's input device by name |
| Output device | Where LAN audio plays. "Same as Discord" picks Discord's output device by name |
| LAN volume | Volume of the other person over the LAN. Discord's own volume slider for them does nothing while they're muted there |
| Jitter buffer target | 0 ms = lowest delay. Raise it if the audio crackles |
| Gate on push to talk | In push-to-talk mode, send LAN audio only while Discord shows you as speaking |
| Show stats | RTT, jitter buffer delay (with its own target and minimum), jitter, packet loss, packets per second and frame size, here and in the console as `[LanLink]` |
| Test audio on this PC | 30 seconds of your own microphone through the full LAN audio path, with the jitter buffer numbers. Changes nothing in Discord |
| Measure the delay | Hold one headphone cup directly against the microphone. Five beeps are timed on their way through microphone, audio path and headphone. The result is the delay of the LAN audio path on this PC, without the network (which adds under 1 ms on a cable) |

Changing a setting restarts the link.

## How it behaves

- **Finding each other.** Each client broadcasts a small signed "hello" every 2 seconds. Only hellos from the configured user ID with a valid signature count.
- **The link.** Plain WebRTC audio between the two Discord windows, host candidates only. The lower user ID makes the offer.
- **Active** means: link connected **and** the other person is in your current voice channel. Only then are they muted in Discord and your mic sent over the LAN. Connected but in different channels (or none): standby, silence.
- **Auto-mute.** When the link becomes active, LanLink remembers whether you had the other person muted, then mutes them locally. When it stops being active (link lost, someone leaves or switches channel, plugin off, Discord closing), it puts that back. Someone you had muted yourself stays muted. The note is saved, so a crash is undone at the next start, and a watchdog re-checks every second. Being stuck muted with a dead link is the one thing this plugin must never do.
- **Mute and deafen** in Discord apply to the LAN audio too.
- **Reconnect.** A failed or lost link is retried by itself, waiting 1 s, 2 s, 4 s … up to 30 s between tries.

## Privacy and security

- Nothing is sent outside your home network. No analytics, no server. The one outside request is Equicord's updater asking GitHub for this repository's newest release.
- The setup messages between the two PCs are signed with the shared secret (HMAC-SHA256), so other devices on the network can't inject or alter them. They are not encrypted and there's no replay protection. The audio itself is encrypted by WebRTC (DTLS-SRTP). Fine for a home network; not built for a hostile one.
- The shared secret is saved in the Equicord settings in plain text. With Equicord's cloud settings sync on, it is uploaded with them.
- Client mods like Equicord are against Discord's terms of service. That's true for Equicord itself, with or without this plugin.

## What is tested

Every push runs in [GitHub Actions](.github/workflows/ci.yml):

| | |
|---|---|
| Message format, signatures, broadcast addresses | unit tests |
| Finding the peer and passing setup messages (real UDP sockets on one machine) | unit tests |
| Auto-mute rules: mute, restore, crash recovery, manual unmute, mute/deafen/push-to-talk | unit tests |
| Link state machine: who offers, retries and backoff, restarts, stale messages | unit tests |
| Audio session in a real headless Chrome: connects, 10 ms Opus frames | loopback test |
| The settings' audio self-test, in the same headless Chrome | loopback test |
| `install.ps1`: download, swap, backup, restore | by hand, against a real release, in a scratch folder |
| Type-check and build inside Equicord | every push, and daily against Equicord's newest commit |

**Not tested yet, needs two real PCs:**

- [ ] The prebuilt build running in a real Discord
- [ ] Updates arriving by themselves through Equicord's updater
- [x] Opening the mic a second time while Discord uses it (one PC, self-test)
- [ ] Audio between two PCs
- [ ] Auto-mute and restore in the real client (leave channel, switch channel, pull the cable, close Discord, kill Discord)
- [ ] The **LAN** pill in the voice channel (the patch may not match the current Discord build; the link works without it)
- [ ] Push to talk
- [ ] Latency

Built so far against Equicord [`87dcb6a`](https://github.com/Equicord/Equicord/commit/87dcb6a316a00616a99495f508b11b12b68c064a). Discord at the time: stable 1.0.9268 (Chromium 152).

## Latency

Goal: 35–60 ms mouth to ear, against roughly 100–200 ms through Discord. Below about 40 ms the LAN voice blends with the real voice you still hear through the headphones instead of sounding like an echo. That is the point, not a benchmark number.

The stats only cover network and jitter buffer, not microphone and headphone buffering. **Measure the delay** in the settings times the whole path on one PC: a beep goes out of the headphone, into the microphone held against it, through the audio path and out of the headphone again, and the gap between the two is the delay. For Discord's own path there is no such button; that number comes from a clap test: a phone records next to one person's mic while the other person's headphone is pressed against the phone. Clap. The recording has the clap twice; the gap between them is the delay. Once with LanLink off, once on.

| Path | Mouth to ear | Jitter buffer (stats) | RTT (stats) |
|---|---|---|---|
| Discord only | not yet measured | | |
| LanLink, one PC (Measure the delay) | not yet measured | 30 ms (first PC, Razer Seiren V3 Mini) | |
| LanLink, two PCs | not yet measured | not yet measured | not yet measured |

The jitter buffer is the part to watch. Chromium doesn't go to the 0 ms that LanLink asks for; it keeps its own minimum. On the first real PC that was 30 ms (minimum 20 ms) with the microphone and headphones picked by name in the settings, and 60 ms in an earlier run on the Windows default devices. One run each, so whether the device choice is the reason isn't known yet. **Test audio on this PC** shows the numbers. If it doesn't come down to about 20 ms or less on real hardware, WebRTC inside Discord can't reach the goal. Plan B is then [SonoBus](https://sonobus.net/) for the audio, with LanLink reduced to finding the peer, auto-mute and the pill.

## Known limits

- Exactly two people; one peer per client.
- Windows only for now (nothing else has been tried).
- While muted or on standby the link sends silence instead of nothing: about 100 tiny packets per second on your LAN.
- The LAN path is your raw microphone: Discord's noise suppression, echo cancellation and gain control don't apply to it. That's on purpose, each of them adds delay.
- If you unmute the other person in Discord by hand while the link is active, LanLink leaves it. You then hear them twice until the next activation.
- Push-to-talk gating relies on Discord's speaking indicator for yourself; untested.
- Discord updates can break the places where LanLink reads Discord's state ([`discord.ts`](discord.ts)) and the pill patch in [`index.tsx`](index.tsx). Equicord updates can break the build; CI notices that daily.
- The prebuilt file replaces Equicord's own. Equicord's installer (repair/reinstall) replaces it back, and LanLink is gone until you run `install.ps1` again.

## License

GPL-3.0-or-later, the same as Equicord, which this plugin is compiled into. See [`LICENSE`](LICENSE).

## Development

Built with Claude Code — see [`CLAUDE.md`](CLAUDE.md) for the project brief, rules and scope.

```
index.tsx     plugin definition, settings, flux listeners, pill, status UI
automute.ts   when the link is "active", and what that does to Discord and the LAN audio
state.ts      link state machine, ties native.ts and rtc.ts together
rtc.ts        WebRTC session, no Discord imports
selftest.ts   the one-PC audio test and delay measurement: two sessions wired together
native.ts     Discord's main process: UDP discovery and setup-message transport
protocol.ts   message format and signatures
discord.ts    every access to Discord's stores and actions
tests/        unit tests (node:test) and the headless Chrome loopback
dev/          rtc-test.html: rtc.ts in a plain browser, loopback or two tabs
tools/        install.ps1
equicord.ref  the Equicord commit releases are built against
```

Tests (Node 22+):

```
npm ci
npm test            # unit tests
npm run test:rtc    # WebRTC loopback, needs Chrome/Chromium (set CHROME to its path if it isn't found)
```

### Building from source

For working on the plugin. Needs git, Node 22+ and pnpm, in a normal (not admin) terminal:

```
git clone https://github.com/Equicord/Equicord
cd Equicord
git clone https://github.com/6uhrmittag/discord-voice-link src/userplugins/lanLink
pnpm install --frozen-lockfile
pnpm build
pnpm inject
```

Close Discord completely (tray icon too) before `pnpm inject`. If `pnpm install` dies inside Corepack with `Cannot find module ...pnpm.cjs`, run `corepack disable pnpm` and `npm install -g pnpm@latest --force`, then try again.

After changes: `git pull` in `src/userplugins/lanLink`, `pnpm build`, restart Discord. `pnpm watch` rebuilds on save; Ctrl+R reloads Discord's window, but changes to `native.ts` or `protocol.ts` need a full Discord restart.
