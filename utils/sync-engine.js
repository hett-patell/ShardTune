// Adaptive Sync Engine for Jam Sessions
// Predicts host position, measures RTT, applies correction with guards.

const RTT_SAMPLES = 5;
const DRIFT_SAMPLES = 3;
const MAX_PREDICTION_AGE = 8000;
const TRANSITION_LOCK_MS = 3000;
const SEEK_COOLDOWN = 2000;
const BASE_THRESHOLD = 800;
const MAX_THRESHOLD = 1500;
const CONSECUTIVE_REQUIRED = 2;

let hostRef = null;
let localRef = null;       // continuously estimated local playback position
let rttBuffer = [];
let driftBuffer = [];
let consecutiveDrift = 0;
let lastCorrectionAt = 0;
let transitionLock = false;
let transitionTimer = null;
let manualOffset = 0;

// --- RTT ---

export function recordRtt(rttMs) {
  rttBuffer.push(rttMs);
  if (rttBuffer.length > RTT_SAMPLES) rttBuffer.shift();
}

export function getLatency() {
  if (rttBuffer.length < 2) return { avg: 0, jitter: 0 };
  const avg = rttBuffer.reduce((a, b) => a + b, 0) / rttBuffer.length;
  const jitter = Math.sqrt(rttBuffer.reduce((s, v) => s + (v - avg) ** 2, 0) / rttBuffer.length);
  return { avg: Math.round(avg), jitter: Math.round(jitter) };
}

// --- Host Reference ---

export function updateHostRef(data) {
  hostRef = {
    positionMs: data.positionMs || 0,
    timestamp: data.timestamp || Date.now(),
    isPlaying: data.isPlaying || false,
    trackUri: data.trackUri || null
  };
}

export function hasHostRef() {
  return hostRef !== null;
}

export function clearHostRef() {
  hostRef = null;
}

// --- Local Playback Reference ---
// Continuously estimated local position. Updated whenever Spotify polling
// returns fresh state. Between polls, we interpolate by adding elapsed time.

export function updateLocalRef(progressMs, isPlaying) {
  localRef = {
    progressMs: progressMs || 0,
    timestamp: Date.now(),
    isPlaying: isPlaying || false
  };
}

export function getEstimatedLocalPosition() {
  if (!localRef) return 0;
  if (!localRef.isPlaying) return localRef.progressMs;
  const elapsed = Date.now() - localRef.timestamp;
  return localRef.progressMs + elapsed;
}

// --- Prediction ---
// Includes RTT compensation: host snapshots are already old when they arrive.
// avgRtt/2 estimates one-way latency to better predict where the host is now.

export function predictPosition() {
  if (!hostRef) return 0;
  const elapsed = Math.min(Date.now() - hostRef.timestamp, MAX_PREDICTION_AGE);
  const { avg } = getLatency();
  const rttCompensation = Math.round(avg / 2);
  return hostRef.positionMs + elapsed + rttCompensation + manualOffset;
}

// --- Drift ---

export function calculateDrift() {
  return predictPosition() - getEstimatedLocalPosition();
}

export function getDynamicThreshold() {
  const { jitter } = getLatency();
  return Math.min(BASE_THRESHOLD + jitter, MAX_THRESHOLD);
}

// --- Transition Lock ---

export function enterTransitionLock() {
  transitionLock = true;
  driftBuffer = [];
  consecutiveDrift = 0;
  if (transitionTimer) clearTimeout(transitionTimer);
  transitionTimer = setTimeout(() => {
    transitionLock = false;
    transitionTimer = null;
  }, TRANSITION_LOCK_MS);
}

// --- Core Tick (called every 500ms by background.js) ---
// No arguments — uses internal hostRef and localRef for live comparison.

export function tick() {
  if (!hostRef || !hostRef.isPlaying) return null;
  if (!localRef) return null;
  if (transitionLock) return null;
  if (Date.now() - hostRef.timestamp > MAX_PREDICTION_AGE) return null;

  const predicted = predictPosition();
  const estimatedLocal = getEstimatedLocalPosition();
  const drift = predicted - estimatedLocal;
  const absDrift = Math.abs(drift);

  driftBuffer.push(absDrift);
  if (driftBuffer.length > DRIFT_SAMPLES) driftBuffer.shift();

  const threshold = getDynamicThreshold();

  if (absDrift > threshold) {
    consecutiveDrift++;
  } else {
    consecutiveDrift = 0;
    return null;
  }

  if (consecutiveDrift < CONSECUTIVE_REQUIRED) return null;
  if (Date.now() - lastCorrectionAt < SEEK_COOLDOWN) return null;

  lastCorrectionAt = Date.now();
  consecutiveDrift = 0;
  driftBuffer = [];
  return { seekTo: Math.max(0, Math.round(predicted)) };
}

// --- Manual Offset ---

export function getManualOffset() {
  return manualOffset;
}

export function setManualOffset(ms) {
  manualOffset = ms;
}

export async function loadManualOffset() {
  try {
    const result = await chrome.storage.local.get('jamSyncOffset');
    manualOffset = result.jamSyncOffset || 0;
  } catch {}
}

export async function saveManualOffset(ms) {
  manualOffset = ms;
  try {
    await chrome.storage.local.set({ jamSyncOffset: ms });
  } catch {}
}

// --- Sync Status ---

export function getSyncStatus() {
  const latency = getLatency();
  const drift = hostRef && localRef ? Math.abs(calculateDrift()) : 0;
  return {
    latency: latency.avg,
    jitter: latency.jitter,
    drift: Math.round(drift),
    threshold: getDynamicThreshold(),
    manualOffset,
    transitionLock,
    consecutiveDrift
  };
}

// --- Reset ---

export function reset() {
  hostRef = null;
  localRef = null;
  rttBuffer = [];
  driftBuffer = [];
  consecutiveDrift = 0;
  lastCorrectionAt = 0;
  transitionLock = false;
  manualOffset = 0;
  if (transitionTimer) { clearTimeout(transitionTimer); transitionTimer = null; }
}
