// Adaptive Sync Engine for Jam Sessions
// Predicts host position, measures RTT, applies correction with guards.

const RTT_SAMPLES = 5;
const DRIFT_SAMPLES = 3;
const MAX_PREDICTION_AGE = 10000;
const TRANSITION_LOCK_MS = 2000;
const SEEK_COOLDOWN = 3000;
const RESYNC_COOLDOWN = 15000;
const BASE_THRESHOLD = 3000;
const MAX_THRESHOLD = 4500;
const CONSECUTIVE_REQUIRED = 3;

let hostRef = null;
let rttBuffer = [];
let driftBuffer = [];
let consecutiveDrift = 0;
let lastCorrectionAt = 0;
let lastResyncAt = 0;
let transitionLock = false;
let transitionTimer = null;
let manualOffset = 0;

// --- RTT ---

export function recordRtt(rttMs) {
  rttBuffer.push(rttMs);
  if (rttBuffer.length > RTT_SAMPLES) rttBuffer.shift();
}

export function getLatency() {
  if (!rttBuffer.length) return { avg: 200, jitter: 100 };
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

// --- Prediction ---

export function predictPosition() {
  if (!hostRef) return 0;
  const elapsed = Math.min(Date.now() - hostRef.timestamp, MAX_PREDICTION_AGE);
  return hostRef.positionMs + elapsed + manualOffset;
}

// --- Drift ---

export function calculateDrift(localProgressMs) {
  return predictPosition() - localProgressMs;
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

// --- Correction ---

export function shouldCorrect() {
  if (transitionLock) return false;
  if (Date.now() - lastCorrectionAt < SEEK_COOLDOWN) return false;
  if (consecutiveDrift < CONSECUTIVE_REQUIRED) return false;
  return true;
}

export function applyCorrection(seekTo) {
  lastCorrectionAt = Date.now();
  consecutiveDrift = 0;
}

// --- Core Tick (called every 500ms by background.js) ---

export function tick(localProgressMs) {
  if (!hostRef || !hostRef.isPlaying) return null;
  if (transitionLock) return null;
  if (Date.now() - hostRef.timestamp > MAX_PREDICTION_AGE) return null;

  const predicted = predictPosition();
  const drift = predicted - localProgressMs;
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
  if (!shouldCorrect()) return null;

  lastCorrectionAt = Date.now();
  consecutiveDrift = 0;
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
  const drift = hostRef ? Math.abs(calculateDrift(0)) : 0;
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
  rttBuffer = [];
  driftBuffer = [];
  consecutiveDrift = 0;
  lastCorrectionAt = 0;
  lastResyncAt = 0;
  transitionLock = false;
  if (transitionTimer) { clearTimeout(transitionTimer); transitionTimer = null; }
}
