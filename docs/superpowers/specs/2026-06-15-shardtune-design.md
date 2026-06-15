# ShardTune — Design Spec

Spotify desk controller + listening analytics browser extension.
Chromium MV3, Brave-first, pure HTML/CSS/JS, no frameworks.

---

## 1. Problem

Het listens on his phone via Spotify. His work PC (Brave) has the same account. Controlling playback from the PC without touching the phone requires a browser-based Spotify Connect controller. Lightweight listening analytics are a bonus — no backend, all local.

## 2. Product Scope

### Core Features (from original spec)
- Popup controller: now-playing, transport controls (play/pause/next/prev), seek bar
- Device switching via Spotify Connect
- Queue preview (next 3 tracks in popup, 6 on dashboard)
- Session analytics: minutes listened, skips, unique artists, energy trend
- Full dashboard page in a browser tab

### New Features
1. **Volume slider** — in popup, single PUT call per adjustment
2. **Shuffle / repeat toggles** — in popup transport row, state from polling response
3. **Global keyboard shortcuts** — `chrome.commands` for play/pause, next, prev
4. **Sleep timer** — set 15/30/45/60 min countdown, pauses on expiry via `chrome.alarms`
5. **Copy track link** — one-click clipboard copy of Spotify track URL
6. **Listening streak** — consecutive-day counter in `chrome.storage.local`, shown in popup + dashboard
7. **Peak hours heatmap** — 24-slot array, rendered as pixel grid on dashboard
8. **Share now-playing card** — on-demand Canvas API render of pixel-art track card, copy/download
9. **Export session stats** — download as JSON or styled PNG summary card

### Performance Constraints
- All new features are event-driven or on-demand. Zero background cost when idle.
- No extra API calls beyond the existing polling cycle (volume/shuffle/repeat state comes free in the player response).
- Share card and export use Canvas API on-demand only — no persistent rendering.

## 3. Architecture

### 3.1 Authentication
- **Method**: `chrome.identity.launchWebAuthFlow()` with PKCE (RFC 7636)
- **Redirect URL**: `https://<extension-id>.chromiumapp.org/`
- **Scopes**: `user-read-playback-state`, `user-modify-playback-state`, `user-read-currently-playing`
- **Token storage**: `chrome.storage.local` — access token, refresh token, expiry timestamp
- **Auto-refresh**: background.js refreshes token when `expires_at - now < 60s`
- **No callback.html** — `chrome.identity` handles the redirect internally
- **Client ID**: user injects after build (placeholder constant in spotify.js)

### 3.2 Polling Strategy
- **Popup open**: `setInterval(5000)` — popup connects via `chrome.runtime.connect()` port, keeping the service worker alive
- **Popup closed**: `chrome.alarms` at 30s intervals (minimum enforced by Chrome)
- **Dashboard open**: same port-based keep-alive as popup, 5s interval
- **No listeners open**: alarms at 30s for streak tracking, can be disabled

### 3.3 Service Worker (background.js)
- Manages polling lifecycle (interval vs alarms based on active connections)
- Caches last known player state
- Sends state updates to connected ports (popup/dashboard)
- Handles token refresh transparently
- Tracks analytics in-memory (session-scoped)
- Persists streak + peak hours to `chrome.storage.local`
- Listens for `chrome.commands` keyboard shortcut events
- Manages sleep timer alarm

### 3.4 Module System
- ES static imports with `"type": "module"` in manifest background config
- All utils (`spotify.js`, `analytics.js`, `storage.js`) are ES modules
- No dynamic imports, no import maps, no bundler

### 3.5 File Structure
```
shardtune/
├── manifest.json
├── background.js
├── popup/
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── dashboard/
│   ├── dashboard.html
│   ├── dashboard.js
│   └── dashboard.css
├── icons/
│   ├── logo.svg
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
└── utils/
    ├── spotify.js         # API wrapper + PKCE auth
    ├── analytics.js       # Session analytics engine
    └── storage.js         # chrome.storage helpers
```

## 4. Spotify API Surface

All calls go to `https://api.spotify.com/v1`. Requires Spotify Premium.

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | /me/player | Current playback state (includes volume, shuffle, repeat) |
| PUT | /me/player/pause | Pause playback |
| PUT | /me/player/play | Resume playback |
| POST | /me/player/next | Skip to next track |
| POST | /me/player/previous | Go to previous track |
| PUT | /me/player/seek | Seek to position_ms |
| PUT | /me/player/volume | Set volume_percent (0-100) |
| PUT | /me/player/shuffle | Toggle shuffle (state=true/false) |
| PUT | /me/player/repeat | Set repeat mode (track/context/off) |
| GET | /me/player/devices | List Spotify Connect devices |
| PUT | /me/player | Transfer playback to device |
| GET | /me/player/queue | Queue preview |

Rate limit: ~180 requests/minute. 5s polling = 12 req/min, well within budget.

## 5. Design System — Clean Pixel Theme

### Philosophy
Pixel aesthetic used as seasoning, not the whole dish. Pixel font for brand identity and labels only. Body text stays readable with Inter/JetBrains Mono. Square corners throughout. Subtle scanline texture. Green glow accents.

### Color Tokens
```css
--bg:           #0b0e11
--surface:      #111820
--surface-2:    #182028
--border:       rgba(255,255,255,0.06)
--border-hover: rgba(255,255,255,0.12)
--text:         #f1f5f9
--text-2:       #c8d0d8
--text-muted:   #7a8a98
--text-faint:   #4a5568
--text-ghost:   #2a3a46
--primary:      #1db954
--primary-dim:  rgba(29,185,84,0.12)
--primary-glow: rgba(29,185,84,0.25)
--streak:       #f59e0b
--streak-dim:   #92400e
--error:        #ff5d73
```

### Typography
- **Brand / section labels**: `'Press Start 2P'` — 7-9px, uppercase, letter-spacing 1-2px
- **Track names / headings**: Inter 700, 15px
- **Body / metadata**: Inter 400/500, 11-12px
- **Monospace values** (times, percentages, stats): JetBrains Mono 500, 10-14px
- Fonts loaded via `@import` in CSS

### Key Visual Elements
- **Scanline overlay**: `repeating-linear-gradient` on popup container, 2px/4px bands at 8% opacity
- **Pixel grid texture**: on album art frame only (8px grid, 4% opacity)
- **Green glow**: on play button (`box-shadow: 0 0 20px var(--primary-glow)`), logo, active states
- **Square corners**: 0 border-radius everywhere
- **Separators**: gradient fade (`transparent → 6% white → transparent`)
- **Pulsing device dot**: 5px square, `animation: pulse 2s infinite`
- **Seek/volume knob**: square, appears on hover with glow

### Popup Layout (380px wide, ~490px tall)
1. **Header**: logo SVG (pixel bars) + "SHARDTUNE" brand + dashboard/menu buttons
2. **Now Playing**: 80px album art (with pixel grid overlay) + track name + artist + device tag
3. **Progress**: seek bar with hover-expand + time stamps
4. **Transport**: shuffle | prev | PLAY (large, green fill) | next | repeat
5. **Volume**: speaker icon + bar + percentage
6. **Queue**: "UP NEXT" label + 3 tracks with idx, thumb, name, artist, duration
7. **Stats Bar**: MIN | SKIPS | ARTISTS | STREAK (amber)

### Dashboard Layout
1. **Hero**: now-playing card (large) + live session stats row
2. **Energy curve**: Chart.js line chart, last 10 tracks, green line on dark grid
3. **Devices panel**: all Spotify Connect devices with transfer buttons
4. **Queue**: next 6 tracks with album thumbs
5. **Peak hours**: 24-column pixel heatmap (green intensity scale)
6. **Top artists**: ranked list for current session
7. **Listening log**: timeline of tracks heard
8. **Actions row**: share card button, export JSON button, export PNG button

## 6. Analytics Engine

### Session State (in-memory, background.js)
```
sessionStart: timestamp
totalListenMs: number         // only counts while is_playing === true
trackChanges: number          // increments on track.id change
skips: number                 // track change before 80% played
artists: Set<string>          // unique artist names
history: Array<{              // last 20 tracks
  id, name, artist, album, artUrl,
  startedAt, durationMs, listenedMs, skipped
}>
energyHistory: Array<{        // for chart
  label, value, trackId
}>
```

### Energy Proxy
```
energyProxy(track):
  popularity × 0.65
  + max(0, 100 - (duration_ms / 240000) × 18) × 0.25
  + (explicit ? 8 : 0)
  → clamp(15, 100)
```
Range: ~15–98. Higher = more energetic. No extra API calls needed.

### Persistent State (chrome.storage.local)
```
streak: { count: number, lastDate: 'YYYY-MM-DD' }
peakHours: number[24]         // minute count per hour slot
```

### Streak Logic
- On each poll where `is_playing === true`: check today's date vs `lastDate`
- Same day: no-op
- Yesterday: increment count, update lastDate
- Older: reset count to 1, update lastDate

### Peak Hours Logic
- On each 5s poll where `is_playing === true`: `peakHours[currentHour] += 5` (seconds)
- Stored as cumulative seconds per hour slot

## 7. Keyboard Shortcuts

Defined in `manifest.json` `commands` field:

| Command | Default | Action |
|---------|---------|--------|
| `toggle-playback` | `Alt+Shift+P` | Play/pause |
| `next-track` | `Alt+Shift+Right` | Next track |
| `prev-track` | `Alt+Shift+Left` | Previous track |

Handled in background.js via `chrome.commands.onCommand`.

## 8. Sleep Timer

- UI: dropdown in popup menu (15/30/45/60 min or custom)
- Implementation: `chrome.alarms.create('sleep-timer', { delayInMinutes: N })`
- On alarm fire: call PUT /me/player/pause
- Active timer shown as badge in popup header
- Cancel option available while timer is running

## 9. Share Card (Canvas API)

- Triggered from dashboard "Share" button
- Renders a 600×340 pixel-art styled card:
  - Album art (scaled with `imageSmoothingEnabled: false` for pixel look)
  - Track name, artist, album in pixel font
  - ShardTune branding + listening stats
  - Dark background matching extension theme
- Output: copy to clipboard as PNG, or download as file
- Zero background cost — renders on button click only

## 10. Manifest.json

```json
{
  "manifest_version": 3,
  "name": "ShardTune",
  "version": "1.0.0",
  "description": "Spotify desk controller + listening analytics",
  "permissions": ["storage", "alarms", "identity"],
  "host_permissions": [
    "https://api.spotify.com/*",
    "https://accounts.spotify.com/*"
  ],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": {
      "16": "icons/icon-16.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png"
    }
  },
  "icons": {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  },
  "commands": {
    "toggle-playback": {
      "suggested_key": { "default": "Alt+Shift+P" },
      "description": "Play/Pause"
    },
    "next-track": {
      "suggested_key": { "default": "Alt+Shift+Right" },
      "description": "Next track"
    },
    "prev-track": {
      "suggested_key": { "default": "Alt+Shift+Left" },
      "description": "Previous track"
    }
  }
}
```

## 11. Setup Instructions (for user after build)

1. Go to https://developer.spotify.com/dashboard — create an app
2. Set redirect URI to: `https://<extension-id>.chromiumapp.org/`
   (get extension ID from `chrome://extensions` after loading unpacked)
3. Copy the Client ID
4. Open `utils/spotify.js`, replace `YOUR_CLIENT_ID_HERE` with your Client ID
5. Load as unpacked extension in Brave: `chrome://extensions` → Developer mode → Load unpacked → select the `shardtune/` folder
6. Click the ShardTune icon → authenticate with Spotify
7. Requires Spotify Premium for playback control
