import * as storage from './storage.js';

const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-recently-played',
  'user-top-read'
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

async function getClientId() {
  const id = await storage.get('client_id');
  if (!id) throw new Error('Client ID not configured');
  return id;
}

export async function setClientId(id) {
  await storage.set('client_id', id);
}

export async function hasClientId() {
  const id = await storage.get('client_id');
  return !!id;
}

const REDIRECT_URI = 'http://127.0.0.1:43827/spotify/callback';

export function getRedirectURL() {
  return REDIRECT_URI;
}

export async function authenticate() {
  const clientId = await getClientId();
  const redirectUrl = getRedirectURL();

  const codeVerifier = generateRandom(64);
  const codeChallenge = await sha256(codeVerifier);
  const state = generateRandom(16);

  await storage.set('pkce_verifier', codeVerifier);
  await storage.set('pkce_state', state);

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUrl,
    scope: SCOPES,
    state,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge
  });

  const authUrl = `${AUTH_ENDPOINT}?${params}`;

  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url: authUrl }, tab => {
      const tabId = tab.id;

      function onUpdated(updatedTabId, changeInfo) {
        if (updatedTabId !== tabId || !changeInfo.url) return;
        // Exact origin + path match (query carries the code) — prefix matching
        // would also accept e.g. /spotify/callback.evil.
        let u, r;
        try { u = new URL(changeInfo.url); r = new URL(redirectUrl); } catch { return; }
        if (u.origin !== r.origin || u.pathname !== r.pathname) return;

        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
        chrome.tabs.remove(tabId).catch(() => {});

        handleRedirect(changeInfo.url, state, codeVerifier, clientId, redirectUrl)
          .then(resolve)
          .catch(reject);
      }

      function onRemoved(removedTabId) {
        if (removedTabId !== tabId) return;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
        reject(new Error('Auth cancelled — tab was closed'));
      }

      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.onRemoved.addListener(onRemoved);
    });
  });
}

async function handleRedirect(responseUrl, expectedState, codeVerifier, clientId, redirectUrl) {
  const url = new URL(responseUrl);
  const error = url.searchParams.get('error');
  if (error) {
    throw new Error(`Spotify denied: ${error}`);
  }

  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');

  if (returnedState !== expectedState) {
    throw new Error('State mismatch');
  }

  const tokenResponse = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUrl,
      code_verifier: codeVerifier
    })
  });

  if (!tokenResponse.ok) {
    const body = await tokenResponse.text();
    throw new Error(`Token exchange failed: ${tokenResponse.status} — ${body}`);
  }

  const tokens = await tokenResponse.json();
  await saveTokens(tokens);

  await storage.remove('pkce_verifier');
  await storage.remove('pkce_state');

  return tokens.access_token;
}

async function saveTokens(tokens) {
  await storage.set('access_token', tokens.access_token);
  await storage.set('refresh_token', tokens.refresh_token);
  await storage.set('expires_at', Date.now() + tokens.expires_in * 1000);
}

let refreshPromise = null;

export async function refreshAccessToken() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = doRefresh();
  try { return await refreshPromise; }
  finally { refreshPromise = null; }
}

async function doRefresh() {
  const clientId = await getClientId();
  const refreshToken = await storage.get('refresh_token');
  if (!refreshToken) throw new Error('No refresh token');

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    })
  });

  if (!response.ok) {
    await storage.remove('access_token');
    await storage.remove('refresh_token');
    await storage.remove('expires_at');
    throw new Error('Refresh failed');
  }

  const tokens = await response.json();
  await saveTokens({
    ...tokens,
    refresh_token: tokens.refresh_token || refreshToken
  });
  return tokens.access_token;
}

export async function getValidToken() {
  const { expires_at: expiresAt, access_token: accessToken } = await storage.getAll(['expires_at', 'access_token']);

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

  let response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...options.headers
    }
  });

  if (response.status === 401) {
    // A 401 means the token is bad. Try one refresh; if that throws (revoked
    // grant) or the retry is still 401, surface it as an auth failure so the
    // poll loop re-prompts, rather than a generic "API error".
    let newToken;
    try {
      newToken = await refreshAccessToken();
    } catch {
      throw new Error('Not authenticated');
    }
    response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${newToken}`,
        ...options.headers
      }
    });
    if (response.status === 401) throw new Error('Not authenticated');
  }

  if (response.status === 429) {
    const ra = parseInt(response.headers.get('Retry-After') || '5', 10);
    const err = new Error('Rate limited');
    err.retryAfterMs = (Number.isNaN(ra) ? 5 : ra) * 1000;
    throw err;
  }

  if (!response.ok && response.status !== 204) {
    throw new Error(`API error: ${response.status}`);
  }

  return response.status === 204 ? null : response.json();
}

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

export function transferPlayback(deviceId, shouldPlay = true) {
  return apiFetch('/me/player', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_ids: [deviceId], play: shouldPlay })
  });
}

export function getUserProfile() {
  return apiFetch('/me');
}

export function getRecentlyPlayed(limit = 50) {
  return apiFetch(`/me/player/recently-played?limit=${limit}`);
}

export function getTopArtists(timeRange = 'short_term', limit = 10) {
  return apiFetch(`/me/top/artists?time_range=${timeRange}&limit=${limit}`);
}

export function getTopTracks(timeRange = 'short_term', limit = 10) {
  return apiFetch(`/me/top/tracks?time_range=${timeRange}&limit=${limit}`);
}

export function getAudioFeatures(ids) {
  return apiFetch(`/audio-features?ids=${ids.slice(0, 100).join(',')}`);
}

export async function checkSavedTracks(ids) {
  return apiFetch(`/me/tracks/contains?ids=${ids.slice(0, 50).join(',')}`);
}

export async function getTracks(ids) {
  if (!ids.length) return { tracks: [] };
  return apiFetch(`/tracks?ids=${ids.slice(0, 50).join(',')}`);
}
