import { joinRoom, selfId } from '../lib/trystero-nostr.mjs';

let room = null;
let role = null;
let roomCode = null;
let myName = '';
let peerNames = new Map();
let syncInterval = null;
let stateAction = null;
let actionAction = null;
let queueAction = null;
let helloAction = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 5;
const SYNC_INTERVAL = 4000;

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRoomCode() {
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => CHARS[b % CHARS.length]).join('');
}

function sendToBg(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

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

function destroyRoom() {
  if (room) { try { room.leave(); } catch {} }
  room = null;
  stateAction = null;
  actionAction = null;
  queueAction = null;
  helloAction = null;
}

function initRoom() {
  destroyRoom();
  room = joinRoom({ appId: 'shardtune-jam', password: roomCode }, roomCode);

  stateAction = room.makeAction('state');
  actionAction = room.makeAction('action');
  queueAction = room.makeAction('queue');
  helloAction = room.makeAction('hello');

  room.onPeerJoin = (peerId) => {
    reconnectAttempts = 0;
    helloAction.send({ name: myName, isHost: role === 'host' });
    sendToBg({ action: 'jam-peer-connected', peerId });
    if (role === 'host') {
      sendToBg({ action: 'jam-request-state' });
      sendToBg({ action: 'jam-request-queue' });
    }
  };

  room.onPeerLeave = (peerId) => {
    const name = peerNames.get(peerId)?.name;
    const wasHost = peerNames.get(peerId)?.isHost;
    peerNames.delete(peerId);
    broadcastPeerList();
    sendToBg({ action: 'jam-peer-disconnected', peerId, name });
    if (role === 'guest' && wasHost && peerNames.size === 0) {
      attemptReconnect();
    }
  };

  helloAction.onMessage = (data, { peerId }) => {
    peerNames.set(peerId, { name: data.name, isHost: data.isHost || false });
    broadcastPeerList();
  };

  stateAction.onMessage = (data) => {
    if (role === 'guest') sendToBg({ action: 'jam-sync-state', data });
  };

  actionAction.onMessage = (data) => {
    if (role === 'guest') sendToBg({ action: 'jam-sync-action', data });
  };

  queueAction.onMessage = (data) => {
    if (role === 'guest' && data.type === 'queue-sync') {
      sendToBg({ action: 'jam-queue-sync', data });
    } else if (role === 'host') {
      sendToBg({ action: 'jam-queue-request', data });
    }
  };
}

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
    initRoom();
  }, delay);
}

function startSyncLoop() {
  if (syncInterval) clearInterval(syncInterval);
  sendToBg({ action: 'jam-request-state' });
  syncInterval = setInterval(() => {
    sendToBg({ action: 'jam-request-state' });
  }, SYNC_INTERVAL);
}

function handleCreate(name) {
  myName = name;
  role = 'host';
  roomCode = generateRoomCode();
  reconnectAttempts = 0;
  initRoom();
  startSyncLoop();
  return { ok: true, roomCode };
}

function handleJoin(code, name) {
  myName = name;
  role = 'guest';
  roomCode = code.toUpperCase();
  reconnectAttempts = 0;
  initRoom();
  return { ok: true, roomCode };
}

function cleanup() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
  destroyRoom();
  peerNames.clear();
  reconnectAttempts = 0;
  role = null;
  roomCode = null;
  myName = '';
}

function handleLeave() {
  cleanup();
  sendToBg({ action: 'jam-ended' });
  return { ok: true };
}

function getJamState() {
  return {
    active: role !== null,
    role,
    roomCode,
    peerCount: peerNames.size,
    peers: getPeerList()
  };
}

function broadcastPlaybackState(playerState) {
  if (role !== 'host' || !stateAction) return;
  stateAction.send({
    trackUri: playerState.item?.uri,
    trackName: playerState.item?.name,
    trackArtist: playerState.item?.artists?.map(a => a.name).join(', '),
    albumArt: playerState.item?.album?.images?.[0]?.url,
    positionMs: playerState.progress_ms,
    durationMs: playerState.item?.duration_ms,
    isPlaying: playerState.is_playing,
    timestamp: Date.now()
  });
}

function broadcastAction(data) {
  if (role !== 'host' || !actionAction) return;
  actionAction.send(data);
}

function broadcastQueue(queueData) {
  if (role !== 'host' || !queueAction) return;
  const tracks = (queueData?.queue || []).slice(0, 20).map(t => ({
    uri: t.uri,
    name: t.name,
    artist: t.artists?.map(a => a.name).join(', ') || '',
    artUrl: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || '',
    durationMs: t.duration_ms || 0
  }));
  queueAction.send({ type: 'queue-sync', tracks });
}

function broadcastQueueAdd(data) {
  if (!queueAction) return;
  queueAction.send(data);
}

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
      broadcastPlaybackState(msg.data);
      break;
    case 'jam-broadcast-action':
      broadcastAction(msg.data);
      break;
    case 'jam-broadcast-queue':
      broadcastQueue(msg.data);
      break;
    case 'jam-queue-add':
      broadcastQueueAdd(msg.data);
      break;
  }
});
