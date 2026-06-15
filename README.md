<div align="center">

<img src="https://github.com/user-attachments/assets/54f85b6b-86e9-43f2-8baa-2ce64418b7d4" alt="ShardTune Banner" width="500">

# 🎧 ShardTune

**The Spotify controller + listening-analytics browser extension for Chrome & Brave that lives in your browser, not rent-free in your head.**

Control Spotify playback, switch Spotify Connect devices, peek your queue, set a sleep timer, and watch your listening habits get exposed in real time — a full Spotify deck controller *and* a local music-stats dashboard, no leaving the tab you're doom-scrolling.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-1db954?style=flat-square)
![Vanilla JS](https://img.shields.io/badge/Stack-Vanilla%20JS-f7df1e?style=flat-square)
![No Bundler](https://img.shields.io/badge/Build%20step-none%20(we%20don't%20do%20that%20here)-26262b?style=flat-square)
![Brave First](https://img.shields.io/badge/Brave-first-fb542b?style=flat-square)
![Part of](https://img.shields.io/badge/Shard-Ecosystem-1db954?style=flat-square)

</div>

---

## The vibe

Most "Spotify for your browser" things are either a glorified play/pause button or a 4MB React cathedral. ShardTune is neither. It's a tight little Chromium **Manifest V3 (MV3)** extension built on the **Spotify Web API** — pure HTML/CSS/JS, zero frameworks, zero build step — that gives you a full playback controller in the popup and a genuinely nosy listening-stats dashboard in a tab. Runs on **Chrome, Brave, Edge**, and any Chromium browser.

It's giving *"I have my life together"* energy. (You do not. The streak counter knows.)

---

## ✨ Features

### 🎛️ The Popup (your command deck)
- **Now playing** with album art, live progress bar, and a waveform that actually reacts to playback
- **Full transport** — play/pause, next/prev, shuffle, repeat, scrubbing/seek
- **Volume** control (gracefully greys out on devices that don't allow it, instead of throwing a tantrum)
- **Up Next** queue preview — and it's honest: when shuffle's on it says *"approximate"* because Spotify's API physically will not tell us the real shuffle order. We don't lie to you. 🫡
- **Device switching** — fling your audio to any Spotify Connect device
- **Sleep timer** — 15/30/45/60 min, for when you fall asleep mid-album like a Victorian child
- **Session stats** at a glance — minutes, skips, artists, day streak
- **Inline settings** — notifications, connection, keyboard shortcuts, the works

### 📊 The Dashboard (the receipts)
- **Energy waveform** of your recent session
- **Peak Hours** heatmap — find out you're a 2 AM gremlin
- **Music Memory** — a 7-day × 24-hour grid of when and how hard you listen
- **Session Vibe** — mood + energy read of your current run
- **Top artists & tracks**, recently-played log, and an album mosaic
- **Friend Activity & Vibe Sync** — see what your friends are playing and how in-sync your vibes are *(uses an unofficial Spotify endpoint — see the fine print)*

### 🔔 Smart notifications
- **Liked-song alerts** when a saved banger sneaks onto shuffle
- **Friend activity** when someone you follow starts something new
- **Focus reminders** after long sessions (touch grass bestie)

### ⌨️ Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Play / Pause | `Alt + Shift + P` |
| Next track | `Alt + Shift + →` |
| Previous track | `Alt + Shift + ←` |

> Configure or rebind them anytime at `chrome://extensions/shortcuts` (there's a button in Settings).

---

## 🎨 Design — "Clean Swiss"

Dark graphite surfaces, a single Spotify-green accent, `Inter Tight` for UI and `IBM Plex Mono` for the numbers. Sharp 2px geometry, no gratuitous glow, no scanline cosplay. Restrained on purpose. The aesthetic is *quietly expensive*. No notes.

---

## 🚀 Getting started

ShardTune is **BYO-Client-ID** (bring your own). You register a tiny personal Spotify app once, and you stay in full control of your own keys. No middleman server, no telemetry, no shady business.

> **Heads up:** Playback *control* (play/pause/skip/volume) requires **Spotify Premium** — that's a Spotify API rule, not us being difficult. Free accounts can still see now-playing and analytics.

### 1. Get a Spotify Client ID
1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. **Create app** → name it whatever (`ShardTune` works)
3. Add this **exact** Redirect URI:
   ```
   http://127.0.0.1:43827/spotify/callback
   ```
4. Save, then copy your **Client ID**

### 2. Load the extension
```bash
git clone https://github.com/hett-patell/ShardTune.git
```
1. Open `brave://extensions` (or `chrome://extensions`)
2. Toggle **Developer mode** (top right)
3. Click **Load unpacked** and select the `ShardTune` folder
4. Pin it. Treat yourself.

### 3. Connect
1. Click the ShardTune icon
2. Paste your **Client ID**, hit **Save**
3. Hit **Connect Spotify**, approve, and you're in 🎉

---

## 🧠 How it works (for the curious)

```
┌─────────────┐   port    ┌──────────────────────┐   Web API   ┌─────────┐
│  popup /    │◀────────▶│  service worker (MV3)  │◀──────────▶│ Spotify │
│  dashboard  │           │  poll · auth · analytics│            │   API   │
└─────────────┘           └──────────────────────┘             └─────────┘
        ▲                            │
        │                     chrome.storage.local
        └───── friend activity ◀── content scripts on open.spotify.com
```

- **Auth:** OAuth 2.0 **PKCE**, run through a tab + loopback redirect (because `chrome.identity` is moody in Brave). Tokens live in `chrome.storage.local`, refreshed on a mutex so you never get a token stampede.
- **Polling:** single-flight `poll()` with a fast interval while the popup's open and a durable alarm fallback that survives service-worker eviction. Honors `429 Retry-After` instead of hammering the API like it owes us money.
- **Analytics:** computed and stored **100% locally**. Peak hours, music memory, and streaks write through to storage immediately so an MV3 eviction can't eat your data.
- **Energy:** Spotify deprecated the audio-features endpoint for new apps, so "energy" is a deterministic proxy from popularity/duration/explicitness. It's vibes-based science, but consistent vibes-based science.

---

## 🔒 Privacy

Your listening data **never leaves your machine**. No analytics server, no tracking, no "we value your privacy" popup that means the opposite. It's all in `chrome.storage.local`, and there's a one-click **Clear analytics** in Settings if you want to ghost your own data.

---

## ⚠️ Fine print

- **Not affiliated with, endorsed by, or sponsored by Spotify.** Just a fan project.
- **Friend Activity / Vibe Sync** uses an *unofficial* Spotify presence endpoint. It works today; it could break whenever Spotify feels like it. No promises, only vibes.
- Built **Brave-first**, runs on any Chromium browser (Chrome, Edge, etc.).

---

## 🛠️ Tech stack

`Chromium MV3` · `Vanilla JS (ES modules)` · `Spotify Web API` · `Zero dependencies` · `Zero build step` · `Maximum spite toward bundlers`

---

## 🌐 The Shard Ecosystem

ShardTune is part of **[Shard](https://networkshard.com)** — a family of sharp, self-hosted-energy tools built by **Het Patel**.

| | |
|---|---|
| 🧑‍💻 Developer | **Het Patel** |
| 🌍 Web | [networkshard.com](https://networkshard.com) |
| 🐙 GitHub | [@hett-patell](https://github.com/hett-patell) |

---

<div align="center">

*Built with vanilla JS and an unreasonable amount of opinions about glow effects.*

**ShardTune** — your music, your data, your problem (affectionate).

</div>
