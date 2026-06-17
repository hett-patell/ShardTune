import * as spotify from './utils/spotify.js';
import * as analytics from './utils/analytics.js';
import * as storage from './utils/storage.js';
import * as buddylist from './utils/buddylist.js';
import * as notifs from './utils/notifications.js';
import { checkForUpdates, getUpdateInfo } from './utils/update.js';

const POLL_FAST = 5000;
const POLL_SLOW_MINUTES = 1;
const ALARM_POLL = 'shardtune-poll';
const ALARM_SLEEP = 'shardtune-sleep';

let ports = new Set();
let pollInterval = null;
let lastState = null;
let lastPlaylists = null; // cached playlists for new connections
let lastHistory = null;   // cached history for new connections
let lastHistoryTime = 0;  // timestamp of last history fetch
let friendsCache = null;  // cached friend data
let friendsCacheTime = 0; // timestamp of last friend fetch
let lastStreakCount = -1; // last known streak count
let pausedTicks = 0;      // consecutive ticks with no playback
let isAuthenticated = false;
let polling = null;       // single-flight guard for poll()
let pollTimer = null;     // debounce timer for post-command refresh
let rateLimitedUntil = 0; // timestamp until which we should skip polling
let jamActive = false;
let jamRole = null;
let jamSyncing = false;
let creatingOffscreen = null;

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('offscreen/jam.html')]
  });
  if (existingContexts.length > 0) return;
  if (creatingOffscreen) { await creatingOffscreen; return; }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'offscreen/jam.html',
    reasons: [chrome.offscreen.Reason.WEB_RTC],
    justification: 'WebRTC peer connections for real-time listening sessions'
  });
  await creatingOffscreen;
  creatingOffscreen = null;
}

async function closeOffscreenDocument() {
  try {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL('offscreen/jam.html')]
    });
    if (existingContexts.length > 0) await chrome.offscreen.closeDocument();
  } catch {}
  jamActive = false;
  jamRole = null;
  jamSyncing = false;
}

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
  // The slow alarm is left running as a durable fallback that survives
  // service-worker eviction; single-flight poll() collapses any overlap.

  if (isAuthenticated) {
    port.postMessage({ type: 'auth-success' });
    if (lastState) {
      port.postMessage({ type: 'state', data: lastState });
    }
    if (lastPlaylists) {
      port.postMessage({ type: 'playlists', data: lastPlaylists });
    }
    if (lastHistory) {
      port.postMessage({ type: 'history', data: lastHistory });
    }
  }

  if (jamActive) {
    chrome.runtime.sendMessage({ action: 'jam-get-state' }).then(state => {
      port.postMessage({ type: 'jam-state', data: state });
    }).catch(() => {});
  }

  port.onMessage.addListener(msg => handlePortMessage(msg, port));
});

function broadcast(message) {
  for (const port of ports) {
    try { port.postMessage(message); } catch (e) { console.warn('[ShardTune BG] broadcast send failed:', e.message); }
  }
}

// --- Jam: messages from offscreen document ---

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!sender.url?.includes('offscreen/jam.html')) return;

  switch (msg.action) {
    case 'jam-request-state':
      if (jamRole === 'host' && lastState) {
        chrome.runtime.sendMessage({ action: 'jam-broadcast-state', data: lastState }).catch(() => {});
      }
      break;
    case 'jam-request-queue':
      if (jamRole === 'host') {
        spotify.getQueue().then(q => {
          chrome.runtime.sendMessage({ action: 'jam-broadcast-queue', data: q }).catch(() => {});
        }).catch(() => {});
      }
      break;
    case 'jam-sync-state':
      if (!jamActive || jamRole !== 'guest' || !msg.data) break;
      jamSyncing = true;
      (async () => {
        try {
          const hostUri = msg.data.trackUri;
          const localUri = lastState?.item?.uri;
          if (hostUri && hostUri !== localUri) {
            await spotify.play(undefined, [hostUri]).catch(() => {});
            if (msg.data.positionMs > 1000) {
              await new Promise(r => setTimeout(r, 400));
              await spotify.seek(msg.data.positionMs).catch(() => {});
            }
          } else {
            if (msg.data.isPlaying && !lastState?.is_playing) {
              await spotify.play().catch(() => {});
            } else if (!msg.data.isPlaying && lastState?.is_playing) {
              await spotify.pause().catch(() => {});
            }
            const drift = Math.abs((lastState?.progress_ms || 0) - (msg.data.positionMs || 0));
            if (drift > 3000 && msg.data.isPlaying) {
              await spotify.seek(msg.data.positionMs).catch(() => {});
            }
          }
          schedulePoll(500);
        } finally {
          jamSyncing = false;
        }
      })();
      break;
    case 'jam-sync-action':
      if (!jamActive || jamRole !== 'guest') break;
      jamSyncing = true;
      (async () => {
        try {
          switch (msg.data?.action) {
            case 'play':
              if (msg.data.trackUri) await spotify.play(undefined, [msg.data.trackUri]).catch(() => {});
              else if (msg.data.uris) await spotify.play(undefined, msg.data.uris, msg.data.contextUri).catch(() => {});
              else await spotify.play().catch(() => {});
              break;
            case 'pause': await spotify.pause().catch(() => {}); break;
            case 'seek': await spotify.seek(msg.data.positionMs).catch(() => {}); break;
          }
          schedulePoll(500);
        } finally {
          jamSyncing = false;
        }
      })();
      break;
    case 'jam-queue-request':
      if (msg.data?.uri) spotify.addToQueue(msg.data.uri).catch(() => {});
      break;
    case 'jam-queue-sync':
      broadcast({ type: 'jam-queue-sync', data: msg.data });
      break;
    case 'jam-peers-updated':
      broadcast({ type: 'jam-peers', data: msg.data });
      break;
    case 'jam-peer-connected':
      broadcast({ type: 'jam-peer-joined', data: { name: msg.name || msg.peerId } });
      break;
    case 'jam-peer-disconnected':
      broadcast({ type: 'jam-peer-left', data: { name: msg.name || msg.peerId } });
      break;
    case 'jam-reconnecting':
      broadcast({ type: 'jam-reconnecting', data: { attempt: msg.attempt, maxAttempts: msg.maxAttempts } });
      break;
    case 'jam-session-ended':
      jamActive = false;
      jamRole = null;
      closeOffscreenDocument();
      broadcast({ type: 'jam-ended', data: { reason: msg.data?.reason || 'Host ended the session' } });
      break;
    case 'jam-error':
      broadcast({ type: 'jam-error', data: msg.data });
      break;
    case 'jam-ended':
      jamActive = false;
      jamRole = null;
      closeOffscreenDocument();
      broadcast({ type: 'jam-ended' });
      break;
  }
});

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

// Single-flight: overlapping triggers (5s interval, 60s alarm, post-command
// refresh) share one in-flight poll instead of stacking concurrent requests
// that double-count listen time and risk 429s.
function poll() {
  if (polling) return polling;
  polling = doPoll().finally(() => { polling = null; });
  return polling;
}

// Debounced refresh after a transport command — coalesces bursts (e.g. a
// volume drag) into a single trailing poll.
function schedulePoll(delay = 400) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => { pollTimer = null; poll(); }, delay);
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_POLL) {
    poll();
  }
  if (alarm.name === ALARM_SLEEP) {
    spotify.pause().catch(e => console.warn('[ShardTune BG] Sleep pause failed:', e.message));
    broadcast({ type: 'sleep-fired' });
    storage.remove('sleepTimer');
  }
  if (alarm.name === 'shardtune-rate-limit') {
    rateLimitedUntil = 0;
    if (ports.size > 0) startFastPolling();
    startSlowPolling();
  }
});

async function doPoll() {
  if (Date.now() < rateLimitedUntil) return;
  try {
    const token = await spotify.getValidToken();
    if (!token) {
      isAuthenticated = false;
      broadcast({ type: 'auth-required' });
      return;
    }

    // Announce auth on the false→true transition. A cold service worker spawns
    // with isAuthenticated=false, so onConnect can't tell the popup it's logged
    // in — without this, the first popup after a browser start stays stuck on
    // "Connect Spotify" until the next open.
    const wasAuthenticated = isAuthenticated;
    isAuthenticated = true;
    if (!wasAuthenticated) broadcast({ type: 'auth-success' });

    const state = await spotify.getPlayerState();
    lastState = state;

    if (state) {
      const { trackChanged } = analytics.processPlayerState(state);

      if (state.is_playing) {
        // Streak is idempotent per day — safe to call each tick while playing.
        await analytics.updateStreak();
        // Peak hours / music memory count "plays" — increment once per track,
        // not per poll tick, so they don't skew with poll frequency.
        if (trackChanged && state.item) {
          analytics.updateTrackAnalytics(analytics.energyProxy(state.item)).catch(() => {});
        }
      }

      if (trackChanged && state.item) {
        notifs.onTrackChange(state.item).catch(() => {});
      }
    }

    const session = analytics.getSession();

    if (state) {
      notifs.onPollTick(state.is_playing, session.totalListenMs).catch(() => {});
    }

    if (!state || !state.item) {
      const devData = await spotify.getDevices().catch(() => null);
      const devices = devData?.devices?.filter(d => !d.is_restricted) || [];
      broadcast({ type: 'devices', data: devData });
      broadcast({ type: 'state', data: state, devices });
    } else {
      broadcast({ type: 'state', data: state });
    }

    const streak = await analytics.getStreak();
    broadcast({ type: 'analytics', data: { session, streak } });

    // Auto-downshift to slow polling when paused or no device active
    if (!state || !state.is_playing) {
      pausedTicks++;
      if (pausedTicks > 6) { // ~30 seconds idle
        stopFastPolling();
        startSlowPolling();
      }
    } else {
      pausedTicks = 0;
    }
  } catch (err) {
    if (err.message?.includes('Not authenticated')) {
      console.warn('[ShardTune BG] Not authenticated');
      isAuthenticated = false;
      broadcast({ type: 'auth-required' });
    } else if (err.retryAfterMs) {
      // Rate limited — pause both fast and slow polling until the cooldown
      // expires so we don't keep hammering a cooling-down endpoint.
      console.warn('[ShardTune BG] Rate limited! Pausing for', err.retryAfterMs, 'ms');
      broadcast({ type: 'error', data: `Rate limited. Retry after ${Math.round(err.retryAfterMs/1000)}s` });
      stopFastPolling();
      chrome.alarms.clear(ALARM_POLL);
      rateLimitedUntil = Date.now() + err.retryAfterMs;
      // Use alarm instead of setTimeout (setTimeout dies with SW eviction)
      chrome.alarms.create('shardtune-rate-limit', { delayInMinutes: Math.max(err.retryAfterMs / 60000, 0.1) });
    } else {
      console.warn('[ShardTune BG] Poll error:', err.message);
    }
  }
}

// --- Cached Friend Fetch ---

const FRIENDS_CACHE_TTL = 30000; // 30 seconds

async function getFriendsCached() {
  if (friendsCache && Date.now() - friendsCacheTime < FRIENDS_CACHE_TTL) {
    return friendsCache;
  }
  friendsCache = await buddylist.getFriendActivity();
  friendsCacheTime = Date.now();
  return friendsCache;
}

// --- Port Message Handling ---

async function handlePortMessage(msg, port) {
  // Skip all API requests if rate limited (except non-API actions)
  if (spotify.isRateLimited() && !['check-client-id', 'set-client-id', 'get-analytics', 'get-notif-settings', 'set-notif-settings', 'clear-analytics', 'logout'].includes(msg.action)) {
    const remaining = spotify.getRateLimitRemaining();
    port.postMessage({ type: 'error', data: `Rate limited. Retry in ${Math.round(remaining / 60000)} minutes` });
    return;
  }

  try {
    switch (msg.action) {
      case 'check-client-id': {
        const has = await spotify.hasClientId();
        port.postMessage({ type: 'client-id-status', data: has });
        break;
      }
      case 'set-client-id': {
        await spotify.setClientId(msg.clientId);
        port.postMessage({ type: 'client-id-saved' });
        break;
      }
      case 'authenticate': {
        try {
          await spotify.authenticate();
          isAuthenticated = true;
          broadcast({ type: 'auth-success' });
          await poll();
        } catch (err) {
          const message = err.message || 'Authentication failed';
          const isCancel = message.includes('canceled') ||
                           message.includes('cancelled') ||
                           message.includes('user closed') ||
                           message.includes('The user did not approve');
          port.postMessage({
            type: 'auth-error',
            data: isCancel ? 'Auth cancelled' : message
          });
        }
        break;
      }
      case 'play':
        if (jamRole === 'guest' && !jamSyncing) break;
        await spotify.play(msg.deviceId, msg.uris, msg.contextUri, msg.offset);
        schedulePoll(300);
        if (jamRole === 'host') {
          chrome.runtime.sendMessage({ action: 'jam-broadcast-action', data: { action: 'play', uris: msg.uris, contextUri: msg.contextUri } }).catch(() => {});
        }
        break;
      case 'pause':
        if (jamRole === 'guest' && !jamSyncing) break;
        await spotify.pause();
        schedulePoll(300);
        if (jamRole === 'host') chrome.runtime.sendMessage({ action: 'jam-broadcast-action', data: { action: 'pause' } }).catch(() => {});
        break;
      case 'next':
        if (jamRole === 'guest') break;
        await spotify.next();
        schedulePoll(500);
        if (jamRole === 'host') {
          setTimeout(async () => {
            const state = await spotify.getPlaybackState().catch(() => null);
            if (state?.item?.uri) {
              chrome.runtime.sendMessage({ action: 'jam-broadcast-action', data: { action: 'play', trackUri: state.item.uri } }).catch(() => {});
              chrome.runtime.sendMessage({ action: 'jam-broadcast-state', data: state }).catch(() => {});
            }
            const q = await spotify.getQueue().catch(() => null);
            if (q) chrome.runtime.sendMessage({ action: 'jam-broadcast-queue', data: q }).catch(() => {});
          }, 600);
        }
        break;
      case 'previous':
        if (jamRole === 'guest') break;
        await spotify.previous();
        schedulePoll(500);
        if (jamRole === 'host') {
          setTimeout(async () => {
            const state = await spotify.getPlaybackState().catch(() => null);
            if (state?.item?.uri) {
              chrome.runtime.sendMessage({ action: 'jam-broadcast-action', data: { action: 'play', trackUri: state.item.uri } }).catch(() => {});
              chrome.runtime.sendMessage({ action: 'jam-broadcast-state', data: state }).catch(() => {});
            }
            const q = await spotify.getQueue().catch(() => null);
            if (q) chrome.runtime.sendMessage({ action: 'jam-broadcast-queue', data: q }).catch(() => {});
          }, 600);
        }
        break;
      case 'seek':
        if (jamRole === 'guest' && !jamSyncing) break;
        await spotify.seek(msg.positionMs);
        schedulePoll(300);
        if (jamRole === 'host') chrome.runtime.sendMessage({ action: 'jam-broadcast-action', data: { action: 'seek', positionMs: msg.positionMs } }).catch(() => {});
        break;
      case 'volume':
        await spotify.setVolume(msg.percent);
        schedulePoll(300);
        break;
      case 'shuffle':
        if (jamRole === 'guest') break;
        await spotify.setShuffle(msg.state);
        schedulePoll(300);
        break;
      case 'repeat':
        if (jamRole === 'guest') break;
        await spotify.setRepeat(msg.mode);
        schedulePoll(300);
        break;
      case 'transfer':
        await spotify.transferPlayback(msg.deviceId);
        schedulePoll(500);
        break;
      case 'get-devices': {
        const devices = await spotify.getDevices();
        broadcast({ type: 'devices', data: devices });
        break;
      }
      case 'get-queue': {
        const queue = await spotify.getQueue();
        broadcast({ type: 'queue', data: queue });
        break;
      }
      case 'get-profile': {
        const profile = await spotify.getUserProfile();
        broadcast({ type: 'profile', data: profile });
        break;
      }
      case 'get-analytics': {
        const session = analytics.getSession();
        const streak = await analytics.getStreak();
        const peakHours = await analytics.getPeakHours();
        broadcast({ type: 'analytics', data: { session, streak, peakHours } });
        break;
      }
      case 'get-history': {
        // Use cache if available and fresh (5 minutes)
        if (lastHistory && Date.now() - lastHistoryTime < 300000) {
          broadcast({ type: 'history', data: lastHistory });
          break;
        }
        const errors = [];
        const [recent, topArtists, topTracks] = await Promise.all([
          spotify.getRecentlyPlayed(50).catch(e => { errors.push(`recently-played: ${e.message}`); return null; }),
          spotify.getTopArtists('short_term', 20).catch(e => { errors.push(`top-artists: ${e.message}`); return null; }),
          spotify.getTopTracks('short_term', 10).catch(e => { errors.push(`top-tracks: ${e.message}`); return null; })
        ]);

        let energyCurve = [];
        if (recent?.items?.length) {
          // Spotify deprecated /audio-features (403 for apps created after
          // 2024-11-27), so energy is derived from a deterministic local proxy.
          energyCurve = recent.items.map(item => {
            const t = item.track;
            return { label: t.name || 'Unknown', value: Math.round(analytics.energyProxy(t)), trackId: t.id };
          }).reverse();
        }

        const storedPeaks = await analytics.getPeakHours();

        const history = recent?.items?.map(item => {
          const t = item.track;
          return {
            id: t.id,
            name: t.name,
            artist: t.artists?.map(a => a.name).join(', ') || '',
            album: t.album?.name || '',
            artUrl: t.album?.images?.[0]?.url || '',
            startedAt: new Date(item.played_at).getTime(),
            durationMs: t.duration_ms || 0
          };
        })?.reverse() || [];

        lastHistory = {
          energyCurve,
          peakHours: storedPeaks,
          history,
          topArtists: topArtists?.items || [],
          topTracks: topTracks?.items || [],
          errors
        };
        lastHistoryTime = Date.now();
        broadcast({ type: 'history', data: lastHistory });
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
      case 'get-friends': {
        try {
          const friends = await getFriendsCached();
          broadcast({ type: 'friends', data: { friends } });
        } catch (e) {
          broadcast({ type: 'friends', data: { friends: [], error: e.message } });
        }
        break;
      }
      case 'get-vibe-sync': {
        try {
          const friends = await getFriendsCached();
          const myTrack = lastState?.item;
          const myEnergy = myTrack ? analytics.energyProxy(myTrack) : null;
          const myArtist = myTrack?.artists?.[0]?.name?.toLowerCase() || '';
          const myHour = new Date().getHours();

          const trackIds = friends
            .map(f => f.track.uri?.split(':').pop())
            .filter(Boolean);

          let trackMap = {};
          if (trackIds.length) {
            const data = await spotify.getTracks(trackIds).catch(() => null);
            if (data?.tracks) {
              for (const t of data.tracks) {
                if (t) trackMap[t.id] = t;
              }
            }
          }

          const results = friends.map(f => {
            const tid = f.track.uri?.split(':').pop();
            const track = trackMap[tid];
            const friendEnergy = track ? analytics.energyProxy(track) : null;
            const friendArtist = f.track.artist?.toLowerCase() || '';
            const friendHour = f.timestamp ? new Date(f.timestamp).getHours() : myHour;
            return { ...f, energy: friendEnergy, artist: friendArtist, hour: friendHour };
          });

          broadcast({ 
            type: 'vibe-sync', 
            data: { 
              myEnergy, 
              myArtist,
              myHour,
              friends: results 
            } 
          });
        } catch (e) {
          broadcast({ type: 'vibe-sync', data: { myEnergy: null, friends: [], error: e.message } });
        }
        break;
      }
      case 'get-music-memory': {
        const mem = await analytics.getMusicMemory();
        broadcast({ type: 'music-memory', data: mem });
        break;
      }
      case 'get-notif-settings': {
        port.postMessage({ type: 'notif-settings', data: await notifs.getSettingsAsync() });
        break;
      }
      case 'set-notif-settings': {
        await notifs.saveSettings(msg.settings);
        port.postMessage({ type: 'notif-settings', data: notifs.getSettings() });
        break;
      }
      case 'check-saved': {
        const result = await spotify.checkSavedTracks([msg.trackId]);
        broadcast({ type: 'saved-status', data: { trackId: msg.trackId, saved: result?.[0] || false } });
        break;
      }
      case 'toggle-save': {
        if (msg.saved) {
          await spotify.removeTrack(msg.trackId);
        } else {
          await spotify.saveTrack(msg.trackId);
        }
        broadcast({ type: 'saved-status', data: { trackId: msg.trackId, saved: !msg.saved, toggled: true } });
        break;
      }
      case 'get-playlists': {
        const playlists = await spotify.getUserPlaylists(msg.limit || 50);
        // Store for new connections
        lastPlaylists = playlists;
        // Use broadcast to ensure popup receives it even if port reconnects
        broadcast({ type: 'playlists', data: playlists });
        break;
      }
      case 'play-playlist': {
        await spotify.play(msg.deviceId, undefined, msg.contextUri);
        schedulePoll(300);
        break;
      }
      case 'get-update-info': {
        const updateInfo = await getUpdateInfo();
        port.postMessage({ type: 'update-info', data: updateInfo });
        break;
      }
      case 'check-for-updates': {
        const updateInfo = await checkForUpdates();
        port.postMessage({ type: 'update-info', data: updateInfo });
        break;
      }
      case 'add-to-queue': {
        await spotify.addToQueue(msg.uri, msg.deviceId);
        port.postMessage({ type: 'queue-added', data: { uri: msg.uri } });
        schedulePoll(300);
        if (jamRole === 'host') {
          setTimeout(() => {
            spotify.getQueue().then(q => {
              chrome.runtime.sendMessage({ action: 'jam-broadcast-queue', data: q }).catch(() => {});
            }).catch(() => {});
          }, 500);
        }
        break;
      }
      case 'search': {
        const results = await spotify.search(msg.query, msg.types, msg.limit);
        port.postMessage({ type: 'search-results', data: results, seq: msg.seq });
        break;
      }
      case 'get-audio-features':
        // Deprecated - audio-features API returns 403 for new apps
        break;
      case 'get-liked-songs': {
        const liked = await spotify.getLikedSongs(msg.limit || 50, msg.offset || 0);
        broadcast({ type: 'liked-songs', data: liked });
        break;
      }
      case 'clear-analytics':
        analytics.invalidateCaches();
        await storage.remove('peakHours');
        await storage.remove('musicMemory');
        await storage.remove('streak');
        analytics.resetSession();
        notifs.resetSession();
        lastHistory = null;
        lastHistoryTime = 0;
        break;
      case 'logout':
        await analytics.flush();
        await spotify.logout();
        lastState = null;
        lastHistory = null;
        lastHistoryTime = 0;
        lastPlaylists = null;
        friendsCache = null;
        friendsCacheTime = 0;
        isAuthenticated = false;
        analytics.resetSession();
        analytics.invalidateCaches();
        notifs.resetSession();
        broadcast({ type: 'auth-required' });
        break;

      // --- Jam ---
      case 'jam-create': {
        await ensureOffscreenDocument();
        const profile = await spotify.getUserProfile();
        const userName = profile?.display_name || 'Host';
        const result = await chrome.runtime.sendMessage({ action: 'jam-create', name: userName });
        if (result?.ok) {
          jamActive = true;
          jamRole = 'host';
          broadcast({ type: 'jam-created', data: { roomCode: result.roomCode } });
        } else {
          broadcast({ type: 'jam-error', data: result?.error || 'Failed to create session' });
        }
        break;
      }
      case 'jam-join': {
        await ensureOffscreenDocument();
        const joinProfile = await spotify.getUserProfile();
        const joinName = joinProfile?.display_name || 'Guest';
        const joinResult = await chrome.runtime.sendMessage({ action: 'jam-join', code: msg.code, name: joinName });
        if (joinResult?.ok) {
          jamActive = true;
          jamRole = 'guest';
          broadcast({ type: 'jam-joined', data: { roomCode: joinResult.roomCode } });
        } else {
          broadcast({ type: 'jam-error', data: joinResult?.error || 'Failed to join session' });
        }
        break;
      }
      case 'jam-leave': {
        await chrome.runtime.sendMessage({ action: 'jam-leave' }).catch(() => {});
        jamActive = false;
        jamRole = null;
        await closeOffscreenDocument();
        broadcast({ type: 'jam-ended' });
        break;
      }
      case 'jam-get-state': {
        if (!jamActive) {
          port.postMessage({ type: 'jam-state', data: { active: false } });
          break;
        }
        const jamState = await chrome.runtime.sendMessage({ action: 'jam-get-state' });
        port.postMessage({ type: 'jam-state', data: jamState });
        break;
      }
      case 'jam-queue-add': {
        if (jamActive) {
          chrome.runtime.sendMessage({ action: 'jam-queue-add', data: { uri: msg.uri, name: msg.name } }).catch(() => {});
        }
        break;
      }
      default:
        console.warn('[ShardTune BG] Unknown action:', msg.action);
    }
  } catch (err) {
    try {
      port.postMessage({ type: 'error', data: err.message });
    } catch (e) {
      console.error('[ShardTune BG] Error sending error message:', err.message);
    }
  }
}

// --- Keyboard Shortcuts ---

chrome.commands.onCommand.addListener(async command => {
  try {
    const token = await spotify.getValidToken();
    if (!token) return;

    switch (command) {
      case 'toggle-playback': {
        const fresh = await spotify.getPlayerState();
        if (fresh?.is_playing) {
          await spotify.pause();
        } else {
          await spotify.play();
        }
        schedulePoll(300);
        break;
      }
      case 'next-track':
        await spotify.next();
        schedulePoll(500);
        break;
      case 'prev-track':
        await spotify.previous();
        schedulePoll(500);
        break;
    }
  } catch (e) { console.warn('[ShardTune BG] Command handler error:', e.message); }
});

// --- Startup ---

chrome.runtime.onInstalled.addListener(() => {
  analytics.invalidateCaches();
  notifs.loadSettings();
  startSlowPolling();
});

chrome.runtime.onStartup.addListener(() => {
  notifs.loadSettings();
  startSlowPolling();
});

// onInstalled/onStartup do NOT fire on a normal MV3 respawn, so ensure the
// durable fallback poll alarm exists on every worker spawn.
startSlowPolling();

chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).then(async contexts => {
  if (contexts.some(c => c.documentUrl?.includes('offscreen/jam.html'))) {
    jamActive = true;
    try {
      const state = await chrome.runtime.sendMessage({ action: 'jam-get-state' });
      if (state?.role) jamRole = state.role;
    } catch {}
  }
}).catch(() => {});
