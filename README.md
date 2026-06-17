<div align="center">

<img src="https://github.com/user-attachments/assets/54f85b6b-86e9-43f2-8baa-2ce64418b7d4" alt="ShardTune Banner" width="500">

# ShardTune

**Spotify controller + listening analytics for your browser.**

Control playback, manage your queue, search tracks, track listening habits — without ever leaving your tab.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-1db954?style=flat-square)
![Vanilla JS](https://img.shields.io/badge/Stack-Vanilla%20JS-f7df1e?style=flat-square)
![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-26262b?style=flat-square)
![Chrome](https://img.shields.io/badge/Chrome-supported-4285f4?style=flat-square)
![Brave](https://img.shields.io/badge/Brave-supported-fb542b?style=flat-square)

</div>

---

## Why ShardTune?

Most Spotify extensions give you a play/pause button and call it a day. ShardTune gives you the full picture — playback control, queue management, search, playlists, friend activity, and a complete analytics dashboard — all running locally in your browser with zero external dependencies.

No frameworks. No build step. No servers collecting your data. Just vanilla JS talking directly to the Spotify Web API.

Works on **Chrome, Brave, Edge**, and any Chromium-based browser.

---

## Features

### Playback Control

Full player controls right from the popup — no need to tab over to Spotify.

- **Now Playing** — album art, live progress bar, waveform visualization
- **Transport Controls** — play/pause, next/prev, shuffle, repeat (with visual repeat-one indicator)
- **Volume Control** — with graceful handling for devices that don't support it
- **Queue Management** — view and play upcoming tracks, auto-refreshes on track change
- **Search** — find and play tracks or artists directly from the popup
- **Add to Queue** — queue any search result with one click
- **Like/Save** — save tracks to your library instantly
- **Playlists** — browse and play your playlists without leaving the popup
- **Device Switching** — move playback between Spotify Connect devices
- **Copy Track Link** — one-click copy to clipboard
- **Sleep Timer** — 15/30/45/60 min presets or custom duration (up to 8 hours), with live countdown badge
- **Session Stats** — minutes listened, skips, unique artists, day streak

### Analytics Dashboard

A full-page dashboard that breaks down your listening habits. All data is computed locally.

- **Session Waveform** — energy curve of your current listening session
- **Peak Hours** — discover when you listen most across a 24-hour breakdown
- **Music Memory** — 7-day x 24-hour grid of your listening patterns
- **Session Vibe** — mood and energy analysis for your current session
- **Taste Profile** — energy, popularity, and variety metrics from your top tracks
- **Library Stats** — liked songs count, unique artists, recent additions
- **Top Artists & Tracks** — your most-played music with rankings
- **Listening Log** — chronological history of recently played tracks
- **Album Mosaic** — visual grid of your recent albums
- **Friend Activity** — see what friends are playing in real time
- **Vibe Sync** — compare your music taste with friends using multi-factor matching
- **Share Card** — export your stats as a shareable PNG
- **Export JSON** — download raw analytics data for backup or your own analysis

### Smart Notifications

- **Liked Song Alerts** — notifies you when a saved track comes on during shuffle
- **Friend Activity** — heads up when someone you follow starts playing
- **Focus Reminders** — gentle nudge after extended listening sessions
- **Fully Configurable** — toggle each notification type independently in Settings

### Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Play / Pause | `Alt + Shift + P` |
| Next Track | `Alt + Shift + Right` |
| Previous Track | `Alt + Shift + Left` |

Customize these at `chrome://extensions/shortcuts`.

---

## Getting Started

ShardTune uses a **BYO-Client-ID** model — you register your own Spotify app and keep full control of your credentials. No middleman server, no telemetry.

> **Heads up:** Playback control (play/pause/skip/volume) requires **Spotify Premium**. That's a Spotify API restriction, not ours. Free accounts can still view now-playing info and analytics.

### 1. Create a Spotify App

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. Click **Create App**
3. Name it whatever you want (e.g., `ShardTune`)
4. Add this **Redirect URI**:
   ```
   http://127.0.0.1:43827/spotify/callback
   ```
5. Save and copy your **Client ID**

### 2. Install the Extension

```bash
git clone https://github.com/hett-patell/ShardTune.git
```

1. Open `chrome://extensions` (or `brave://extensions`)
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `ShardTune` folder
4. Pin the extension to your toolbar

### 3. Connect Spotify

1. Click the ShardTune icon in your toolbar
2. Paste your **Client ID** and hit **Save**
3. Click **Connect Spotify** and authorize
4. You're in

---

## How It Works

```
popup / dashboard  <──port──>  service worker (MV3)  <──Web API──>  Spotify
                                    |
                             chrome.storage.local
                                    |
                   content scripts on open.spotify.com (friend activity)
```

- **Auth** — OAuth 2.0 PKCE with loopback redirect. Tokens stored locally, refreshed with a mutex to prevent stampede.
- **Polling** — Single-flight polling with fast interval when the popup is open, durable alarm fallback for service worker eviction. Respects `429 Retry-After`.
- **Analytics** — 100% local computation. Peak hours, music memory, and streaks persist through write-through caching so MV3 worker eviction doesn't lose data.
- **Energy Proxy** — Spotify deprecated audio-features for new apps, so ShardTune uses a deterministic proxy based on popularity, duration, and explicitness.

---

## Privacy

Your data **never leaves your device**. No analytics servers, no tracking pixels, no third-party scripts. Everything lives in `chrome.storage.local`. One-click "Clear Analytics" in Settings wipes it all.

---

## Tech Stack

| | |
|---|---|
| **Runtime** | Chromium Manifest V3 |
| **Language** | Vanilla JavaScript (ES modules) |
| **API** | Spotify Web API |
| **Dependencies** | Zero |
| **Build step** | None |
| **Storage** | chrome.storage.local |

---

## Browser Support

| Browser | Status |
|---------|--------|
| Brave | Primary, recommended |
| Chrome | Fully supported |
| Edge | Fully supported |
| Any Chromium | Should work |

---

## Disclaimer

- Not affiliated with, endorsed by, or sponsored by Spotify.
- Friend Activity and Vibe Sync use an unofficial Spotify endpoint that may break without notice.
- Playback control requires Spotify Premium (Spotify API restriction).

---

## Links

| | |
|---|---|
| Developer | [Het Patel](https://github.com/hett-patell) |
| Website | [networkshard.com](https://networkshard.com) |
| Repository | [hett-patell/ShardTune](https://github.com/hett-patell/ShardTune) |

---

<div align="center">

**ShardTune** — your music, your data, your browser.

</div>
