<div align="center">

<img src="https://github.com/user-attachments/assets/54f85b6b-86e9-43f2-8baa-2ce64418b7d4" alt="ShardTune Banner" width="500">

# ShardTune

**Spotify controller + listening analytics browser extension for Chrome & Brave.**

Control playback, manage queue, search tracks, view listening stats, and see your music habits in real time — all without leaving your current tab.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-1db954?style=flat-square)
![Vanilla JS](https://img.shields.io/badge/Stack-Vanilla%20JS-f7df1e?style=flat-square)
![No Bundler](https://img.shields.io/badge/Build%20step-none-26262b?style=flat-square)
![Chrome](https://img.shields.io/badge/Chrome-supported-4285f4?style=flat-square)
![Brave](https://img.shields.io/badge/Brave-supported-fb542b?style=flat-square)

</div>

---

## What is ShardTune?

ShardTune is a lightweight **Spotify browser extension** built on **Manifest V3** that gives you full playback control and listening analytics without leaving your tab. No frameworks, no build step, no bloat — just pure HTML/CSS/JS talking to the Spotify Web API.

Works on **Chrome, Brave, Edge**, and any Chromium-based browser.

---

## Features

### Playback Control
- **Now Playing** — album art, live progress bar, waveform visualization
- **Transport Controls** — play/pause, next/prev, shuffle, repeat, seek
- **Volume Control** — with graceful handling for devices that don't support it
- **Queue Management** — view upcoming tracks, play any track from queue
- **Search** — find and play tracks/artists directly from the popup
- **Add to Queue** — queue any track with one click
- **Like/Save** — save tracks to your library with the heart button
- **Playlists** — view and play your playlists from the popup
- **Device Switching** — move playback to any Spotify Connect device
- **Device Picker** — click album art to switch devices
- **Copy Track Link** — copy Spotify URL to clipboard
- **Sleep Timer** — 15/30/45/60 min or custom duration
- **Session Stats** — minutes listened, skips, unique artists, day streak

### Listening Analytics Dashboard
- **Session Waveform** — visual energy curve of your listening session
- **Peak Hours Heatmap** — discover when you listen most (7-day × 24-hour grid)
- **Music Memory** — track your listening patterns over time
- **Session Vibe** — mood and energy analysis based on your current session
- **Taste Profile** — energy, popularity, and variety metrics for your top tracks
- **Library Stats** — liked songs count, unique artists, recent additions
- **Top Artists & Tracks** — your most-played music with rankings
- **Listening Log** — chronological history of recently played tracks
- **Album Mosaic** — visual grid of recently played albums
- **Friend Activity** — see what your friends are listening to
- **Vibe Sync** — compare your music taste with friends (multi-factor matching)
- **Share Card** — export analytics as a shareable PNG image
- **Export JSON** — download your analytics data for backup or analysis

### Smart Notifications
- **Liked Song Alerts** — when a saved track plays on shuffle
- **Friend Activity** — when someone you follow starts playing
- **Focus Reminders** — nudges after extended listening sessions
- **Notification Settings** — toggle each notification type independently

### Settings
- **Client ID Management** — update your Spotify app credentials
- **Clear Analytics** — wipe all local listening data with one click
- **Check for Updates** — manually check GitHub for new versions
- **Keyboard Shortcuts** — customize at `chrome://extensions/shortcuts` (link in Settings)

### Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Play / Pause | `Alt + Shift + P` |
| Next Track | `Alt + Shift + →` |
| Previous Track | `Alt + Shift + ←` |

### UI Features
- **Time-based Greeting** — shows Good Morning/Afternoon/Evening based on your local time
- **Responsive Layout** — popup adapts to content with fixed header and bottom bar
- **Custom Scrollbars** — matching the dark theme aesthetic

---

## Getting Started

ShardTune is **BYO-Client-ID** — you register your own Spotify app and keep full control of your keys. No middleman server, no telemetry.

> **Note:** Playback control (play/pause/skip/volume) requires **Spotify Premium** per Spotify's API rules. Free accounts can view now-playing and analytics.

### 1. Create a Spotify App
1. Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. Click **Create App**
3. Name it anything (e.g., `ShardTune`)
4. Add this **Redirect URI**:
   ```
   http://127.0.0.1:43827/spotify/callback
   ```
5. Save and copy your **Client ID**

### 2. Install the Extension
```bash
git clone https://github.com/hett-patell/ShardTune.git
```
1. Open `brave://extensions` or `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `ShardTune` folder
4. Pin the extension to your toolbar

### 3. Connect Your Spotify
1. Click the ShardTune icon
2. Paste your **Client ID** → **Save**
3. Click **Connect Spotify** → authorize
4. Done — start playing music

---

## Architecture

```
┌─────────────┐   port    ┌──────────────────────┐   Web API   ┌─────────┐
│  popup /    │◀────────▶│  service worker (MV3)  │◀──────────▶│ Spotify │
│  dashboard  │           │  poll · auth · analytics│            │   API   │
└─────────────┘           └──────────────────────┘             └─────────┘
        ▲                            │
        │                     chrome.storage.local
        └───── friend activity ◀── content scripts on open.spotify.com
```

- **Auth:** OAuth 2.0 PKCE with loopback redirect. Tokens stored in `chrome.storage.local`, refreshed with mutex to prevent stampede.
- **Polling:** Single-flight polling with fast interval (popup open) and durable alarm fallback (service worker eviction). Respects `429 Retry-After` headers.
- **Analytics:** 100% local computation. Peak hours, music memory, and streaks persist through storage writes so MV3 eviction doesn't lose data.
- **Energy:** Uses a deterministic proxy (popularity + duration + explicitness) since Spotify deprecated audio-features for new apps.

---

## Privacy

Your listening data **never leaves your device**. No analytics servers, no tracking, no third-party scripts. Everything is stored in `chrome.storage.local`. One-click **Clear analytics** in Settings wipes all local data.

---

## Tech Stack

- **Runtime:** Chromium Manifest V3
- **Language:** Vanilla JavaScript (ES modules)
- **API:** Spotify Web API
- **Dependencies:** Zero
- **Build step:** None
- **Storage:** chrome.storage.local

---

## Browser Support

| Browser | Status |
|---------|--------|
| Brave | Primary (recommended) |
| Chrome | Fully supported |
| Edge | Fully supported |
| Any Chromium | Should work |

---

## Disclaimer

- Not affiliated with, endorsed by, or sponsored by Spotify.
- Friend Activity / Vibe Sync uses an unofficial Spotify endpoint. May break without notice.
- Playback control requires Spotify Premium (Spotify API restriction).

---

## Links

| | |
|---|---|
| Developer | [Het Patel](https://github.com/hett-patell) |
| Website | [networkshard.com](https://networkshard.com) |
| GitHub | [hett-patell/ShardTune](https://github.com/hett-patell/ShardTune) |

---

<div align="center">

**ShardTune** — your music, your data, your browser.

</div>
