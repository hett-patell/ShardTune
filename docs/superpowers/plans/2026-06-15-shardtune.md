# ShardTune Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete ShardTune Chromium MV3 browser extension — Spotify desk controller with Clean Pixel theme, session analytics, and 9 additional features.

**Architecture:** Service worker polls Spotify via port-based keep-alive (5s) or chrome.alarms (30s). Popup and dashboard connect via `chrome.runtime.connect()` ports. Auth via `chrome.identity.launchWebAuthFlow()` with PKCE. Analytics tracked in-memory, streak/peak-hours persisted to `chrome.storage.local`. All pure HTML/CSS/JS, no frameworks.

**Tech Stack:** Chromium MV3 APIs, Spotify Web API, Chart.js (CDN), Canvas API, ES modules

**Design spec:** `docs/superpowers/specs/2026-06-15-shardtune-design.md`

---

## File Map

```
shardtune/
├── manifest.json              → Extension config, permissions, commands
├── background.js              → Service worker: polling, ports, commands, sleep timer
├── utils/
│   ├── spotify.js             → PKCE auth + all Spotify API calls
│   ├── analytics.js           → Session state, energy proxy, streak, peak hours
│   └── storage.js             → Thin chrome.storage.local wrapper
├── popup/
│   ├── popup.html             → Popup markup
│   ├── popup.js               → Popup controller logic
│   └── popup.css              → Clean Pixel theme for popup
├── dashboard/
│   ├── dashboard.html         → Full analytics page markup
│   ├── dashboard.js           → Dashboard logic, charts, share card, export
│   └── dashboard.css          → Dashboard styles
└── icons/
    └── logo.svg               → Pixel bar logo (user converts to PNGs)
```

Dependencies flow: `storage.js` → `spotify.js` → `analytics.js` → `background.js` → `popup.js` / `dashboard.js`

---

### Task 1: Project Scaffold + Manifest

**Files:**
- Create: `shardtune/manifest.json`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p shardtune/{utils,popup,dashboard,icons}
```

- [ ] **Step 2: Write manifest.json**

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

- [ ] **Step 3: Verify manifest loads**

Load `shardtune/` as unpacked extension in Brave (`chrome://extensions` → Developer mode → Load unpacked). Expect: extension appears with name "ShardTune", no errors in the console. It will show a missing icon warning — that's fine for now.

- [ ] **Step 4: Commit**

```bash
git add shardtune/manifest.json
git commit -m "feat: add manifest.json with MV3 config, permissions, keyboard shortcuts"
```

---

### Task 2: Storage Utility

**Files:**
- Create: `shardtune/utils/storage.js`

- [ ] **Step 1: Write storage.js**

```js
const store = chrome.storage.local;

export async function get(key) {
  const result = await store.get(key);
  return result[key] ?? null;
}

export async function set(key, value) {
  await store.set({ [key]: value });
}

export async function remove(key) {
  await store.remove(key);
}

export async function getAll(keys) {
  return store.get(keys);
}
```

- [ ] **Step 2: Commit**

```bash
git add shardtune/utils/storage.js
git commit -m "feat: add chrome.storage.local wrapper"
```

---

### Task 3: Spotify Auth (PKCE)

**Files:**
- Create: `shardtune/utils/spotify.js`

This task creates the auth half of spotify.js. Task 4 adds API calls.

- [ ] **Step 1: Write spotify.js with PKCE auth**

```js
import * as storage from './storage.js';

const CLIENT_ID = 'YOUR_CLIENT_ID_HERE';
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing'
].join(' ');
const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';
const AUTH_ENDPOINT = 'https://accounts.spotify.com/authorize';
const API_BASE = 'https://api.spotify.com/v1';

function generateRandom(length) {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function authenticate() {
  const redirectUrl = chrome.identity.getRedirectURL();
  const codeVerifier = generateRandom(64);
  const codeChallenge = await sha256(codeVerifier);
  const state = generateRandom(16);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUrl,
    scope: SCOPES,
    state,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge
  });

  const authUrl = `${AUTH_ENDPOINT}?${params}`;

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl,
    interactive: true
  });

  const url = new URL(responseUrl);
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');

  if (returnedState !== state) {
    throw new Error('State mismatch — possible CSRF');
  }

  const tokenResponse = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUrl,
      code_verifier: codeVerifier
    })
  });

  if (!tokenResponse.ok) {
    throw new Error(`Token exchange failed: ${tokenResponse.status}`);
  }

  const tokens = await tokenResponse.json();
  await saveTokens(tokens);
  return tokens.access_token;
}

async function saveTokens(tokens) {
  await storage.set('access_token', tokens.access_token);
  await storage.set('refresh_token', tokens.refresh_token);
  await storage.set('expires_at', Date.now() + tokens.expires_in * 1000);
}

export async function refreshAccessToken() {
  const refreshToken = await storage.get('refresh_token');
  if (!refreshToken) throw new Error('No refresh token');

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    })
  });

  if (!response.ok) {
    await storage.remove('access_token');
    await storage.remove('refresh_token');
    await storage.remove('expires_at');
    throw new Error('Refresh failed — re-auth required');
  }

  const tokens = await response.json();
  await saveTokens({
    ...tokens,
    refresh_token: tokens.refresh_token || refreshToken
  });
  return tokens.access_token;
}

export async function getValidToken() {
  const expiresAt = await storage.get('expires_at');
  const accessToken = await storage.get('access_token');

  if (!accessToken) return null;

  if (Date.now() > (expiresAt || 0) - 60000) {
    try {
      return await refreshAccessToken();
    } catch {
      return null;
    }
  }

  return accessToken;
}

export async function logout() {
  await storage.remove('access_token');
  await storage.remove('refresh_token');
  await storage.remove('expires_at');
}

async function apiFetch(endpoint, options = {}) {
  const token = await getValidToken();
  if (!token) throw new Error('Not authenticated');

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...options.headers
    }
  });

  if (response.status === 401) {
    const newToken = await refreshAccessToken();
    const retry = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${newToken}`,
        ...options.headers
      }
    });
    if (!retry.ok && retry.status !== 204) {
      throw new Error(`API error: ${retry.status}`);
    }
    return retry.status === 204 ? null : retry.json();
  }

  if (!response.ok && response.status !== 204) {
    throw new Error(`API error: ${response.status}`);
  }

  return response.status === 204 ? null : response.json();
}

// --- Player API ---

export function getPlayerState() {
  return apiFetch('/me/player');
}

export function getDevices() {
  return apiFetch('/me/player/devices');
}

export function getQueue() {
  return apiFetch('/me/player/queue');
}

export function play(deviceId) {
  const params = deviceId ? `?device_id=${deviceId}` : '';
  return apiFetch(`/me/player/play${params}`, { method: 'PUT' });
}

export function pause() {
  return apiFetch('/me/player/pause', { method: 'PUT' });
}

export function next() {
  return apiFetch('/me/player/next', { method: 'POST' });
}

export function previous() {
  return apiFetch('/me/player/previous', { method: 'POST' });
}

export function seek(positionMs) {
  return apiFetch(`/me/player/seek?position_ms=${positionMs}`, { method: 'PUT' });
}

export function setVolume(percent) {
  return apiFetch(`/me/player/volume?volume_percent=${percent}`, { method: 'PUT' });
}

export function setShuffle(state) {
  return apiFetch(`/me/player/shuffle?state=${state}`, { method: 'PUT' });
}

export function setRepeat(mode) {
  return apiFetch(`/me/player/repeat?state=${mode}`, { method: 'PUT' });
}

export function transferPlayback(deviceId, play = true) {
  return apiFetch('/me/player', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_ids: [deviceId], play })
  });
}
```

- [ ] **Step 2: Verify module syntax**

Load the extension in Brave. Open the service worker console (click "Inspect views: service worker" on the extensions page). Should see no import errors. Auth won't work yet without background.js wiring — that's expected.

- [ ] **Step 3: Commit**

```bash
git add shardtune/utils/spotify.js
git commit -m "feat: add Spotify PKCE auth + full player API wrapper"
```

---

### Task 4: Analytics Engine

**Files:**
- Create: `shardtune/utils/analytics.js`

- [ ] **Step 1: Write analytics.js**

```js
import * as storage from './storage.js';

let session = createSession();

function createSession() {
  return {
    sessionStart: Date.now(),
    totalListenMs: 0,
    trackChanges: 0,
    skips: 0,
    artists: new Set(),
    history: [],
    energyHistory: [],
    lastTrackId: null,
    lastPollTime: null,
    currentTrackStart: null,
    currentTrackListened: 0
  };
}

export function resetSession() {
  session = createSession();
}

export function getSession() {
  return {
    sessionStart: session.sessionStart,
    totalListenMs: session.totalListenMs,
    trackChanges: session.trackChanges,
    skips: session.skips,
    artistCount: session.artists.size,
    artists: [...session.artists],
    history: session.history,
    energyHistory: session.energyHistory
  };
}

export function energyProxy(track) {
  const popularity = track.popularity || 50;
  const durationMs = track.duration_ms || 200000;
  const explicit = track.explicit || false;

  const popScore = popularity * 0.65;
  const durScore = Math.max(0, 100 - (durationMs / 240000) * 18) * 0.25;
  const expScore = explicit ? 8 : 0;

  return Math.min(100, Math.max(15, popScore + durScore + expScore));
}

export function processPlayerState(state) {
  if (!state || !state.item) return;

  const now = Date.now();
  const track = state.item;
  const isPlaying = state.is_playing;

  if (isPlaying && session.lastPollTime) {
    const elapsed = now - session.lastPollTime;
    if (elapsed > 0 && elapsed < 15000) {
      session.totalListenMs += elapsed;
      session.currentTrackListened += elapsed;
    }
  }

  if (track.id !== session.lastTrackId) {
    if (session.lastTrackId !== null) {
      session.trackChanges++;
      finalizeTrack(track);
    }

    session.lastTrackId = track.id;
    session.currentTrackStart = now;
    session.currentTrackListened = 0;

    track.artists?.forEach(a => session.artists.add(a.name));

    const energy = energyProxy(track);
    session.energyHistory.push({
      label: track.name?.substring(0, 20) || 'Unknown',
      value: Math.round(energy),
      trackId: track.id
    });
    if (session.energyHistory.length > 20) {
      session.energyHistory.shift();
    }
  }

  session.lastPollTime = now;
}

function finalizeTrack(newTrack) {
  const lastEntry = session.history[session.history.length - 1];
  if (lastEntry && !lastEntry.finalized) {
    lastEntry.listenedMs = session.currentTrackListened;
    const ratio = lastEntry.durationMs > 0
      ? lastEntry.listenedMs / lastEntry.durationMs
      : 1;
    lastEntry.skipped = ratio < 0.8;
    lastEntry.finalized = true;
    if (lastEntry.skipped) session.skips++;
  }

  const artists = newTrack.artists?.map(a => a.name).join(', ') || 'Unknown';
  session.history.push({
    id: newTrack.id,
    name: newTrack.name,
    artist: artists,
    album: newTrack.album?.name || '',
    artUrl: newTrack.album?.images?.[0]?.url || '',
    startedAt: Date.now(),
    durationMs: newTrack.duration_ms || 0,
    listenedMs: 0,
    skipped: false,
    finalized: false
  });

  if (session.history.length > 20) {
    session.history.shift();
  }
}

// --- Persistent: Streak ---

export async function updateStreak() {
  const today = new Date().toISOString().split('T')[0];
  const streak = (await storage.get('streak')) || { count: 0, lastDate: null };

  if (streak.lastDate === today) return streak;

  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  if (streak.lastDate === yesterday) {
    streak.count++;
  } else {
    streak.count = 1;
  }

  streak.lastDate = today;
  await storage.set('streak', streak);
  return streak;
}

export async function getStreak() {
  const streak = (await storage.get('streak')) || { count: 0, lastDate: null };
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  if (streak.lastDate !== today && streak.lastDate !== yesterday) {
    return { count: 0, lastDate: streak.lastDate };
  }
  return streak;
}

// --- Persistent: Peak Hours ---

export async function updatePeakHours() {
  const hours = (await storage.get('peakHours')) || new Array(24).fill(0);
  const currentHour = new Date().getHours();
  hours[currentHour] += 5;
  await storage.set('peakHours', hours);
  return hours;
}

export async function getPeakHours() {
  return (await storage.get('peakHours')) || new Array(24).fill(0);
}
```

- [ ] **Step 2: Verify module loads**

Reload extension in Brave. Check service worker console — no syntax errors from analytics.js import.

- [ ] **Step 3: Commit**

```bash
git add shardtune/utils/analytics.js
git commit -m "feat: add analytics engine with energy proxy, streak, peak hours"
```

---

### Task 5: Background Service Worker

**Files:**
- Create: `shardtune/background.js`

- [ ] **Step 1: Write background.js**

```js
import * as spotify from './utils/spotify.js';
import * as analytics from './utils/analytics.js';
import * as storage from './utils/storage.js';

const POLL_FAST = 5000;
const POLL_SLOW_MINUTES = 0.5;
const ALARM_POLL = 'shardtune-poll';
const ALARM_SLEEP = 'shardtune-sleep';

let ports = new Set();
let pollInterval = null;
let lastState = null;

// --- Port Management ---

chrome.runtime.onConnect.addListener(port => {
  ports.add(port);
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    if (ports.size === 0) {
      stopFastPolling();
      startSlowPolling();
    }
  });

  startFastPolling();
  chrome.alarms.clear(ALARM_POLL);

  if (lastState) {
    port.postMessage({ type: 'state', data: lastState });
  }

  port.onMessage.addListener(msg => handlePortMessage(msg, port));
});

function broadcast(message) {
  for (const port of ports) {
    try { port.postMessage(message); } catch {}
  }
}

// --- Polling ---

function startFastPolling() {
  if (pollInterval) return;
  pollInterval = setInterval(poll, POLL_FAST);
  poll();
}

function stopFastPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

function startSlowPolling() {
  chrome.alarms.create(ALARM_POLL, { periodInMinutes: POLL_SLOW_MINUTES });
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_POLL) {
    poll();
  }
  if (alarm.name === ALARM_SLEEP) {
    spotify.pause().catch(() => {});
    broadcast({ type: 'sleep-fired' });
    storage.remove('sleepTimer');
  }
});

async function poll() {
  try {
    const token = await spotify.getValidToken();
    if (!token) {
      broadcast({ type: 'auth-required' });
      return;
    }

    const state = await spotify.getPlayerState();
    lastState = state;

    if (state) {
      analytics.processPlayerState(state);

      if (state.is_playing) {
        await analytics.updateStreak();
        await analytics.updatePeakHours();
      }
    }

    const session = analytics.getSession();
    const streak = await analytics.getStreak();

    broadcast({ type: 'state', data: state });
    broadcast({ type: 'analytics', data: { session, streak } });
  } catch (err) {
    if (err.message?.includes('Not authenticated')) {
      broadcast({ type: 'auth-required' });
    }
  }
}

// --- Port Message Handling ---

async function handlePortMessage(msg, port) {
  try {
    switch (msg.action) {
      case 'authenticate': {
        await spotify.authenticate();
        await poll();
        break;
      }
      case 'play':
        await spotify.play(msg.deviceId);
        setTimeout(poll, 300);
        break;
      case 'pause':
        await spotify.pause();
        setTimeout(poll, 300);
        break;
      case 'next':
        await spotify.next();
        setTimeout(poll, 500);
        break;
      case 'previous':
        await spotify.previous();
        setTimeout(poll, 500);
        break;
      case 'seek':
        await spotify.seek(msg.positionMs);
        setTimeout(poll, 300);
        break;
      case 'volume':
        await spotify.setVolume(msg.percent);
        setTimeout(poll, 300);
        break;
      case 'shuffle':
        await spotify.setShuffle(msg.state);
        setTimeout(poll, 300);
        break;
      case 'repeat':
        await spotify.setRepeat(msg.mode);
        setTimeout(poll, 300);
        break;
      case 'transfer':
        await spotify.transferPlayback(msg.deviceId);
        setTimeout(poll, 500);
        break;
      case 'get-devices': {
        const devices = await spotify.getDevices();
        port.postMessage({ type: 'devices', data: devices });
        break;
      }
      case 'get-queue': {
        const queue = await spotify.getQueue();
        port.postMessage({ type: 'queue', data: queue });
        break;
      }
      case 'get-analytics': {
        const session = analytics.getSession();
        const streak = await analytics.getStreak();
        const peakHours = await analytics.getPeakHours();
        port.postMessage({ type: 'analytics', data: { session, streak, peakHours } });
        break;
      }
      case 'set-sleep': {
        if (msg.minutes > 0) {
          chrome.alarms.create(ALARM_SLEEP, { delayInMinutes: msg.minutes });
          const expiresAt = Date.now() + msg.minutes * 60000;
          await storage.set('sleepTimer', expiresAt);
          broadcast({ type: 'sleep-set', data: { expiresAt } });
        } else {
          chrome.alarms.clear(ALARM_SLEEP);
          await storage.remove('sleepTimer');
          broadcast({ type: 'sleep-cleared' });
        }
        break;
      }
      case 'get-sleep': {
        const expiresAt = await storage.get('sleepTimer');
        port.postMessage({ type: 'sleep-status', data: { expiresAt } });
        break;
      }
      case 'logout':
        await spotify.logout();
        lastState = null;
        analytics.resetSession();
        broadcast({ type: 'auth-required' });
        break;
    }
  } catch (err) {
    port.postMessage({ type: 'error', data: err.message });
  }
}

// --- Keyboard Shortcuts ---

chrome.commands.onCommand.addListener(async command => {
  try {
    const token = await spotify.getValidToken();
    if (!token) return;

    switch (command) {
      case 'toggle-playback':
        if (lastState?.is_playing) {
          await spotify.pause();
        } else {
          await spotify.play();
        }
        setTimeout(poll, 300);
        break;
      case 'next-track':
        await spotify.next();
        setTimeout(poll, 500);
        break;
      case 'prev-track':
        await spotify.previous();
        setTimeout(poll, 500);
        break;
    }
  } catch {}
});

// --- Startup ---

chrome.runtime.onInstalled.addListener(() => {
  startSlowPolling();
});

chrome.runtime.onStartup.addListener(() => {
  startSlowPolling();
});
```

- [ ] **Step 2: Verify service worker registers**

Reload extension. Go to `chrome://extensions`, check that the service worker is listed under ShardTune. Click "Inspect views: service worker" — console should be clean (no errors). You'll see "Not authenticated" broadcast since there's no token yet — that's correct.

- [ ] **Step 3: Commit**

```bash
git add shardtune/background.js
git commit -m "feat: add service worker with polling, port management, keyboard shortcuts, sleep timer"
```

---

### Task 6: Popup CSS (Clean Pixel Theme)

**Files:**
- Create: `shardtune/popup/popup.css`

- [ ] **Step 1: Write popup.css**

```css
@import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');

:root {
  --bg: #0b0e11;
  --surface: #111820;
  --surface-2: #182028;
  --border: rgba(255,255,255,0.06);
  --border-hover: rgba(255,255,255,0.12);
  --text: #f1f5f9;
  --text-2: #c8d0d8;
  --text-muted: #7a8a98;
  --text-faint: #4a5568;
  --text-ghost: #2a3a46;
  --primary: #1db954;
  --primary-dim: rgba(29,185,84,0.12);
  --primary-glow: rgba(29,185,84,0.25);
  --streak: #f59e0b;
  --streak-dim: #92400e;
  --error: #ff5d73;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  width: 380px;
  min-height: 200px;
  background: var(--bg);
  color: var(--text);
  font-family: 'Inter', -apple-system, sans-serif;
  font-size: 12px;
  overflow-x: hidden;
  position: relative;
}

/* Scanline overlay */
body::after {
  content: '';
  position: fixed;
  inset: 0;
  background: repeating-linear-gradient(
    0deg,
    transparent,
    transparent 2px,
    rgba(0,0,0,0.06) 2px,
    rgba(0,0,0,0.06) 4px
  );
  pointer-events: none;
  z-index: 100;
}

/* === AUTH SCREEN === */

.auth-screen {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 300px;
  gap: 20px;
  padding: 40px;
  text-align: center;
}

.auth-screen .logo-large svg {
  width: 48px;
  height: 48px;
  filter: drop-shadow(0 0 12px var(--primary-glow));
}

.auth-screen .brand-large {
  font-family: 'Press Start 2P', monospace;
  font-size: 14px;
  color: var(--primary);
  letter-spacing: 2px;
  text-shadow: 0 0 16px var(--primary-glow);
}

.auth-screen .tagline {
  font-size: 12px;
  color: var(--text-muted);
}

.auth-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 24px;
  background: var(--primary);
  border: none;
  color: #000;
  font-family: 'Inter', sans-serif;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 0 20px var(--primary-glow), 0 2px 8px rgba(0,0,0,0.3);
  transition: all 0.2s;
}

.auth-btn:hover {
  background: #22d35e;
  box-shadow: 0 0 28px var(--primary-glow);
}

/* === HEADER === */

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: linear-gradient(180deg, rgba(29,185,84,0.06) 0%, transparent 100%);
  border-bottom: 1px solid var(--border);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.logo svg {
  width: 22px;
  height: 22px;
  filter: drop-shadow(0 0 6px rgba(29,185,84,0.4));
}

.brand {
  font-family: 'Press Start 2P', monospace;
  font-size: 9px;
  color: var(--primary);
  letter-spacing: 1.5px;
  text-shadow: 0 0 12px rgba(29,185,84,0.3);
}

.header-right {
  display: flex;
  gap: 4px;
  align-items: center;
}

.h-btn {
  width: 30px;
  height: 30px;
  background: rgba(255,255,255,0.03);
  border: 1px solid var(--border);
  color: var(--text-faint);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s;
}

.h-btn:hover {
  background: var(--primary-dim);
  border-color: rgba(29,185,84,0.2);
  color: var(--primary);
}

.h-btn svg {
  width: 14px;
  height: 14px;
}

.sleep-badge {
  display: none;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: rgba(99,102,241,0.1);
  border: 1px solid rgba(99,102,241,0.2);
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  color: #818cf8;
  cursor: pointer;
}

.sleep-badge.active {
  display: flex;
}

/* === NOW PLAYING === */

.now-playing {
  padding: 16px;
  display: flex;
  gap: 14px;
}

.art-frame {
  width: 80px;
  height: 80px;
  flex-shrink: 0;
  position: relative;
  background: var(--surface);
  border: 1px solid var(--border);
  overflow: hidden;
}

.art-frame img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.art-frame .art-placeholder {
  width: 100%;
  height: 100%;
  background: linear-gradient(135deg, #0d2818 0%, #1a4a2a 40%, #0f3520 100%);
  display: flex;
  align-items: center;
  justify-content: center;
}

.art-frame .art-placeholder svg {
  width: 32px;
  height: 32px;
  opacity: 0.35;
}

/* Pixel grid on album art */
.art-frame::after {
  content: '';
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px);
  background-size: 8px 8px;
  pointer-events: none;
}

.track-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
}

.track-name {
  font-weight: 700;
  font-size: 15px;
  color: var(--text);
  letter-spacing: -0.2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.3;
}

.track-sub {
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.track-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}

.device-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  background: var(--primary-dim);
  border: 1px solid rgba(29,185,84,0.12);
}

.pulse-dot {
  width: 5px;
  height: 5px;
  background: var(--primary);
  box-shadow: 0 0 6px rgba(29,185,84,0.6);
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.device-name {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  color: var(--primary);
  font-weight: 500;
}

.copy-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  background: none;
  border: 1px solid var(--border);
  color: var(--text-faint);
  cursor: pointer;
  transition: all 0.2s;
}

.copy-btn:hover {
  border-color: rgba(29,185,84,0.2);
  color: var(--primary);
}

.copy-btn.copied {
  border-color: var(--primary);
  color: var(--primary);
}

.copy-btn svg {
  width: 12px;
  height: 12px;
}

/* === PROGRESS === */

.progress-section {
  padding: 2px 16px 12px;
}

.progress-track {
  width: 100%;
  height: 3px;
  background: var(--border);
  position: relative;
  cursor: pointer;
}

.progress-track:hover .progress-fill {
  height: 5px;
  top: -1px;
}

.progress-track:hover .progress-knob {
  opacity: 1;
}

.progress-fill {
  position: absolute;
  top: 0;
  left: 0;
  height: 3px;
  background: var(--primary);
  width: 0%;
  transition: height 0.15s, top 0.15s;
  box-shadow: 0 0 8px rgba(29,185,84,0.3);
}

.progress-knob {
  position: absolute;
  right: -4px;
  top: -3px;
  width: 9px;
  height: 9px;
  background: var(--primary);
  box-shadow: 0 0 8px rgba(29,185,84,0.5);
  opacity: 0;
  transition: opacity 0.15s;
}

.progress-times {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--text-faint);
  font-weight: 500;
}

/* === TRANSPORT === */

.transport {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 4px 16px 14px;
}

.t-btn {
  width: 36px;
  height: 36px;
  background: transparent;
  border: 1px solid rgba(255,255,255,0.08);
  color: var(--text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s;
}

.t-btn:hover {
  border-color: var(--border-hover);
  color: var(--text-2);
}

.t-btn svg {
  width: 14px;
  height: 14px;
}

.t-btn.play {
  width: 44px;
  height: 44px;
  background: var(--primary);
  border: none;
  color: var(--bg);
  box-shadow: 0 0 20px var(--primary-glow), 0 2px 8px rgba(0,0,0,0.3);
}

.t-btn.play:hover {
  background: #22d35e;
  box-shadow: 0 0 28px rgba(29,185,84,0.35);
}

.t-btn.play svg {
  width: 18px;
  height: 18px;
}

.t-btn.subtle {
  width: 30px;
  height: 30px;
  border: none;
  color: var(--text-faint);
}

.t-btn.subtle.active {
  color: var(--primary);
}

.t-btn.subtle:hover {
  color: var(--text-muted);
}

/* === VOLUME === */

.volume-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 16px 14px;
}

.vol-icon {
  color: var(--text-faint);
  display: flex;
  width: 16px;
  justify-content: center;
}

.vol-icon svg {
  width: 14px;
  height: 14px;
}

.vol-track {
  flex: 1;
  height: 3px;
  background: var(--border);
  position: relative;
  cursor: pointer;
}

.vol-fill {
  height: 100%;
  width: 0%;
  background: linear-gradient(90deg, var(--primary), #17a34a);
}

.vol-pct {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--text-faint);
  font-weight: 500;
  width: 30px;
  text-align: right;
}

/* === SEPARATOR === */

.sep {
  height: 1px;
  margin: 0 16px;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent);
}

/* === QUEUE === */

.queue-section {
  padding: 10px 16px 12px;
}

.section-label {
  font-family: 'Press Start 2P', monospace;
  font-size: 7px;
  color: var(--text-ghost);
  letter-spacing: 2px;
  text-transform: uppercase;
  margin-bottom: 8px;
}

.q-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.q-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  transition: background 0.15s;
  cursor: default;
}

.q-item:hover {
  background: rgba(255,255,255,0.02);
}

.q-idx {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  color: var(--text-ghost);
  width: 16px;
  font-weight: 600;
}

.q-art {
  width: 28px;
  height: 28px;
  background: var(--surface);
  border: 1px solid var(--border);
  flex-shrink: 0;
  overflow: hidden;
}

.q-art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.q-info {
  flex: 1;
  min-width: 0;
}

.q-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.q-artist {
  font-size: 10px;
  color: var(--text-faint);
}

.q-dur {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  color: var(--text-ghost);
  font-weight: 500;
}

/* === BOTTOM STATS BAR === */

.bottom-bar {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  padding: 10px 12px;
  background: linear-gradient(180deg, transparent 0%, rgba(29,185,84,0.03) 100%);
  border-top: 1px solid var(--border);
}

.b-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.b-val {
  font-family: 'JetBrains Mono', monospace;
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  line-height: 1;
}

.b-val.streak {
  color: var(--streak);
  text-shadow: 0 0 8px rgba(245,158,11,0.3);
}

.b-label {
  font-family: 'Press Start 2P', monospace;
  font-size: 6px;
  color: var(--text-ghost);
  letter-spacing: 1px;
  text-transform: uppercase;
}

.b-label.streak {
  color: var(--streak-dim);
}

/* === SLEEP TIMER DROPDOWN === */

.sleep-dropdown {
  display: none;
  position: absolute;
  top: 42px;
  right: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  z-index: 50;
  min-width: 140px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.4);
}

.sleep-dropdown.open {
  display: block;
}

.sleep-option {
  padding: 8px 14px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text-2);
  cursor: pointer;
  transition: all 0.15s;
}

.sleep-option:hover {
  background: var(--primary-dim);
  color: var(--primary);
}

/* === DEVICE PICKER === */

.device-dropdown {
  display: none;
  position: absolute;
  top: 120px;
  left: 16px;
  right: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  z-index: 50;
  box-shadow: 0 4px 16px rgba(0,0,0,0.4);
  max-height: 200px;
  overflow-y: auto;
}

.device-dropdown.open {
  display: block;
}

.device-option {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  cursor: pointer;
  transition: all 0.15s;
}

.device-option:hover {
  background: var(--primary-dim);
}

.device-option .d-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-2);
}

.device-option .d-type {
  font-size: 10px;
  color: var(--text-faint);
}

.device-option.active .d-name {
  color: var(--primary);
}

/* === EMPTY / LOADING STATES === */

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px;
  gap: 12px;
  text-align: center;
  min-height: 200px;
}

.empty-state .empty-icon svg {
  width: 40px;
  height: 40px;
  color: var(--text-ghost);
}

.empty-state .empty-text {
  font-size: 12px;
  color: var(--text-faint);
}

.hidden {
  display: none !important;
}
```

- [ ] **Step 2: Commit**

```bash
git add shardtune/popup/popup.css
git commit -m "feat: add Clean Pixel theme CSS for popup"
```

---

### Task 7: Popup HTML

**Files:**
- Create: `shardtune/popup/popup.html`

- [ ] **Step 1: Write popup.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="popup.css">
</head>
<body>

  <!-- AUTH SCREEN -->
  <div id="auth-screen" class="auth-screen">
    <div class="logo-large">
      <svg viewBox="0 0 24 24" fill="none">
        <rect x="2" y="6" width="4" height="12" fill="#1db954"/>
        <rect x="8" y="3" width="4" height="18" fill="#1db954"/>
        <rect x="14" y="8" width="4" height="8" fill="#1db954"/>
        <rect x="20" y="10" width="3" height="4" fill="#1db954" opacity="0.4"/>
      </svg>
    </div>
    <div class="brand-large">SHARDTUNE</div>
    <div class="tagline">Spotify desk controller</div>
    <button id="auth-btn" class="auth-btn">Connect Spotify</button>
  </div>

  <!-- PLAYER SCREEN -->
  <div id="player-screen" class="hidden">

    <!-- Header -->
    <div class="header">
      <div class="header-left">
        <div class="logo">
          <svg viewBox="0 0 24 24" fill="none">
            <rect x="2" y="6" width="4" height="12" fill="#1db954"/>
            <rect x="8" y="3" width="4" height="18" fill="#1db954"/>
            <rect x="14" y="8" width="4" height="8" fill="#1db954"/>
            <rect x="20" y="10" width="3" height="4" fill="#1db954" opacity="0.4"/>
          </svg>
        </div>
        <span class="brand">SHARDTUNE</span>
      </div>
      <div class="header-right">
        <div id="sleep-badge" class="sleep-badge" title="Sleep timer active">
          <svg viewBox="0 0 12 12" fill="currentColor" width="10" height="10">
            <rect x="5" y="1" width="2" height="5"/>
            <rect x="5" y="5" width="5" height="2"/>
            <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/>
          </svg>
          <span id="sleep-countdown"></span>
        </div>
        <div id="sleep-btn" class="h-btn" title="Sleep timer">
          <svg viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 2v4.5l3 1.5-.5 1L7 8V3h1z"/>
          </svg>
        </div>
        <div id="dashboard-btn" class="h-btn" title="Open dashboard">
          <svg viewBox="0 0 16 16" fill="none">
            <rect x="1" y="1" width="6" height="6" fill="currentColor" opacity="0.8"/>
            <rect x="9" y="1" width="6" height="6" fill="currentColor" opacity="0.5"/>
            <rect x="1" y="9" width="6" height="6" fill="currentColor" opacity="0.5"/>
            <rect x="9" y="9" width="6" height="6" fill="currentColor" opacity="0.3"/>
          </svg>
        </div>
        <div id="menu-btn" class="h-btn" title="Menu">
          <svg viewBox="0 0 16 16" fill="none">
            <rect x="2" y="3" width="12" height="2" fill="currentColor"/>
            <rect x="2" y="7" width="12" height="2" fill="currentColor"/>
            <rect x="2" y="11" width="12" height="2" fill="currentColor"/>
          </svg>
        </div>
      </div>
    </div>

    <!-- Sleep Timer Dropdown -->
    <div id="sleep-dropdown" class="sleep-dropdown">
      <div class="sleep-option" data-minutes="15">15 minutes</div>
      <div class="sleep-option" data-minutes="30">30 minutes</div>
      <div class="sleep-option" data-minutes="45">45 minutes</div>
      <div class="sleep-option" data-minutes="60">60 minutes</div>
      <div class="sleep-option" data-minutes="0">Cancel timer</div>
    </div>

    <!-- Now Playing -->
    <div class="now-playing">
      <div class="art-frame" id="device-trigger" title="Switch device">
        <img id="album-art" class="hidden" alt="">
        <div id="art-placeholder" class="art-placeholder">
          <svg viewBox="0 0 24 24" fill="#1db954">
            <rect x="8" y="2" width="2" height="14"/>
            <rect x="16" y="4" width="2" height="12"/>
            <rect x="10" y="2" width="8" height="2"/>
            <rect x="4" y="14" width="6" height="4"/>
            <rect x="12" y="12" width="6" height="4"/>
          </svg>
        </div>
      </div>
      <div class="track-meta">
        <div id="track-name" class="track-name">Not playing</div>
        <div id="track-sub" class="track-sub">—</div>
        <div class="track-actions">
          <div id="device-tag" class="device-tag hidden">
            <div class="pulse-dot"></div>
            <span id="device-label" class="device-name"></span>
          </div>
          <button id="copy-btn" class="copy-btn hidden" title="Copy track link">
            <svg viewBox="0 0 16 16" fill="currentColor">
              <rect x="4" y="4" width="8" height="10" rx="0" fill="none" stroke="currentColor" stroke-width="1.5"/>
              <path d="M6 4V2h8v10h-2" fill="none" stroke="currentColor" stroke-width="1.5"/>
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Device Picker -->
    <div id="device-dropdown" class="device-dropdown"></div>

    <!-- Progress -->
    <div class="progress-section">
      <div id="progress-track" class="progress-track">
        <div id="progress-fill" class="progress-fill">
          <div class="progress-knob"></div>
        </div>
      </div>
      <div class="progress-times">
        <span id="time-current">0:00</span>
        <span id="time-total">0:00</span>
      </div>
    </div>

    <!-- Transport -->
    <div class="transport">
      <button id="shuffle-btn" class="t-btn subtle" title="Shuffle">
        <svg viewBox="0 0 16 16" fill="currentColor">
          <path d="M11 2l3 3-3 3m3-3H9.5C7 5 5.5 8 5.5 8H2m12 3l-3 3m3-3H9.5c-2.5 0-4-3-4-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/>
        </svg>
      </button>
      <button id="prev-btn" class="t-btn" title="Previous">
        <svg viewBox="0 0 16 16" fill="currentColor">
          <rect x="1" y="2" width="2" height="12"/>
          <polygon points="14,2 14,14 5,8"/>
        </svg>
      </button>
      <button id="play-btn" class="t-btn play" title="Play">
        <svg id="icon-play" viewBox="0 0 16 16" fill="currentColor">
          <polygon points="4,2 4,14 13,8"/>
        </svg>
        <svg id="icon-pause" viewBox="0 0 16 16" fill="currentColor" class="hidden">
          <rect x="3" y="2" width="4" height="12"/>
          <rect x="9" y="2" width="4" height="12"/>
        </svg>
      </button>
      <button id="next-btn" class="t-btn" title="Next">
        <svg viewBox="0 0 16 16" fill="currentColor">
          <polygon points="2,2 2,14 11,8"/>
          <rect x="13" y="2" width="2" height="12"/>
        </svg>
      </button>
      <button id="repeat-btn" class="t-btn subtle" title="Repeat">
        <svg viewBox="0 0 16 16" fill="currentColor">
          <path d="M2 5h12v4m0-4l-2-2m2 2l-2 2M14 11H2V7m0 4l2 2m-2-2l2-2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/>
        </svg>
      </button>
    </div>

    <!-- Volume -->
    <div class="volume-row">
      <div class="vol-icon">
        <svg viewBox="0 0 16 16" fill="currentColor">
          <rect x="0" y="5" width="4" height="6"/>
          <polygon points="4,5 9,1 9,15 4,11"/>
          <rect x="11" y="4" width="1.5" height="8" opacity="0.6"/>
          <rect x="13.5" y="2" width="1.5" height="12" opacity="0.3"/>
        </svg>
      </div>
      <div id="vol-track" class="vol-track">
        <div id="vol-fill" class="vol-fill"></div>
      </div>
      <span id="vol-pct" class="vol-pct">—</span>
    </div>

    <div class="sep"></div>

    <!-- Queue -->
    <div class="queue-section">
      <div class="section-label">&#9654; Up Next</div>
      <div id="queue-list" class="q-list">
        <div class="q-item">
          <span class="q-idx" style="color:var(--text-ghost)">—</span>
        </div>
      </div>
    </div>

    <div class="sep"></div>

    <!-- Stats Bar -->
    <div class="bottom-bar">
      <div class="b-stat">
        <span id="stat-min" class="b-val">0</span>
        <span class="b-label">MIN</span>
      </div>
      <div class="b-stat">
        <span id="stat-skips" class="b-val">0</span>
        <span class="b-label">SKIPS</span>
      </div>
      <div class="b-stat">
        <span id="stat-artists" class="b-val">0</span>
        <span class="b-label">ARTISTS</span>
      </div>
      <div class="b-stat">
        <span id="stat-streak" class="b-val streak">0d</span>
        <span class="b-label streak">STREAK</span>
      </div>
    </div>
  </div>

  <script src="popup.js" type="module"></script>
</body>
</html>
```

- [ ] **Step 2: Verify popup renders**

Reload extension. Click the ShardTune icon in the toolbar. Expect: auth screen appears with the logo, "SHARDTUNE" text, and "Connect Spotify" button. The Clean Pixel theme should be visible — dark background, scanlines, green accents.

- [ ] **Step 3: Commit**

```bash
git add shardtune/popup/popup.html
git commit -m "feat: add popup HTML with auth screen, player layout, all controls"
```

---

### Task 8: Popup JS

**Files:**
- Create: `shardtune/popup/popup.js`

- [ ] **Step 1: Write popup.js**

```js
const port = chrome.runtime.connect({ name: 'popup' });

const $ = id => document.getElementById(id);

const els = {
  authScreen: $('auth-screen'),
  playerScreen: $('player-screen'),
  authBtn: $('auth-btn'),
  albumArt: $('album-art'),
  artPlaceholder: $('art-placeholder'),
  trackName: $('track-name'),
  trackSub: $('track-sub'),
  deviceTag: $('device-tag'),
  deviceLabel: $('device-label'),
  copyBtn: $('copy-btn'),
  progressTrack: $('progress-track'),
  progressFill: $('progress-fill'),
  timeCurrent: $('time-current'),
  timeTotal: $('time-total'),
  playBtn: $('play-btn'),
  iconPlay: $('icon-play'),
  iconPause: $('icon-pause'),
  prevBtn: $('prev-btn'),
  nextBtn: $('next-btn'),
  shuffleBtn: $('shuffle-btn'),
  repeatBtn: $('repeat-btn'),
  volTrack: $('vol-track'),
  volFill: $('vol-fill'),
  volPct: $('vol-pct'),
  queueList: $('queue-list'),
  statMin: $('stat-min'),
  statSkips: $('stat-skips'),
  statArtists: $('stat-artists'),
  statStreak: $('stat-streak'),
  sleepBtn: $('sleep-btn'),
  sleepDropdown: $('sleep-dropdown'),
  sleepBadge: $('sleep-badge'),
  sleepCountdown: $('sleep-countdown'),
  dashboardBtn: $('dashboard-btn'),
  deviceTrigger: $('device-trigger'),
  deviceDropdown: $('device-dropdown'),
  menuBtn: $('menu-btn')
};

let currentState = null;
let currentTrackUri = null;
let sleepInterval = null;
let sleepExpiresAt = null;

// --- Auth ---

els.authBtn.addEventListener('click', () => {
  els.authBtn.textContent = 'Connecting...';
  port.postMessage({ action: 'authenticate' });
});

function showAuth() {
  els.authScreen.classList.remove('hidden');
  els.playerScreen.classList.add('hidden');
}

function showPlayer() {
  els.authScreen.classList.add('hidden');
  els.playerScreen.classList.remove('hidden');
  port.postMessage({ action: 'get-queue' });
  port.postMessage({ action: 'get-sleep' });
}

// --- State Rendering ---

function renderState(state) {
  if (!state || !state.item) {
    els.trackName.textContent = 'Not playing';
    els.trackSub.textContent = 'Open Spotify on a device';
    els.albumArt.classList.add('hidden');
    els.artPlaceholder.classList.remove('hidden');
    els.deviceTag.classList.add('hidden');
    els.copyBtn.classList.add('hidden');
    return;
  }

  currentState = state;
  const track = state.item;
  currentTrackUri = track.external_urls?.spotify || null;

  els.trackName.textContent = track.name || 'Unknown';

  const artists = track.artists?.map(a => a.name).join(', ') || 'Unknown';
  const album = track.album?.name || '';
  els.trackSub.textContent = album ? `${artists} · ${album}` : artists;

  const artUrl = track.album?.images?.[1]?.url || track.album?.images?.[0]?.url;
  if (artUrl) {
    els.albumArt.src = artUrl;
    els.albumArt.classList.remove('hidden');
    els.artPlaceholder.classList.add('hidden');
  } else {
    els.albumArt.classList.add('hidden');
    els.artPlaceholder.classList.remove('hidden');
  }

  if (state.device) {
    els.deviceTag.classList.remove('hidden');
    els.deviceLabel.textContent = state.device.name;
  } else {
    els.deviceTag.classList.add('hidden');
  }

  els.copyBtn.classList.toggle('hidden', !currentTrackUri);

  // Play/pause icon
  els.iconPlay.classList.toggle('hidden', state.is_playing);
  els.iconPause.classList.toggle('hidden', !state.is_playing);

  // Progress
  const progress = state.progress_ms || 0;
  const duration = track.duration_ms || 1;
  const pct = (progress / duration) * 100;
  els.progressFill.style.width = `${pct}%`;
  els.timeCurrent.textContent = formatTime(progress);
  els.timeTotal.textContent = formatTime(duration);

  // Volume
  if (state.device) {
    const vol = state.device.volume_percent ?? 0;
    els.volFill.style.width = `${vol}%`;
    els.volPct.textContent = `${vol}%`;
  }

  // Shuffle
  els.shuffleBtn.classList.toggle('active', state.shuffle_state === true);

  // Repeat
  els.repeatBtn.classList.toggle('active', state.repeat_state !== 'off');
  els.repeatBtn.title = `Repeat: ${state.repeat_state || 'off'}`;
}

function renderAnalytics(data) {
  if (!data) return;
  const { session, streak } = data;

  if (session) {
    els.statMin.textContent = Math.round(session.totalListenMs / 60000);
    els.statSkips.textContent = session.skips;
    els.statArtists.textContent = session.artistCount;
  }

  if (streak) {
    els.statStreak.textContent = `${streak.count}d`;
  }
}

function renderQueue(data) {
  if (!data || !data.queue || data.queue.length === 0) {
    els.queueList.innerHTML = `
      <div class="q-item">
        <span class="q-idx" style="color:var(--text-ghost)">Queue empty</span>
      </div>`;
    return;
  }

  const tracks = data.queue.slice(0, 3);
  els.queueList.innerHTML = tracks.map((t, i) => {
    const artUrl = t.album?.images?.[2]?.url || '';
    const artHtml = artUrl
      ? `<img src="${artUrl}" alt="">`
      : '';
    const dur = formatTime(t.duration_ms || 0);
    const artist = t.artists?.map(a => a.name).join(', ') || '';
    return `
      <div class="q-item">
        <span class="q-idx">${String(i + 1).padStart(2, '0')}</span>
        <div class="q-art">${artHtml}</div>
        <div class="q-info">
          <div class="q-name">${escapeHtml(t.name || '')}</div>
          <div class="q-artist">${escapeHtml(artist)}</div>
        </div>
        <span class="q-dur">${dur}</span>
      </div>`;
  }).join('');
}

// --- Transport Controls ---

els.playBtn.addEventListener('click', () => {
  if (currentState?.is_playing) {
    port.postMessage({ action: 'pause' });
  } else {
    port.postMessage({ action: 'play' });
  }
});

els.nextBtn.addEventListener('click', () => {
  port.postMessage({ action: 'next' });
});

els.prevBtn.addEventListener('click', () => {
  port.postMessage({ action: 'previous' });
});

els.shuffleBtn.addEventListener('click', () => {
  const newState = !(currentState?.shuffle_state === true);
  port.postMessage({ action: 'shuffle', state: newState });
});

els.repeatBtn.addEventListener('click', () => {
  const modes = ['off', 'context', 'track'];
  const current = currentState?.repeat_state || 'off';
  const nextIdx = (modes.indexOf(current) + 1) % modes.length;
  port.postMessage({ action: 'repeat', mode: modes[nextIdx] });
});

// --- Seek ---

els.progressTrack.addEventListener('click', e => {
  if (!currentState?.item) return;
  const rect = els.progressTrack.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  const posMs = Math.round(pct * currentState.item.duration_ms);
  port.postMessage({ action: 'seek', positionMs: posMs });
});

// --- Volume ---

els.volTrack.addEventListener('click', e => {
  const rect = els.volTrack.getBoundingClientRect();
  const pct = Math.round(((e.clientX - rect.left) / rect.width) * 100);
  const clamped = Math.max(0, Math.min(100, pct));
  port.postMessage({ action: 'volume', percent: clamped });
  els.volFill.style.width = `${clamped}%`;
  els.volPct.textContent = `${clamped}%`;
});

// --- Copy Link ---

els.copyBtn.addEventListener('click', async () => {
  if (!currentTrackUri) return;
  try {
    await navigator.clipboard.writeText(currentTrackUri);
    els.copyBtn.classList.add('copied');
    setTimeout(() => els.copyBtn.classList.remove('copied'), 1500);
  } catch {}
});

// --- Sleep Timer ---

els.sleepBtn.addEventListener('click', e => {
  e.stopPropagation();
  els.sleepDropdown.classList.toggle('open');
  els.deviceDropdown.classList.remove('open');
});

els.sleepDropdown.addEventListener('click', e => {
  const option = e.target.closest('.sleep-option');
  if (!option) return;
  const minutes = parseInt(option.dataset.minutes);
  port.postMessage({ action: 'set-sleep', minutes });
  els.sleepDropdown.classList.remove('open');
});

function updateSleepBadge() {
  if (!sleepExpiresAt || Date.now() >= sleepExpiresAt) {
    els.sleepBadge.classList.remove('active');
    if (sleepInterval) { clearInterval(sleepInterval); sleepInterval = null; }
    return;
  }

  els.sleepBadge.classList.add('active');
  const remaining = Math.max(0, Math.ceil((sleepExpiresAt - Date.now()) / 60000));
  els.sleepCountdown.textContent = `${remaining}m`;
}

// --- Device Picker ---

els.deviceTrigger.addEventListener('click', () => {
  els.deviceDropdown.classList.toggle('open');
  els.sleepDropdown.classList.remove('open');
  if (els.deviceDropdown.classList.contains('open')) {
    port.postMessage({ action: 'get-devices' });
  }
});

function renderDevices(data) {
  if (!data?.devices?.length) {
    els.deviceDropdown.innerHTML = `
      <div class="device-option">
        <div><div class="d-name" style="color:var(--text-faint)">No devices found</div></div>
      </div>`;
    return;
  }

  els.deviceDropdown.innerHTML = data.devices.map(d => `
    <div class="device-option ${d.is_active ? 'active' : ''}" data-id="${d.id}">
      <div>
        <div class="d-name">${escapeHtml(d.name)}</div>
        <div class="d-type">${escapeHtml(d.type)}</div>
      </div>
    </div>`).join('');

  els.deviceDropdown.querySelectorAll('.device-option[data-id]').forEach(el => {
    el.addEventListener('click', () => {
      port.postMessage({ action: 'transfer', deviceId: el.dataset.id });
      els.deviceDropdown.classList.remove('open');
    });
  });
}

// --- Dashboard ---

els.dashboardBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
});

// --- Close dropdowns on outside click ---

document.addEventListener('click', e => {
  if (!els.sleepBtn.contains(e.target) && !els.sleepDropdown.contains(e.target)) {
    els.sleepDropdown.classList.remove('open');
  }
  if (!els.deviceTrigger.contains(e.target) && !els.deviceDropdown.contains(e.target)) {
    els.deviceDropdown.classList.remove('open');
  }
});

// --- Message Handling ---

port.onMessage.addListener(msg => {
  switch (msg.type) {
    case 'state':
      if (msg.data) showPlayer();
      renderState(msg.data);
      break;
    case 'analytics':
      renderAnalytics(msg.data);
      break;
    case 'queue':
      renderQueue(msg.data);
      break;
    case 'devices':
      renderDevices(msg.data);
      break;
    case 'auth-required':
      showAuth();
      els.authBtn.textContent = 'Connect Spotify';
      break;
    case 'sleep-set':
      sleepExpiresAt = msg.data.expiresAt;
      updateSleepBadge();
      if (sleepInterval) clearInterval(sleepInterval);
      sleepInterval = setInterval(updateSleepBadge, 10000);
      break;
    case 'sleep-cleared':
    case 'sleep-fired':
      sleepExpiresAt = null;
      updateSleepBadge();
      break;
    case 'sleep-status':
      if (msg.data.expiresAt && msg.data.expiresAt > Date.now()) {
        sleepExpiresAt = msg.data.expiresAt;
        updateSleepBadge();
        if (sleepInterval) clearInterval(sleepInterval);
        sleepInterval = setInterval(updateSleepBadge, 10000);
      }
      break;
    case 'error':
      console.error('ShardTune error:', msg.data);
      break;
  }
});

// --- Helpers ---

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
```

- [ ] **Step 2: Verify popup connects to background**

Reload extension. Click popup icon. Should see auth screen. Open service worker console — should see the port connection logged (no errors). Click "Connect Spotify" — should open Spotify auth flow (will fail without a real Client ID, but the flow should start).

- [ ] **Step 3: Commit**

```bash
git add shardtune/popup/popup.js
git commit -m "feat: add popup controller JS with all transport, volume, sleep, device controls"
```

---

### Task 9: Dashboard CSS

**Files:**
- Create: `shardtune/dashboard/dashboard.css`

- [ ] **Step 1: Write dashboard.css**

```css
@import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');

:root {
  --bg: #0b0e11;
  --surface: #111820;
  --surface-2: #182028;
  --border: rgba(255,255,255,0.06);
  --border-hover: rgba(255,255,255,0.12);
  --text: #f1f5f9;
  --text-2: #c8d0d8;
  --text-muted: #7a8a98;
  --text-faint: #4a5568;
  --text-ghost: #2a3a46;
  --primary: #1db954;
  --primary-dim: rgba(29,185,84,0.12);
  --primary-glow: rgba(29,185,84,0.25);
  --streak: #f59e0b;
  --streak-dim: #92400e;
  --error: #ff5d73;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  background: var(--bg);
  color: var(--text);
  font-family: 'Inter', -apple-system, sans-serif;
  font-size: 13px;
  min-height: 100vh;
  position: relative;
}

body::after {
  content: '';
  position: fixed;
  inset: 0;
  background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.04) 2px, rgba(0,0,0,0.04) 4px);
  pointer-events: none;
  z-index: 100;
}

.container {
  max-width: 960px;
  margin: 0 auto;
  padding: 24px;
}

/* Header */
.dash-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 24px;
}

.dash-header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.dash-header svg {
  width: 28px;
  height: 28px;
  filter: drop-shadow(0 0 8px var(--primary-glow));
}

.dash-brand {
  font-family: 'Press Start 2P', monospace;
  font-size: 12px;
  color: var(--primary);
  letter-spacing: 2px;
  text-shadow: 0 0 14px rgba(29,185,84,0.3);
}

.dash-subtitle {
  font-size: 12px;
  color: var(--text-faint);
  margin-left: 12px;
}

.dash-actions {
  display: flex;
  gap: 8px;
}

.dash-btn {
  padding: 8px 16px;
  background: rgba(255,255,255,0.03);
  border: 1px solid var(--border);
  color: var(--text-muted);
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  gap: 6px;
}

.dash-btn:hover {
  background: var(--primary-dim);
  border-color: rgba(29,185,84,0.2);
  color: var(--primary);
}

/* Grid */
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.grid .full-width {
  grid-column: 1 / -1;
}

/* Panels */
.panel {
  background: var(--surface);
  border: 1px solid var(--border);
  padding: 16px;
}

.panel-title {
  font-family: 'Press Start 2P', monospace;
  font-size: 8px;
  color: var(--text-ghost);
  letter-spacing: 2px;
  text-transform: uppercase;
  margin-bottom: 14px;
}

/* Hero Now Playing */
.hero-np {
  display: flex;
  gap: 20px;
  align-items: center;
}

.hero-art {
  width: 120px;
  height: 120px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  flex-shrink: 0;
  position: relative;
  overflow: hidden;
}

.hero-art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.hero-art::after {
  content: '';
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px);
  background-size: 8px 8px;
  pointer-events: none;
}

.hero-meta {
  flex: 1;
}

.hero-track {
  font-size: 22px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 4px;
}

.hero-artist {
  font-size: 14px;
  color: var(--text-muted);
  margin-bottom: 12px;
}

.hero-stats {
  display: flex;
  gap: 20px;
}

.hero-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.hero-stat-val {
  font-family: 'JetBrains Mono', monospace;
  font-size: 20px;
  font-weight: 700;
  color: var(--text);
}

.hero-stat-val.streak {
  color: var(--streak);
  text-shadow: 0 0 10px rgba(245,158,11,0.3);
}

.hero-stat-label {
  font-family: 'Press Start 2P', monospace;
  font-size: 6px;
  color: var(--text-ghost);
  letter-spacing: 1px;
}

/* Chart */
.chart-container {
  position: relative;
  height: 200px;
}

/* Peak Hours Heatmap */
.heatmap {
  display: grid;
  grid-template-columns: repeat(24, 1fr);
  gap: 2px;
  margin-top: 8px;
}

.heatmap-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.heatmap-bar {
  width: 100%;
  height: 60px;
  background: var(--surface-2);
  position: relative;
  overflow: hidden;
}

.heatmap-fill {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: var(--primary);
  transition: height 0.3s;
}

.heatmap-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 8px;
  color: var(--text-ghost);
}

/* Devices */
.device-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.device-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--surface-2);
  border: 1px solid var(--border);
}

.device-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.device-info-name {
  font-weight: 600;
  color: var(--text-2);
  font-size: 13px;
}

.device-info-type {
  font-size: 10px;
  color: var(--text-faint);
}

.device-row.active .device-info-name {
  color: var(--primary);
}

.transfer-btn {
  padding: 4px 12px;
  background: var(--primary-dim);
  border: 1px solid rgba(29,185,84,0.15);
  color: var(--primary);
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  cursor: pointer;
  transition: all 0.2s;
}

.transfer-btn:hover {
  background: rgba(29,185,84,0.2);
}

/* Queue */
.dash-q-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px;
  transition: background 0.15s;
}

.dash-q-item:hover {
  background: rgba(255,255,255,0.02);
}

.dash-q-idx {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--text-ghost);
  width: 20px;
  font-weight: 600;
}

.dash-q-art {
  width: 36px;
  height: 36px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  flex-shrink: 0;
  overflow: hidden;
}

.dash-q-art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.dash-q-info { flex: 1; min-width: 0; }
.dash-q-name { font-size: 13px; font-weight: 500; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dash-q-artist { font-size: 11px; color: var(--text-faint); }
.dash-q-dur { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: var(--text-ghost); }

/* Top Artists */
.artist-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
}

.artist-rank {
  font-family: 'Press Start 2P', monospace;
  font-size: 8px;
  color: var(--text-ghost);
  width: 24px;
}

.artist-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-2);
  flex: 1;
}

.artist-count {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--text-faint);
}

/* Listening Log */
.log-list { display: flex; flex-direction: column; gap: 4px; }

.log-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  font-size: 12px;
}

.log-time {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--text-ghost);
  width: 50px;
  flex-shrink: 0;
}

.log-track { color: var(--text-2); flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.log-artist { color: var(--text-faint); font-size: 11px; }
.log-skipped { color: var(--error); font-family: 'JetBrains Mono', monospace; font-size: 9px; }

/* Share card preview */
.share-preview {
  display: none;
  margin-top: 12px;
  text-align: center;
}

.share-preview canvas {
  border: 1px solid var(--border);
  max-width: 100%;
}

.share-preview.active { display: block; }

/* Auth state on dashboard */
.dash-auth {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
  gap: 16px;
}

.dash-auth .brand-large {
  font-family: 'Press Start 2P', monospace;
  font-size: 16px;
  color: var(--primary);
  text-shadow: 0 0 16px var(--primary-glow);
}

.empty-panel {
  color: var(--text-faint);
  font-size: 12px;
  text-align: center;
  padding: 20px;
}
</style>
```

- [ ] **Step 2: Commit**

```bash
git add shardtune/dashboard/dashboard.css
git commit -m "feat: add dashboard CSS with grid layout, panels, heatmap, chart styles"
```

---

### Task 10: Dashboard HTML

**Files:**
- Create: `shardtune/dashboard/dashboard.html`

- [ ] **Step 1: Write dashboard.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ShardTune Dashboard</title>
  <link rel="stylesheet" href="dashboard.css">
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
</head>
<body>

  <!-- Auth Screen -->
  <div id="dash-auth" class="dash-auth hidden">
    <div class="brand-large">SHARDTUNE</div>
    <p style="color:var(--text-faint)">Open the extension popup to connect Spotify first.</p>
  </div>

  <!-- Main Dashboard -->
  <div id="dash-main" class="container">

    <!-- Header -->
    <div class="dash-header">
      <div class="dash-header-left">
        <svg viewBox="0 0 24 24" fill="none">
          <rect x="2" y="6" width="4" height="12" fill="#1db954"/>
          <rect x="8" y="3" width="4" height="18" fill="#1db954"/>
          <rect x="14" y="8" width="4" height="8" fill="#1db954"/>
          <rect x="20" y="10" width="3" height="4" fill="#1db954" opacity="0.4"/>
        </svg>
        <span class="dash-brand">SHARDTUNE</span>
        <span class="dash-subtitle">Dashboard</span>
      </div>
      <div class="dash-actions">
        <button id="share-btn" class="dash-btn">
          <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12"><polygon points="6,1 6,6 1,6"/><path d="M6 1h9v14H1V6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
          Share Card
        </button>
        <button id="export-json-btn" class="dash-btn">
          <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12"><rect x="3" y="1" width="10" height="14" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="5" y="5" width="6" height="1.5"/><rect x="5" y="8" width="6" height="1.5"/></svg>
          Export JSON
        </button>
        <button id="export-png-btn" class="dash-btn">
          <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12"><rect x="1" y="1" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="5" cy="5" r="2"/><polygon points="1,15 6,9 10,12 15,6 15,15"/></svg>
          Export PNG
        </button>
      </div>
    </div>

    <div class="grid">

      <!-- Hero: Now Playing + Stats -->
      <div class="panel full-width">
        <div class="hero-np">
          <div class="hero-art">
            <img id="hero-art-img" src="" alt="" style="display:none">
          </div>
          <div class="hero-meta">
            <div id="hero-track" class="hero-track">Not playing</div>
            <div id="hero-artist" class="hero-artist">—</div>
            <div class="hero-stats">
              <div class="hero-stat">
                <span id="h-stat-min" class="hero-stat-val">0</span>
                <span class="hero-stat-label">MINUTES</span>
              </div>
              <div class="hero-stat">
                <span id="h-stat-skips" class="hero-stat-val">0</span>
                <span class="hero-stat-label">SKIPS</span>
              </div>
              <div class="hero-stat">
                <span id="h-stat-artists" class="hero-stat-val">0</span>
                <span class="hero-stat-label">ARTISTS</span>
              </div>
              <div class="hero-stat">
                <span id="h-stat-streak" class="hero-stat-val streak">0d</span>
                <span class="hero-stat-label">STREAK</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Energy Curve -->
      <div class="panel full-width">
        <div class="panel-title">&#9889; Energy Curve</div>
        <div class="chart-container">
          <canvas id="energy-chart"></canvas>
        </div>
      </div>

      <!-- Peak Hours -->
      <div class="panel">
        <div class="panel-title">&#9200; Peak Hours</div>
        <div id="heatmap" class="heatmap"></div>
      </div>

      <!-- Devices -->
      <div class="panel">
        <div class="panel-title">&#128268; Devices</div>
        <div id="device-list" class="device-list">
          <div class="empty-panel">Loading devices...</div>
        </div>
      </div>

      <!-- Queue -->
      <div class="panel">
        <div class="panel-title">&#9654; Queue</div>
        <div id="dash-queue"></div>
      </div>

      <!-- Top Artists -->
      <div class="panel">
        <div class="panel-title">&#127911; Top Artists</div>
        <div id="top-artists"></div>
      </div>

      <!-- Listening Log -->
      <div class="panel full-width">
        <div class="panel-title">&#128210; Listening Log</div>
        <div id="listen-log" class="log-list"></div>
      </div>

    </div>

    <!-- Share Card Preview -->
    <div id="share-preview" class="share-preview">
      <canvas id="share-canvas" width="600" height="340"></canvas>
      <div style="margin-top:8px;display:flex;gap:8px;justify-content:center;">
        <button id="share-copy" class="dash-btn">Copy to clipboard</button>
        <button id="share-download" class="dash-btn">Download PNG</button>
      </div>
    </div>

  </div>

  <script src="dashboard.js" type="module"></script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add shardtune/dashboard/dashboard.html
git commit -m "feat: add dashboard HTML with grid layout, all panels, chart canvas"
```

---

### Task 11: Dashboard JS

**Files:**
- Create: `shardtune/dashboard/dashboard.js`

- [ ] **Step 1: Write dashboard.js**

```js
const port = chrome.runtime.connect({ name: 'dashboard' });

const $ = id => document.getElementById(id);

let currentState = null;
let analyticsData = null;
let energyChart = null;

// --- Init ---

port.postMessage({ action: 'get-queue' });
port.postMessage({ action: 'get-devices' });
port.postMessage({ action: 'get-analytics' });

// --- Message Handling ---

port.onMessage.addListener(msg => {
  switch (msg.type) {
    case 'state':
      currentState = msg.data;
      renderHero(msg.data);
      break;
    case 'analytics':
      analyticsData = msg.data;
      renderStats(msg.data);
      renderEnergyChart(msg.data.session?.energyHistory);
      renderTopArtists(msg.data.session?.artists);
      renderLog(msg.data.session?.history);
      if (msg.data.peakHours) renderHeatmap(msg.data.peakHours);
      break;
    case 'queue':
      renderQueue(msg.data);
      break;
    case 'devices':
      renderDevices(msg.data);
      break;
    case 'auth-required':
      $('dash-auth').classList.remove('hidden');
      $('dash-main').classList.add('hidden');
      break;
  }
});

// --- Hero ---

function renderHero(state) {
  if (!state?.item) {
    $('hero-track').textContent = 'Not playing';
    $('hero-artist').textContent = 'Open Spotify on a device';
    return;
  }

  $('dash-auth')?.classList.add('hidden');
  $('dash-main')?.classList.remove('hidden');

  const track = state.item;
  $('hero-track').textContent = track.name || 'Unknown';
  $('hero-artist').textContent = track.artists?.map(a => a.name).join(', ') || '';

  const img = $('hero-art-img');
  const artUrl = track.album?.images?.[0]?.url;
  if (artUrl) {
    img.src = artUrl;
    img.style.display = 'block';
  }
}

function renderStats(data) {
  if (!data) return;
  const { session, streak } = data;
  if (session) {
    $('h-stat-min').textContent = Math.round(session.totalListenMs / 60000);
    $('h-stat-skips').textContent = session.skips;
    $('h-stat-artists').textContent = session.artistCount;
  }
  if (streak) {
    $('h-stat-streak').textContent = `${streak.count}d`;
  }
}

// --- Energy Chart ---

function renderEnergyChart(energyHistory) {
  if (!energyHistory || energyHistory.length === 0) return;

  const ctx = $('energy-chart').getContext('2d');
  const labels = energyHistory.map(e => e.label);
  const values = energyHistory.map(e => e.value);

  if (energyChart) {
    energyChart.data.labels = labels;
    energyChart.data.datasets[0].data = values;
    energyChart.update();
    return;
  }

  energyChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: '#1db954',
        backgroundColor: 'rgba(29,185,84,0.1)',
        fill: true,
        tension: 0.3,
        pointBackgroundColor: '#1db954',
        pointRadius: 4,
        pointHoverRadius: 6,
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#111820',
          borderColor: 'rgba(29,185,84,0.3)',
          borderWidth: 1,
          titleFont: { family: 'JetBrains Mono', size: 11 },
          bodyFont: { family: 'JetBrains Mono', size: 11 },
          titleColor: '#f1f5f9',
          bodyColor: '#1db954',
          displayColors: false,
          callbacks: {
            label: ctx => `Energy: ${ctx.raw}`
          }
        }
      },
      scales: {
        x: {
          ticks: { color: '#4a5568', font: { family: 'JetBrains Mono', size: 9 }, maxRotation: 45 },
          grid: { color: 'rgba(255,255,255,0.04)' }
        },
        y: {
          min: 0, max: 100,
          ticks: { color: '#4a5568', font: { family: 'JetBrains Mono', size: 9 } },
          grid: { color: 'rgba(255,255,255,0.04)' }
        }
      }
    }
  });
}

// --- Peak Hours Heatmap ---

function renderHeatmap(hours) {
  const container = $('heatmap');
  if (!hours) return;

  const max = Math.max(...hours, 1);
  container.innerHTML = hours.map((val, i) => {
    const pct = (val / max) * 100;
    const label = String(i).padStart(2, '0');
    return `
      <div class="heatmap-col">
        <div class="heatmap-bar">
          <div class="heatmap-fill" style="height:${pct}%;opacity:${0.3 + (pct/100)*0.7}"></div>
        </div>
        <span class="heatmap-label">${label}</span>
      </div>`;
  }).join('');
}

// --- Devices ---

function renderDevices(data) {
  const container = $('device-list');
  if (!data?.devices?.length) {
    container.innerHTML = '<div class="empty-panel">No devices found</div>';
    return;
  }

  container.innerHTML = data.devices.map(d => `
    <div class="device-row ${d.is_active ? 'active' : ''}">
      <div class="device-info">
        <div class="device-info-name">${esc(d.name)}</div>
        <div class="device-info-type">${esc(d.type)}${d.is_active ? ' · Active' : ''}</div>
      </div>
      ${d.is_active ? '' : `<button class="transfer-btn" data-id="${d.id}">Transfer</button>`}
    </div>`).join('');

  container.querySelectorAll('.transfer-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      port.postMessage({ action: 'transfer', deviceId: btn.dataset.id });
      setTimeout(() => port.postMessage({ action: 'get-devices' }), 1000);
    });
  });
}

// --- Queue ---

function renderQueue(data) {
  const container = $('dash-queue');
  if (!data?.queue?.length) {
    container.innerHTML = '<div class="empty-panel">Queue empty</div>';
    return;
  }

  container.innerHTML = data.queue.slice(0, 6).map((t, i) => {
    const art = t.album?.images?.[2]?.url || '';
    return `
      <div class="dash-q-item">
        <span class="dash-q-idx">${String(i + 1).padStart(2, '0')}</span>
        <div class="dash-q-art">${art ? `<img src="${art}" alt="">` : ''}</div>
        <div class="dash-q-info">
          <div class="dash-q-name">${esc(t.name || '')}</div>
          <div class="dash-q-artist">${esc(t.artists?.map(a => a.name).join(', ') || '')}</div>
        </div>
        <span class="dash-q-dur">${fmt(t.duration_ms)}</span>
      </div>`;
  }).join('');
}

// --- Top Artists ---

function renderTopArtists(artists) {
  const container = $('top-artists');
  if (!artists?.length) {
    container.innerHTML = '<div class="empty-panel">No data yet</div>';
    return;
  }

  const counts = {};
  if (analyticsData?.session?.history) {
    for (const t of analyticsData.session.history) {
      const a = t.artist;
      counts[a] = (counts[a] || 0) + 1;
    }
  }

  const sorted = artists
    .map(a => ({ name: a, count: counts[a] || 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  container.innerHTML = sorted.map((a, i) => `
    <div class="artist-row">
      <span class="artist-rank">#${i + 1}</span>
      <span class="artist-name">${esc(a.name)}</span>
      <span class="artist-count">${a.count} track${a.count !== 1 ? 's' : ''}</span>
    </div>`).join('');
}

// --- Listening Log ---

function renderLog(history) {
  const container = $('listen-log');
  if (!history?.length) {
    container.innerHTML = '<div class="empty-panel">No tracks yet this session</div>';
    return;
  }

  container.innerHTML = [...history].reverse().map(t => {
    const time = new Date(t.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `
      <div class="log-item">
        <span class="log-time">${time}</span>
        <span class="log-track">${esc(t.name)}</span>
        <span class="log-artist">${esc(t.artist)}</span>
        ${t.skipped ? '<span class="log-skipped">SKIP</span>' : ''}
      </div>`;
  }).join('');
}

// --- Share Card ---

$('share-btn').addEventListener('click', () => {
  renderShareCard();
  $('share-preview').classList.toggle('active');
});

function renderShareCard() {
  const canvas = $('share-canvas');
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  ctx.fillStyle = '#0b0e11';
  ctx.fillRect(0, 0, 600, 340);

  ctx.strokeStyle = 'rgba(29,185,84,0.2)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, 598, 338);

  ctx.fillStyle = '#1db954';
  ctx.fillRect(20, 20, 6, 20);
  ctx.fillRect(30, 15, 6, 30);
  ctx.fillRect(40, 22, 6, 16);
  ctx.globalAlpha = 0.4;
  ctx.fillRect(50, 26, 4, 8);
  ctx.globalAlpha = 1;

  ctx.font = '12px "Press Start 2P"';
  ctx.fillStyle = '#1db954';
  ctx.fillText('SHARDTUNE', 62, 37);

  const track = currentState?.item;
  if (track) {
    ctx.font = 'bold 22px Inter';
    ctx.fillStyle = '#f1f5f9';
    ctx.fillText(truncate(track.name || 'Unknown', 30), 20, 90);

    ctx.font = '14px Inter';
    ctx.fillStyle = '#7a8a98';
    ctx.fillText(track.artists?.map(a => a.name).join(', ') || '', 20, 115);

    ctx.font = '12px Inter';
    ctx.fillStyle = '#4a5568';
    ctx.fillText(track.album?.name || '', 20, 138);
  }

  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(20, 160, 560, 1);

  if (analyticsData?.session) {
    const s = analyticsData.session;
    const stats = [
      { label: 'MINUTES', val: Math.round(s.totalListenMs / 60000) },
      { label: 'SKIPS', val: s.skips },
      { label: 'ARTISTS', val: s.artistCount }
    ];

    stats.forEach((stat, i) => {
      const x = 20 + i * 190;
      ctx.font = 'bold 28px "JetBrains Mono"';
      ctx.fillStyle = '#f1f5f9';
      ctx.fillText(String(stat.val), x, 210);

      ctx.font = '8px "Press Start 2P"';
      ctx.fillStyle = '#4a5568';
      ctx.fillText(stat.label, x, 228);
    });
  }

  if (analyticsData?.streak) {
    ctx.font = 'bold 28px "JetBrains Mono"';
    ctx.fillStyle = '#f59e0b';
    ctx.fillText(`${analyticsData.streak.count}d`, 20, 290);

    ctx.font = '8px "Press Start 2P"';
    ctx.fillStyle = '#92400e';
    ctx.fillText('STREAK', 20, 308);
  }

  ctx.font = '10px "JetBrains Mono"';
  ctx.fillStyle = '#2a3a46';
  ctx.fillText('shardtune · shard ecosystem', 400, 320);

  if (track?.album?.images?.[0]?.url) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 460, 60, 120, 120);
      ctx.strokeStyle = 'rgba(29,185,84,0.15)';
      ctx.strokeRect(460, 60, 120, 120);
    };
    img.src = track.album.images[0].url;
  }
}

$('share-copy').addEventListener('click', async () => {
  try {
    const canvas = $('share-canvas');
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    $('share-copy').textContent = 'Copied!';
    setTimeout(() => { $('share-copy').textContent = 'Copy to clipboard'; }, 2000);
  } catch {
    $('share-copy').textContent = 'Failed';
  }
});

$('share-download').addEventListener('click', () => {
  const link = document.createElement('a');
  link.download = 'shardtune-now-playing.png';
  link.href = $('share-canvas').toDataURL('image/png');
  link.click();
});

// --- Export ---

$('export-json-btn').addEventListener('click', () => {
  if (!analyticsData) return;
  const blob = new Blob([JSON.stringify(analyticsData, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.download = `shardtune-session-${new Date().toISOString().split('T')[0]}.json`;
  link.href = URL.createObjectURL(blob);
  link.click();
  URL.revokeObjectURL(link.href);
});

$('export-png-btn').addEventListener('click', () => {
  renderShareCard();
  setTimeout(() => {
    const link = document.createElement('a');
    link.download = `shardtune-stats-${new Date().toISOString().split('T')[0]}.png`;
    link.href = $('share-canvas').toDataURL('image/png');
    link.click();
  }, 500);
});

// --- Helpers ---

function fmt(ms) {
  const s = Math.floor((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function truncate(str, max) {
  return str.length > max ? str.substring(0, max - 1) + '…' : str;
}
```

- [ ] **Step 2: Verify dashboard loads**

Reload extension. Open the popup, click the dashboard icon. A new tab should open with the ShardTune dashboard. The grid layout should render — panels visible but showing "No data yet" / "Loading..." states. Chart.js should load from CDN. Check the browser console for any errors.

- [ ] **Step 3: Commit**

```bash
git add shardtune/dashboard/dashboard.js
git commit -m "feat: add dashboard JS with chart, heatmap, share card, export, device management"
```

---

### Task 12: Logo SVG + Icon Placeholders

**Files:**
- Create: `shardtune/icons/logo.svg`
- Create: `shardtune/icons/icon-16.png` (placeholder)
- Create: `shardtune/icons/icon-48.png` (placeholder)
- Create: `shardtune/icons/icon-128.png` (placeholder)

- [ ] **Step 1: Write logo.svg**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
  <rect width="128" height="128" fill="#0b0e11"/>
  <rect x="16" y="36" width="20" height="56" fill="#1db954"/>
  <rect x="44" y="20" width="20" height="88" fill="#1db954"/>
  <rect x="72" y="44" width="20" height="40" fill="#1db954"/>
  <rect x="100" y="52" width="14" height="24" fill="#1db954" opacity="0.4"/>
</svg>
```

- [ ] **Step 2: Generate PNG icons from SVG**

Run these commands to generate the icon PNGs. If `rsvg-convert` or `convert` isn't available, open the SVG in a browser and screenshot at each size, or use an online SVG-to-PNG converter.

```bash
# Option A: using rsvg-convert (librsvg)
rsvg-convert -w 16 -h 16 shardtune/icons/logo.svg > shardtune/icons/icon-16.png
rsvg-convert -w 48 -h 48 shardtune/icons/logo.svg > shardtune/icons/icon-48.png
rsvg-convert -w 128 -h 128 shardtune/icons/logo.svg > shardtune/icons/icon-128.png

# Option B: using ImageMagick
convert -background none -resize 16x16 shardtune/icons/logo.svg shardtune/icons/icon-16.png
convert -background none -resize 48x48 shardtune/icons/logo.svg shardtune/icons/icon-48.png
convert -background none -resize 128x128 shardtune/icons/logo.svg shardtune/icons/icon-128.png
```

If neither tool is available, create minimal 1x1 placeholder PNGs so the extension loads without icon errors. Replace them later with proper exports.

- [ ] **Step 3: Verify extension loads with icons**

Reload extension. The ShardTune icon should appear in the toolbar. Check `chrome://extensions` — no icon-related warnings.

- [ ] **Step 4: Commit**

```bash
git add shardtune/icons/
git commit -m "feat: add pixel bar logo SVG and icon PNGs"
```

---

### Task 13: Integration Verification

This task has no new files — it's an end-to-end check.

- [ ] **Step 1: Load and inspect extension**

1. Go to `chrome://extensions`
2. Remove any old ShardTune version
3. Click "Load unpacked" → select the `shardtune/` folder
4. Verify: no errors, icon visible, service worker registered

- [ ] **Step 2: Test auth flow**

1. Open `shardtune/utils/spotify.js`
2. Replace `YOUR_CLIENT_ID_HERE` with a real Spotify Client ID
3. In Spotify Developer Dashboard, add redirect URI: `https://<extension-id>.chromiumapp.org/` (get extension ID from chrome://extensions)
4. Click extension icon → "Connect Spotify" → complete Spotify auth
5. Verify: popup shows player screen after auth

- [ ] **Step 3: Test popup controls**

1. Play something on Spotify
2. Verify: track name, artist, album art appear
3. Click play/pause, next, prev — verify they work
4. Drag the seek bar — verify position updates
5. Adjust volume slider — verify Spotify volume changes
6. Toggle shuffle / repeat — verify states toggle
7. Click copy link — verify URL lands on clipboard
8. Open sleep timer → pick 15 min → verify badge shows countdown
9. Click album art → verify device picker opens
10. Click dashboard icon → verify dashboard opens in new tab

- [ ] **Step 4: Test keyboard shortcuts**

1. While on any page, press `Alt+Shift+P` → verify play/pause toggles
2. Press `Alt+Shift+Right` → verify next track
3. Press `Alt+Shift+Left` → verify previous track

- [ ] **Step 5: Test dashboard**

1. On dashboard, verify: now-playing hero, stats, energy chart, queue, devices
2. Wait for a few track changes → verify energy chart updates, listening log populates
3. Check peak hours heatmap renders
4. Click "Share Card" → verify canvas renders with track info
5. Click "Copy to clipboard" on share card → paste in an image editor, verify PNG
6. Click "Export JSON" → verify JSON file downloads with session data
7. Click "Export PNG" → verify PNG file downloads
8. Click "Transfer" on a non-active device → verify playback transfers

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: ShardTune v1.0.0 — complete Spotify desk controller extension"
```
