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

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRoomCode() {
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => CHARS[b % CHARS.length]).join('');
}

function sendToBg(msg) {
  console.log('[Jam] sendToBg:', msg.action);
  chrome.runtime.sendMessage(msg).catch(e => {
    console.error('[Jam] sendToBg FAILED:', msg.action, e.message);
  });
}

function getPeerList() {
  const list = [{ name: myName, isHost: role === 'host' }];
  for (const [, info] of peerNames) {
    list.push({ name: info.name, isHost: info.isHost || false });
  }
  return list;
}

function broadcastPeerList() {
  const list = getPeerList();
  sendToBg({ action: 'jam-peers-updated', data: list });
}

function initRoom() {
  room = joinRoom({ appId: 'shardtune-jam', password: roomCode }, roomCode);

  stateAction = room.makeAction('state');
  actionAction = room.makeAction('action');
  queueAction = room.makeAction('queue');
  helloAction = room.makeAction('hello');

  room.onPeerJoin = (peerId) => {
    console.log('[Jam] Peer joined:', peerId);
    helloAction.send({ name: myName, isHost: role === 'host' });
    sendToBg({ action: 'jam-peer-connected', peerId });
  };

  room.onPeerLeave = (peerId) => {
    console.log('[Jam] Peer left:', peerId);
    const name = peerNames.get(peerId)?.name;
    peerNames.delete(peerId);
    broadcastPeerList();
    sendToBg({ action: 'jam-peer-disconnected', peerId, name });
  };

  helloAction.onMessage = (data, { peerId }) => {
    console.log('[Jam] Hello from:', peerId, data.name, 'isHost:', data.isHost);
    peerNames.set(peerId, { name: data.name, isHost: data.isHost || false });
    broadcastPeerList();
  };

  stateAction.onMessage = (data) => {
    if (role === 'guest') {
      sendToBg({ action: 'jam-sync-state', data });
    }
  };

  actionAction.onMessage = (data) => {
    if (role === 'guest') {
      sendToBg({ action: 'jam-sync-action', data });
    }
  };

  queueAction.onMessage = (data) => {
    if (role === 'host') {
      sendToBg({ action: 'jam-queue-request', data });
    }
  };
}

function handleCreate(name) {
  myName = name;
  role = 'host';
  roomCode = generateRoomCode();
  console.log('[Jam] Creating room:', roomCode, 'as:', selfId);
  initRoom();
  syncInterval = setInterval(() => {
    sendToBg({ action: 'jam-request-state' });
  }, 10000);
  return { ok: true, roomCode };
}

function handleJoin(code, name) {
  myName = name;
  role = 'guest';
  roomCode = code.toUpperCase();
  console.log('[Jam] Joining room:', roomCode, 'as:', selfId);
  initRoom();
  return { ok: true, roomCode };
}

function cleanup() {
  if (room) {
    room.leave();
    room = null;
  }
  stateAction = null;
  actionAction = null;
  queueAction = null;
  helloAction = null;
  peerNames.clear();
  if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
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
    case 'jam-queue-add':
      broadcastQueueAdd(msg.data);
      break;
  }
});
