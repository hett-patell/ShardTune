import * as storage from './storage.js';

let session = createSession();

let peakHoursCache = null;
let musicMemoryCache = null;
let streakCache = null;

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
  // Return copies so callers get a stable snapshot (the background keeps
  // mutating the live arrays via push/shift).
  const history = session.history.map(h => ({ ...h }));
  // Reflect the in-flight (currently playing) track's listen time, which is
  // otherwise only written into history when the NEXT track starts.
  const current = history[history.length - 1];
  if (current && !current.finalized) {
    current.listenedMs = session.currentTrackListened;
    current.skipped = current.durationMs > 0
      ? current.listenedMs / current.durationMs < 0.8
      : false;
  }
  return {
    sessionStart: session.sessionStart,
    totalListenMs: session.totalListenMs,
    trackChanges: session.trackChanges,
    skips: session.skips,
    artistCount: session.artists.size,
    artists: [...session.artists],
    history,
    energyHistory: session.energyHistory.map(e => ({ ...e }))
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
  if (!state || !state.item) return { trackChanged: false };

  const now = Date.now();
  const track = state.item;
  const isPlaying = state.is_playing;
  let trackChanged = false;

  if (isPlaying && session.lastPollTime) {
    const elapsed = now - session.lastPollTime;
    if (elapsed > 0) {
      // Cap a single tick at ~65s so the 60s background poll still accrues
      // listen time, while a laptop sleep/wake gap can't over-count.
      const add = Math.min(elapsed, 65000);
      session.totalListenMs += add;
      session.currentTrackListened += add;
    }
  }

  if (track.id !== session.lastTrackId) {
    trackChanged = true;
    if (session.lastTrackId !== null) {
      session.trackChanges++;
      finalizeTrack(track);
    } else {
      // First track of the session — push its live entry now so it appears
      // immediately (finalizeTrack only runs on a subsequent track change).
      pushHistoryEntry(track);
    }

    session.lastTrackId = track.id;
    session.currentTrackStart = now;
    session.currentTrackListened = 0;

    track.artists?.forEach(a => session.artists.add(a.name));

    const energy = energyProxy(track);
    const lastEnergy = session.energyHistory[session.energyHistory.length - 1];
    if (!lastEnergy || lastEnergy.trackId !== track.id) {
      session.energyHistory.push({
        label: track.name?.substring(0, 20) || 'Unknown',
        value: Math.round(energy),
        trackId: track.id
      });
      if (session.energyHistory.length > 20) {
        session.energyHistory.shift();
      }
    }
  }

  session.lastPollTime = now;
  return { trackChanged };
}

function pushHistoryEntry(track) {
  const artists = track.artists?.map(a => a.name).join(', ') || 'Unknown';
  session.history.push({
    id: track.id,
    name: track.name,
    artist: artists,
    album: track.album?.name || '',
    artUrl: track.album?.images?.[0]?.url || '',
    startedAt: Date.now(),
    durationMs: track.duration_ms || 0,
    listenedMs: 0,
    skipped: false,
    finalized: false
  });

  if (session.history.length > 20) {
    session.history.shift();
  }
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

  pushHistoryEntry(newTrack);
}

// --- In-memory cache (write-through to storage) ---
//
// MV3 workers can be evicted ~30s after going idle, so we persist each
// increment immediately rather than buffering on a timer that may never
// fire. These updates run at most once per track change, so the write
// volume is trivial.

export async function flush() {
  const batch = {};
  if (peakHoursCache) batch.peakHours = peakHoursCache;
  if (musicMemoryCache) batch.musicMemory = musicMemoryCache;
  if (streakCache) batch.streak = streakCache;
  if (Object.keys(batch).length) await storage.setAll(batch);
}

export function invalidateCaches() {
  peakHoursCache = null;
  musicMemoryCache = null;
  streakCache = null;
}

// --- Streak ---

function localDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export async function updateStreak() {
  if (!streakCache) streakCache = (await storage.get('streak')) || { count: 0, lastDate: null };
  const today = localDateStr(new Date());
  if (streakCache.lastDate === today) return streakCache;

  const d = new Date();
  d.setDate(d.getDate() - 1);
  const yesterday = localDateStr(d);
  if (streakCache.lastDate === yesterday) {
    streakCache.count++;
  } else {
    streakCache.count = 1;
  }
  streakCache.lastDate = today;
  await storage.set('streak', streakCache);
  return streakCache;
}

export async function getStreak() {
  if (!streakCache) streakCache = (await storage.get('streak')) || { count: 0, lastDate: null };
  const today = localDateStr(new Date());
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const yesterday = localDateStr(d);
  if (streakCache.lastDate !== today && streakCache.lastDate !== yesterday) {
    if (streakCache.count !== 0) {
      streakCache.count = 0;
      await storage.set('streak', streakCache);
    }
    return streakCache;
  }
  return streakCache;
}

// --- Peak Hours ---

function validPeakHours(arr) {
  return Array.isArray(arr) && arr.length === 24 && arr.every(v => typeof v === 'number' && !isNaN(v));
}

export async function getPeakHours() {
  if (!peakHoursCache) {
    const stored = await storage.get('peakHours');
    peakHoursCache = validPeakHours(stored) ? stored : new Array(24).fill(0);
  }
  return peakHoursCache;
}

// --- Music Memory ---

function emptyMemory() {
  return new Array(168).fill(null).map(() => ({ plays: 0, energy: 0 }));
}

export async function getMusicMemory() {
  if (!musicMemoryCache) musicMemoryCache = (await storage.get('musicMemory')) || emptyMemory();
  return musicMemoryCache;
}

// Combined write — avoids two separate storage.set calls per track change.
export async function updateTrackAnalytics(energy) {
  if (!peakHoursCache) {
    const stored = await storage.get('peakHours');
    peakHoursCache = validPeakHours(stored) ? stored : new Array(24).fill(0);
  }
  if (!musicMemoryCache) {
    const stored = await storage.get('musicMemory');
    musicMemoryCache = (Array.isArray(stored) && stored.length === 168) ? stored : emptyMemory();
  }

  const now = new Date();
  peakHoursCache[now.getHours()]++;

  const slot = now.getDay() * 24 + now.getHours();
  musicMemoryCache[slot].plays++;
  musicMemoryCache[slot].energy += energy;

  await storage.setAll({ peakHours: peakHoursCache, musicMemory: musicMemoryCache });
}
