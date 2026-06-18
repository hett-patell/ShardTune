<div align="center">

<img src="https://github.com/user-attachments/assets/54f85b6b-86e9-43f2-8baa-2ce64418b7d4" alt="ShardTune Banner" width="500">

# ShardTune

**the spotify controller you didn't know you needed.**

control playback, manage your queue, search tracks, track your listening habits, and vibe with friends in real-time jam sessions — all without leaving your tab.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-1db954?style=flat-square)
![Vanilla JS](https://img.shields.io/badge/Stack-Vanilla%20JS-f7df1e?style=flat-square)
![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-26262b?style=flat-square)
![Chrome](https://img.shields.io/badge/Chrome-supported-4285f4?style=flat-square)
![Brave](https://img.shields.io/badge/Brave-supported-fb542b?style=flat-square)

</div>

---

> **heads up — this is a hobby project.** i build this in my free time because i wanted a better spotify experience in my browser. it works great for me, but no promises. things might break, APIs might change, and the jam feature is still experimental. if something goes wrong, open an issue and i'll get to it when i can. use at your own risk and have fun with it.

---

## why shardtune?

most spotify extensions give you a play/pause button and call it a day. shardtune is the whole package — playback, queue, search, playlists, friend activity, jam sessions with your friends, and a full analytics dashboard. all running locally. zero servers. zero tracking.

no frameworks. no build step. no backend. just vanilla js talking to the spotify web api.

works on **Chrome, Brave, Edge**, and basically any chromium browser.

---

## two flavors

| | **ShardTune** | **ShardTune Beta** |
|---|---|---|
| Branch | `main` | `beta` |
| Vibe | stable, just works | bleeding edge, has jam |
| Jam Sessions | nope | yep (P2P, experimental) |
| Updates | stable releases only | pre-releases |

want the safe experience? stick with `main`. want to listen with friends and don't mind the occasional rough edge? grab `beta`.

---

## features

### playback control

full player controls right from the popup — no spotify tab-switching needed.

- **now playing** — album art, live progress bar, waveform visualization
- **transport controls** — play/pause, next/prev, shuffle, repeat
- **volume control** — with graceful handling for devices that don't support it
- **queue management** — view and play upcoming tracks, auto-refreshes on track change
- **search** — find and play tracks or artists directly from the popup
- **add to queue** — queue any search result with one click
- **like/save** — save tracks to your library instantly
- **playlists** — browse and play your playlists without leaving the popup
- **device switching** — move playback between spotify connect devices
- **copy track link** — one-click copy to clipboard
- **sleep timer** — 15/30/45/60 min presets or custom (up to 8h), with live countdown
- **session stats** — minutes listened, skips, unique artists, day streak

### jam sessions (beta only)

listen to spotify in sync with friends over P2P. no server, no middleman — just vibes.

- **host a room** — create a session, share the code
- **join a friend** — enter their code and you're in
- **real-time sync** — adaptive sync engine with RTT compensation
- **guest controls** — guests can play/pause/skip/queue through the host
- **peer list** — see who's in the session
- **manual offset** — fine-tune sync if your connection is weird

> **fair warning:** jam is experimental. it uses WebRTC via Trystero over Nostr relays. it works surprisingly well most of the time, but P2P is P2P — sometimes connections drop, sometimes sync drifts, sometimes the relay is having a bad day. if it breaks, just rejoin. i'm actively improving it.

### analytics dashboard

a full-page dashboard that breaks down your listening habits. all data computed locally.

- **session waveform** — energy curve of your current listening session
- **peak hours** — when you listen most across a 24h breakdown
- **music memory** — 7-day x 24-hour grid of your listening patterns
- **session vibe** — mood and energy analysis for your current session
- **taste profile** — energy, popularity, and variety metrics from your top tracks
- **library stats** — liked songs, unique artists, recent additions
- **top artists & tracks** — your most-played music
- **listening log** — chronological history of recently played tracks
- **album mosaic** — visual grid of your recent albums
- **friend activity** — see what friends are playing in real time
- **vibe sync** — compare your music taste with friends
- **share card** — export your stats as a shareable PNG
- **export json** — download raw data for your own analysis

### smart notifications

- **liked song alerts** — notifies you when a saved track comes on during shuffle
- **friend activity** — heads up when someone you follow starts playing
- **focus reminders** — gentle nudge after extended listening sessions
- **fully configurable** — toggle each type independently in settings

### keyboard shortcuts

| Action | Shortcut |
|--------|----------|
| Play / Pause | `Alt + Shift + P` |
| Next Track | `Alt + Shift + Right` |
| Previous Track | `Alt + Shift + Left` |

customize at `chrome://extensions/shortcuts`.

---

## getting started

shardtune uses a **BYO-Client-ID** model — you register your own spotify app and keep full control of your credentials. no middleman, no telemetry.

> **note:** playback control (play/pause/skip/volume) requires **Spotify Premium**. that's a spotify API restriction, not ours. free accounts can still view now-playing info and analytics.

### 1. create a spotify app

1. go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. click **Create App**
3. name it whatever (e.g., `ShardTune`)
4. add this **Redirect URI**:
   ```
   http://127.0.0.1:43827/spotify/callback
   ```
5. save and copy your **Client ID**

### 2. install the extension

**stable:**
```bash
git clone https://github.com/hett-patell/ShardTune.git
```

**beta (with jam sessions):**
```bash
git clone -b beta https://github.com/hett-patell/ShardTune.git
```

then:
1. open `chrome://extensions` (or `brave://extensions`)
2. enable **Developer mode** (top right)
3. click **Load unpacked** and select the `ShardTune` folder
4. pin the extension to your toolbar

### 3. connect spotify

1. click the ShardTune icon in your toolbar
2. paste your **Client ID** and hit **Save**
3. click **Connect Spotify** and authorize
4. you're in

---

## how it works

```
popup / dashboard  <──port──>  service worker (MV3)  <──Web API──>  Spotify
                                    |
                             chrome.storage.local
                                    |
                   content scripts on open.spotify.com (token + friends)
```

**beta only:**
```
popup  <──port──>  service worker  <──messages──>  offscreen document (WebRTC)
                                                        |
                                                   Trystero / Nostr relays
                                                        |
                                                   other peers (P2P)
```

- **auth** — OAuth 2.0 PKCE with loopback redirect. tokens stored locally, refreshed with mutex.
- **polling** — single-flight with fast interval when popup is open, durable alarm fallback for MV3 worker eviction. respects `429 Retry-After`.
- **analytics** — 100% local. peak hours, music memory, and streaks persist through write-through caching.
- **energy proxy** — spotify deprecated audio-features for new apps, so shardtune uses a deterministic proxy based on popularity, duration, and explicitness.
- **jam sync** — adaptive prediction loop with RTT measurement, drift detection, and transition locks to prevent audio glitches.

---

## privacy

your data **never leaves your device**. no analytics servers, no tracking pixels, no third-party scripts. everything lives in `chrome.storage.local`. one-click "Clear Analytics" in settings wipes it all.

jam sessions are peer-to-peer — audio goes through spotify, sync messages go through public Nostr relays. no data touches my servers because i don't have servers.

---

## tech stack

| | |
|---|---|
| **Runtime** | Chromium Manifest V3 |
| **Language** | Vanilla JavaScript (ES modules) |
| **API** | Spotify Web API |
| **P2P** | Trystero (Nostr relays + WebRTC) |
| **Dependencies** | Trystero only (bundled, beta branch) |
| **Build step** | None |
| **Storage** | chrome.storage.local |

---

## browser support

| Browser | Status |
|---------|--------|
| Brave | primary, recommended |
| Chrome | fully supported |
| Edge | fully supported |
| Any Chromium | should work |

---

## disclaimer

- not affiliated with, endorsed by, or sponsored by Spotify.
- friend activity and vibe sync use an unofficial spotify endpoint that may break without notice.
- playback control requires Spotify Premium (spotify API restriction).
- jam sessions are experimental and rely on public Nostr relays — availability not guaranteed.
- this is a hobby project. i do my best but there are no warranties.

---

## links

| | |
|---|---|
| Developer | [Het Patel](https://github.com/hett-patell) |
| Website | [networkshard.com](https://networkshard.com) |
| Repository | [hett-patell/ShardTune](https://github.com/hett-patell/ShardTune) |

---

<div align="center">

**ShardTune** — your music, your data, your browser.

</div>
