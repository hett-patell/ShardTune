import * as spotify from './utils/spotify.js';
import * as analytics from './utils/analytics.js';
import * as storage from './utils/storage.js';
import * as buddylist from './utils/buddylist.js';
import * as notifs from './utils/notifications.js';

const POLL_FAST = 5000;
const POLL_SLOW_MINUTES = 1;
const ALARM_POLL = 'shardtune-poll';
const ALARM_SLEEP = 'shardtune-sleep';

let ports = new Set();
let pollInterval = null;
let lastState = null;
let isAuthenticated = false;
let polling = null;       // single-flight guard for poll()
let pollTimer = null;     // debounce timer for post-command refresh

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
    spotify.pause().catch(() => {});
    broadcast({ type: 'sleep-fired' });
    storage.remove('sleepTimer');
  }
});

async function doPoll() {
  try {
    const token = await spotify.getValidToken();
    if (!token) {
      isAuthenticated = false;
      broadcast({ type: 'auth-required' });
      return;
    }

    isAuthenticated = true;

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
          await analytics.updatePeakHours();
          analytics.updateMusicMemory(analytics.energyProxy(state.item)).catch(() => {});
        }
      }

      if (state.item) {
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
  } catch (err) {
    if (err.message?.includes('Not authenticated')) {
      isAuthenticated = false;
      broadcast({ type: 'auth-required' });
    } else if (err.retryAfterMs) {
      // Rate limited — pause the fast interval and resume after Retry-After
      // so we don't keep hammering a cooling-down endpoint.
      stopFastPolling();
      setTimeout(() => { if (ports.size > 0) startFastPolling(); }, err.retryAfterMs);
    }
  }
}

// --- Port Message Handling ---

async function handlePortMessage(msg, port) {
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
        await spotify.play(msg.deviceId);
        schedulePoll(300);
        break;
      case 'pause':
        await spotify.pause();
        schedulePoll(300);
        break;
      case 'next':
        await spotify.next();
        schedulePoll(500);
        break;
      case 'previous':
        await spotify.previous();
        schedulePoll(500);
        break;
      case 'seek':
        await spotify.seek(msg.positionMs);
        schedulePoll(300);
        break;
      case 'volume':
        await spotify.setVolume(msg.percent);
        schedulePoll(300);
        break;
      case 'shuffle':
        await spotify.setShuffle(msg.state);
        schedulePoll(300);
        break;
      case 'repeat':
        await spotify.setRepeat(msg.mode);
        schedulePoll(300);
        break;
      case 'transfer':
        await spotify.transferPlayback(msg.deviceId);
        schedulePoll(500);
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
      case 'get-profile': {
        const profile = await spotify.getUserProfile();
        port.postMessage({ type: 'profile', data: profile });
        break;
      }
      case 'get-analytics': {
        const session = analytics.getSession();
        const streak = await analytics.getStreak();
        const peakHours = await analytics.getPeakHours();
        port.postMessage({ type: 'analytics', data: { session, streak, peakHours } });
        break;
      }
      case 'get-history': {
        const errors = [];
        const [recent, topArtists, topTracks] = await Promise.all([
          spotify.getRecentlyPlayed(50).catch(e => { errors.push(`recently-played: ${e.message}`); return null; }),
          spotify.getTopArtists('short_term', 20).catch(e => { errors.push(`top-artists: ${e.message}`); return null; }),
          spotify.getTopTracks('short_term', 10).catch(e => { errors.push(`top-tracks: ${e.message}`); return null; })
        ]);

        let energyCurve = [];
        if (recent?.items?.length) {
          const trackIds = recent.items
            .map(i => i.track?.id).filter(Boolean)
            .filter((v, idx, arr) => arr.indexOf(v) === idx);
          const features = await spotify.getAudioFeatures(trackIds).catch(() => null);
          const featureMap = {};
          if (features?.audio_features) {
            for (const f of features.audio_features) {
              if (f) featureMap[f.id] = f;
            }
          }
          energyCurve = recent.items.map(item => {
            const t = item.track;
            const feat = featureMap[t.id];
            const energy = feat
              ? Math.round(feat.energy * 100)
              : Math.round(analytics.energyProxy(t));
            return { label: t.name || 'Unknown', value: energy, trackId: t.id };
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

        port.postMessage({
          type: 'history',
          data: {
            energyCurve,
            peakHours: storedPeaks,
            history,
            topArtists: topArtists?.items || [],
            topTracks: topTracks?.items || [],
            errors
          }
        });
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
          const friends = await buddylist.getFriendActivity();
          port.postMessage({ type: 'friends', data: { friends } });
        } catch (e) {
          port.postMessage({ type: 'friends', data: { friends: [], error: e.message } });
        }
        break;
      }
      case 'get-vibe-sync': {
        try {
          const friends = await buddylist.getFriendActivity();
          const myEnergy = lastState?.item ? analytics.energyProxy(lastState.item) : null;

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
            return { ...f, energy: friendEnergy };
          });

          port.postMessage({ type: 'vibe-sync', data: { myEnergy, friends: results } });
        } catch (e) {
          port.postMessage({ type: 'vibe-sync', data: { myEnergy: null, friends: [], error: e.message } });
        }
        break;
      }
      case 'get-music-memory': {
        const mem = await analytics.getMusicMemory();
        port.postMessage({ type: 'music-memory', data: mem });
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
      case 'clear-analytics':
        analytics.invalidateCaches();
        await storage.remove('peakHours');
        await storage.remove('musicMemory');
        await storage.remove('streak');
        analytics.resetSession();
        notifs.resetSession();
        break;
      case 'logout':
        await analytics.flush();
        await spotify.logout();
        lastState = null;
        isAuthenticated = false;
        analytics.resetSession();
        analytics.invalidateCaches();
        notifs.resetSession();
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
        schedulePoll(300);
        break;
      case 'next-track':
        await spotify.next();
        schedulePoll(500);
        break;
      case 'prev-track':
        await spotify.previous();
        schedulePoll(500);
        break;
    }
  } catch {}
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
