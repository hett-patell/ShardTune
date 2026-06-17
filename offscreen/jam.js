import { joinRoom, selfId } from '../lib/trystero-nostr.mjs';

// --- Session state ---
let room = null;
let role = null;        // 'host' | 'guest' | null
let roomCode = null;
let myName = '';
let sessionId = null;   // unique per session, detects stale messages after reconnect
let peerNames = new Map();

// --- Host state ---
let syncInterval = null;
let queueVersion = 0;
let seqNum = 0;         // monotonic sequence number for snapshots
let trackEpoch = 0;     // incremented on every track change
let lastBroadcastUri = null;
let processedCommands = new Set();
let commandQueue = [];
let processingCommand = false;

// --- Guest state ---
let guestState = 'DISCONNECTED'; // DISCONNECTED|CONNECTING|SYNCING|SYNCED|RECONNECTING
let lastSnapshotSeq = -1;

// --- Heartbeat & reconnect ---
let heartbeatInterval = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let syncingTimeout = null;
const MAX_RECONNECT = 5;
const HEARTBEAT_INTERVAL = 4000;
const HEARTBEAT_DEAD = 15000;
const SYNC_INTERVAL = 3000;
const SYNCING_TIMEOUT = 15000;

// --- Trystero actions ---
let stateAction = null;    // host→guest: STATE_SNAPSHOT, QUEUE_UPDATE
let commandAction = null;  // guest→host: REQUEST
let helloAction = null;    // bidirectional: handshake
let heartbeatAction = null;// bidirectional: PING/PONG

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRoomCode() {
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => CHARS[b % CHARS.length]).join('');
}

function generateId() {
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

function sendToBg(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// --- Peer list ---

function getPeerList() {
  const list = [{ name: myName, isHost: role === 'host' }];
  for (const [, info] of peerNames) {
    list.push({ name: info.name, isHost: info.isHost || false });
  }
  return list;
}

function broadcastPeerList() {
  sendToBg({ action: 'jam-peers-updated', data: getPeerList() });
}

// --- Room lifecycle ---

function destroyRoom() {
  if (room) { try { room.leave(); } catch {} }
  room = null;
  stateAction = null;
  commandAction = null;
  helloAction = null;
  heartbeatAction = null;
}

function initRoom() {
  destroyRoom();
  room = joinRoom({ appId: 'shardtune-jam', password: roomCode }, roomCode);

  stateAction = room.makeAction('state');
  commandAction = room.makeAction('cmd');
  helloAction = room.makeAction('hello');
  heartbeatAction = room.makeAction('hb');

  room.onPeerJoin = (peerId) => {
    reconnectAttempts = 0;
    helloAction.send({ name: myName, isHost: role === 'host', sessionId });
    sendToBg({ action: 'jam-peer-connected', peerId });

    if (role === 'host') {
      sendToBg({ action: 'jam-request-state' });
      sendToBg({ action: 'jam-request-queue' });
    }
    if (role === 'guest') {
      setGuestState('SYNCING');
    }
  };

  room.onPeerLeave = (peerId) => {
    const info = peerNames.get(peerId);
    peerNames.delete(peerId);
    broadcastPeerList();
    sendToBg({ action: 'jam-peer-disconnected', peerId, name: info?.name });

    if (role === 'guest' && info?.isHost) {
      setGuestState('RECONNECTING');
      attemptReconnect();
    }
  };

  helloAction.onMessage = (data, { peerId }) => {
    peerNames.set(peerId, { name: data.name, isHost: data.isHost || false, lastSeen: Date.now() });
    broadcastPeerList();
  };

  // --- Host receives REQUEST from guests ---
  commandAction.onMessage = (data) => {
    if (role !== 'host') return;
    if (!data?.commandId || processedCommands.has(data.commandId)) return;
    enqueueCommand(data);
  };

  // --- Guest receives STATE_SNAPSHOT / QUEUE_UPDATE from host ---
  stateAction.onMessage = (data) => {
    if (role !== 'guest') return;
    if (data.type === 'STATE_SNAPSHOT') {
      if (data.seq != null && data.seq <= lastSnapshotSeq) return;
      lastSnapshotSeq = data.seq ?? -1;
      guestHandleSnapshot(data);
    } else if (data.type === 'QUEUE_UPDATE') {
      sendToBg({ action: 'jam-queue-sync', data });
    }
  };

  // --- Heartbeat ---
  heartbeatAction.onMessage = (data, { peerId }) => {
    if (data.type === 'PING' && role === 'guest') {
      heartbeatAction.send({ type: 'PONG' });
    } else if (data.type === 'PONG' && role === 'host') {
      const peer = peerNames.get(peerId);
      if (peer) peer.lastSeen = Date.now();
    }
  };
}

// --- Guest state machine ---

function setGuestState(state) {
  if (guestState === state) return;
  guestState = state;
  sendToBg({ action: 'jam-sync-status', data: { state: guestState } });

  if (syncingTimeout) { clearTimeout(syncingTimeout); syncingTimeout = null; }
  if (state === 'SYNCING' || state === 'CONNECTING') {
    syncingTimeout = setTimeout(() => {
      if (guestState === 'SYNCING' || guestState === 'CONNECTING') {
        sendToBg({ action: 'jam-error', data: 'No response from host' });
        setGuestState('DISCONNECTED');
        attemptReconnect();
      }
    }, SYNCING_TIMEOUT);
  }
}

function guestHandleSnapshot(snapshot) {
  sendToBg({
    action: 'jam-apply-state',
    data: {
      trackUri: snapshot.trackUri,
      positionMs: snapshot.positionMs,
      durationMs: snapshot.durationMs,
      isPlaying: snapshot.isPlaying,
      timestamp: snapshot.timestamp,
      trackEpoch: snapshot.trackEpoch,
      queueVersion: snapshot.queueVersion
    }
  });

  if (guestState === 'SYNCING' || guestState === 'RECONNECTING') {
    setGuestState('SYNCED');
  }
}

// --- Host command processing ---

function enqueueCommand(cmd) {
  commandQueue.push(cmd);
  processNextCommand();
}

function processNextCommand() {
  if (processingCommand || commandQueue.length === 0) return;
  processingCommand = true;
  const cmd = commandQueue.shift();

  processedCommands.add(cmd.commandId);
  if (processedCommands.size > 50) {
    const arr = [...processedCommands];
    processedCommands = new Set(arr.slice(-30));
  }

  sendToBg({ action: 'jam-host-command', data: cmd });

  setTimeout(() => {
    processingCommand = false;
    processNextCommand();
  }, 300);
}

// --- Host: broadcast state + queue ---

function broadcastSnapshot(playerState) {
  if (role !== 'host' || !stateAction) return;

  const uri = playerState?.item?.uri;
  if (uri && uri !== lastBroadcastUri) {
    trackEpoch++;
    lastBroadcastUri = uri;
  }
  seqNum++;

  stateAction.send({
    type: 'STATE_SNAPSHOT',
    seq: seqNum,
    sessionId,
    trackUri: uri,
    trackName: playerState?.item?.name,
    trackArtist: playerState?.item?.artists?.map(a => a.name).join(', '),
    albumArt: playerState?.item?.album?.images?.[0]?.url,
    positionMs: playerState?.progress_ms || 0,
    durationMs: playerState?.item?.duration_ms || 0,
    isPlaying: playerState?.is_playing || false,
    trackEpoch,
    queueVersion,
    timestamp: Date.now()
  });
}

function broadcastQueue(queueData) {
  if (role !== 'host' || !stateAction) return;
  queueVersion++;
  const tracks = (queueData?.queue || []).slice(0, 20).map(t => ({
    uri: t.uri, name: t.name,
    artist: t.artists?.map(a => a.name).join(', ') || '',
    artUrl: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || '',
    durationMs: t.duration_ms || 0
  }));
  stateAction.send({ type: 'QUEUE_UPDATE', queueVersion, tracks });
}

// --- Guest: send request to host ---

function sendRequest(type, extra = {}) {
  if (role !== 'guest' || !commandAction) return;
  commandAction.send({ commandId: generateId(), type, ...extra });
}

// --- Heartbeat ---

function startHeartbeat() {
  stopHeartbeat();
  if (role !== 'host') return;
  heartbeatInterval = setInterval(() => {
    heartbeatAction.send({ type: 'PING' });
    const now = Date.now();
    for (const [peerId, info] of peerNames) {
      if (!info.lastSeen) continue;
      const elapsed = now - info.lastSeen;
      if (elapsed > HEARTBEAT_DEAD) {
        peerNames.delete(peerId);
        broadcastPeerList();
        sendToBg({ action: 'jam-peer-disconnected', peerId, name: info.name });
      }
    }
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
}

// --- Reconnect ---

function attemptReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT) {
    sendToBg({ action: 'jam-error', data: 'Lost connection to host' });
    cleanup();
    sendToBg({ action: 'jam-ended' });
    return;
  }
  reconnectAttempts++;
  const delay = Math.min(2000 * reconnectAttempts, 10000);
  sendToBg({ action: 'jam-reconnecting', attempt: reconnectAttempts, maxAttempts: MAX_RECONNECT });
  reconnectTimer = setTimeout(() => {
    lastSnapshotSeq = -1;
    initRoom();
  }, delay);
}

// --- Sync loop (host only) ---

function startSyncLoop() {
  if (syncInterval) clearInterval(syncInterval);
  sendToBg({ action: 'jam-request-state' });
  syncInterval = setInterval(() => {
    sendToBg({ action: 'jam-request-state' });
  }, SYNC_INTERVAL);
}

// --- Session lifecycle ---

function handleCreate(name) {
  myName = name;
  role = 'host';
  roomCode = generateRoomCode();
  sessionId = generateId();
  seqNum = 0;
  trackEpoch = 0;
  queueVersion = 0;
  lastBroadcastUri = null;
  processedCommands.clear();
  commandQueue = [];
  processingCommand = false;
  reconnectAttempts = 0;

  initRoom();
  startSyncLoop();
  startHeartbeat();
  return { ok: true, roomCode };
}

function handleJoin(code, name) {
  myName = name;
  role = 'guest';
  roomCode = code.toUpperCase();
  sessionId = generateId();
  lastSnapshotSeq = -1;
  reconnectAttempts = 0;
  guestState = 'CONNECTING';

  initRoom();
  setGuestState('CONNECTING');
  return { ok: true, roomCode };
}

function cleanup() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
  if (syncingTimeout) { clearTimeout(syncingTimeout); syncingTimeout = null; }
  stopHeartbeat();
  destroyRoom();
  peerNames.clear();
  reconnectAttempts = 0;
  role = null;
  roomCode = null;
  sessionId = null;
  myName = '';
  guestState = 'DISCONNECTED';
  lastSnapshotSeq = -1;
  processedCommands.clear();
  commandQueue = [];
  processingCommand = false;
}

function handleLeave() {
  cleanup();
  sendToBg({ action: 'jam-ended' });
  return { ok: true };
}

function getJamState() {
  return {
    active: role !== null,
    role, roomCode, sessionId,
    peerCount: peerNames.size,
    peers: getPeerList(),
    guestState: role === 'guest' ? guestState : undefined
  };
}

// --- Message handler ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    case 'jam-create':
      sendResponse(handleCreate(msg.name));
      break;
    case 'jam-join':
      sendResponse(handleJoin(msg.code, msg.name));
      break;
    case 'jam-leave':
      sendResponse(handleLeave());
      break;
    case 'jam-get-state':
      sendResponse(getJamState());
      break;
    case 'jam-broadcast-state':
      broadcastSnapshot(msg.data);
      break;
    case 'jam-broadcast-queue':
      broadcastQueue(msg.data);
      break;
    case 'jam-forward-request':
      sendRequest(msg.data.type, msg.data);
      break;
  }
});
