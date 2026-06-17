import * as spotify from './spotify.js';
import * as buddylist from './buddylist.js';

const FRIEND_POLL_MS = 180000;
const FOCUS_REMIND_MS = 3600000;

let lastTrackId = null;
let lastFriendPoll = 0;
let knownFriendTracks = new Map();
let lastFocusRemindAt = 0;
let totalListenMs = 0;
let enabled = { friends: true, liked: true, focus: true };
let settingsPromise = null;

export function loadSettings() {
  settingsPromise = (async () => {
    const stored = await chrome.storage.local.get('notifSettings');
    if (stored.notifSettings) enabled = { ...enabled, ...stored.notifSettings };
    return enabled;
  })();
  return settingsPromise;
}

// MV3 workers lose module state on eviction — guarantee settings are loaded
// from storage before any notification gate is evaluated, on every spawn.
function ensureSettings() {
  if (!settingsPromise) return loadSettings();
  return settingsPromise;
}

export async function saveSettings(settings) {
  await ensureSettings();   // merge into loaded values, never stale defaults
  enabled = { ...enabled, ...settings };
  await chrome.storage.local.set({ notifSettings: enabled });
  settingsPromise = Promise.resolve(enabled);
}

export function getSettings() {
  return { ...enabled };
}

export async function getSettingsAsync() {
  await ensureSettings();
  return { ...enabled };
}

export function resetSession() {
  lastFocusRemindAt = 0;
  totalListenMs = 0;
}

export async function onTrackChange(track) {
  if (!track?.id || track.id === lastTrackId) return;
  lastTrackId = track.id;

  await ensureSettings();
  if (!enabled.liked) return;

  try {
    const saved = await spotify.checkSavedTracks([track.id]);
    if (saved?.[0]) {
      notify('liked-song', 'Liked Song Playing', `${track.name} — ${track.artists?.map(a => a.name).join(', ') || ''}`, track.album?.images?.[1]?.url);
    }
  } catch {}
}

export async function onPollTick(isPlaying, listenMs) {
  totalListenMs = listenMs;
  await ensureSettings();

  if (isPlaying && enabled.focus) {
    checkFocusReminder();
  }

  if (enabled.friends) {
    await checkFriendActivity();
  }
}

function checkFocusReminder() {
  const hours = Math.floor(totalListenMs / FOCUS_REMIND_MS);
  if (hours < 1) return;

  const lastHour = Math.floor(lastFocusRemindAt / FOCUS_REMIND_MS);
  if (hours > lastHour) {
    lastFocusRemindAt = totalListenMs;
    const h = hours === 1 ? '1 hour' : `${hours} hours`;
    notify('focus-remind', 'Focus Reminder', `You've been listening for ${h}. Time for a break?`);
  }
}

async function checkFriendActivity() {
  const now = Date.now();
  if (now - lastFriendPoll < FRIEND_POLL_MS) return;
  lastFriendPoll = now;

  try {
    const friends = await buddylist.getFriendActivity();

    for (const f of friends) {
      const key = f.user.uri || f.user.name;
      const prev = knownFriendTracks.get(key);
      const current = f.track.uri || f.track.name;

      if (prev && prev !== current) {
        notify(
          `friend-${key}`,
          `${f.user.name} is listening`,
          `${f.track.name}${f.track.artist ? ' — ' + f.track.artist : ''}`,
          f.track.image || f.user.image
        );
      }

      knownFriendTracks.set(key, current);
    }
    if (knownFriendTracks.size > 100) {
      const iter = knownFriendTracks.keys();
      for (let i = knownFriendTracks.size - 100; i > 0; i--) {
        knownFriendTracks.delete(iter.next().value);
      }
    }
  } catch {}
}

function notify(id, title, message, iconUrl) {
  const options = {
    type: 'basic',
    title,
    message,
    iconUrl: iconUrl || chrome.runtime.getURL('icons/icon-128.png'),
    silent: true
  };

  chrome.notifications.create(id, options, () => {
    setTimeout(() => chrome.notifications.clear(id), 8000);
  });
}

// Kick off a settings load as soon as the worker spawns, so toggles the user
// turned off don't silently revert to defaults after an idle eviction.
loadSettings();
