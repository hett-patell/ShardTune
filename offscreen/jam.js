import { SignalClient } from '../utils/signal.js';

let role = null;
let roomCode = null;
let signal = null;
let peers = new Map();
let myName = '';
let syncInterval = null;

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRoomCode() {
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => CHARS[b % CHARS.length]).join('');
}

function generateShortId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(36)).join('');
}

function sendToBg(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function broadcastToAllPeers(msg) {
  const json = JSON.stringify(msg);
  for (const [, peer] of peers) {
    if (peer.channel?.readyState === 'open') {
      try { peer.channel.send(json); } catch {}
    }
  }
}

function getPeerList() {
  const list = [{ name: myName, isHost: role === 'host' }];
  for (const [, peer] of peers) {
    if (peer.name) list.push({ name: peer.name, isHost: peer.isHost || false });
  }
  return list;
}

function broadcastPeerList() {
  const list = getPeerList();
  broadcastToAllPeers({ type: 'peers', peers: list });
  sendToBg({ action: 'jam-peers-updated', data: list });
}

function handlePeerDisconnect(peerId) {
  const peer = peers.get(peerId);
  if (!peer) return;
  const name = peer.name;
  peer.channel?.close();
  peer.conn?.close();
  peers.delete(peerId);
  broadcastPeerList();
  sendToBg({ action: 'jam-peer-disconnected', peerId, name });
}

function setupDataChannel(channel, remotePeerId) {
  const peer = peers.get(remotePeerId);
  if (peer) peer.channel = channel;

  channel.onopen = () => {
    channel.send(JSON.stringify({ type: 'hello', name: myName, isHost: role === 'host' }));
    broadcastPeerList();
    sendToBg({ action: 'jam-peer-connected', peerId: remotePeerId });
  };

  channel.onmessage = (e) => {
    try {
      handleDataMessage(JSON.parse(e.data), remotePeerId);
    } catch {}
  };

  channel.onclose = () => handlePeerDisconnect(remotePeerId);
}

function setupPeerConnection(conn, remotePeerId) {
  if (!peers.has(remotePeerId)) {
    peers.set(remotePeerId, { conn, channel: null, name: '', isHost: false });
  } else {
    peers.get(remotePeerId).conn = conn;
  }

  conn.onicecandidate = (e) => {
    if (e.candidate) {
      signal?.send('CANDIDATE', remotePeerId, { candidate: e.candidate });
    }
  };

  conn.ondatachannel = (e) => setupDataChannel(e.channel, remotePeerId);

  conn.onconnectionstatechange = () => {
    const state = conn.connectionState;
    if (state === 'disconnected' || state === 'failed') {
      handlePeerDisconnect(remotePeerId);
    }
  };
}

function handleDataMessage(msg, fromPeerId) {
  switch (msg.type) {
    case 'hello': {
      const peer = peers.get(fromPeerId);
      if (peer) {
        peer.name = msg.name;
        peer.isHost = msg.isHost || false;
      }
      broadcastPeerList();
      break;
    }
    case 'state':
      if (role === 'guest') {
        sendToBg({ action: 'jam-sync-state', data: msg.data });
      }
      break;
    case 'action':
      if (role === 'guest') {
        sendToBg({ action: 'jam-sync-action', data: msg });
      }
      break;
    case 'queue-add':
      if (role === 'host') {
        sendToBg({ action: 'jam-queue-request', data: msg });
      }
      break;
    case 'peers':
      sendToBg({ action: 'jam-peers-updated', data: msg.peers });
      break;
    case 'end':
      sendToBg({ action: 'jam-session-ended' });
      cleanup();
      break;
    case 'leave':
      handlePeerDisconnect(fromPeerId);
      break;
  }
}

async function handleCreate(name) {
  try {
    myName = name;
    role = 'host';
    roomCode = generateRoomCode();
    const peerId = `shardtune-${roomCode}`;

    signal = new SignalClient(peerId);

    signal.onOffer = async (src, payload) => {
      const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      setupPeerConnection(conn, src);

      try {
        await conn.setRemoteDescription(payload.sdp);
        const answer = await conn.createAnswer();
        await conn.setLocalDescription(answer);
        signal.send('ANSWER', src, { sdp: conn.localDescription });
      } catch (e) {
        console.warn('[ShardTune Jam] Failed to handle offer:', e.message);
        conn.close();
        peers.delete(src);
      }
    };

    signal.onCandidate = (src, payload) => {
      const peer = peers.get(src);
      peer?.conn?.addIceCandidate(payload.candidate).catch(() => {});
    };

    signal.onError = (err) => {
      sendToBg({ action: 'jam-error', data: err.message });
    };

    await signal.connect();

    syncInterval = setInterval(() => {
      sendToBg({ action: 'jam-request-state' });
    }, 10000);

    return { ok: true, roomCode };
  } catch (e) {
    cleanup();
    return { ok: false, error: e.message };
  }
}

async function handleJoin(code, name) {
  try {
    myName = name;
    role = 'guest';
    roomCode = code.toUpperCase();
    const hostPeerId = `shardtune-${roomCode}`;
    const myPeerId = `shardtune-${roomCode}-${generateShortId()}`;

    signal = new SignalClient(myPeerId);

    signal.onAnswer = async (src, payload) => {
      const peer = peers.get(src);
      if (peer?.conn) {
        try {
          await peer.conn.setRemoteDescription(payload.sdp);
        } catch (e) {
          console.warn('[ShardTune Jam] Failed to set answer:', e.message);
        }
      }
    };

    signal.onCandidate = (src, payload) => {
      const peer = peers.get(src);
      peer?.conn?.addIceCandidate(payload.candidate).catch(() => {});
    };

    signal.onExpire = () => {
      sendToBg({ action: 'jam-error', data: 'Session not found. Check the room code.' });
      cleanup();
    };

    signal.onError = (err) => {
      sendToBg({ action: 'jam-error', data: err.message });
    };

    await signal.connect();

    const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peers.set(hostPeerId, { conn, channel: null, name: '', isHost: true });

    conn.onicecandidate = (e) => {
      if (e.candidate) {
        signal.send('CANDIDATE', hostPeerId, { candidate: e.candidate });
      }
    };

    conn.onconnectionstatechange = () => {
      const state = conn.connectionState;
      if (state === 'disconnected' || state === 'failed') {
        sendToBg({ action: 'jam-session-ended', data: { reason: 'Connection lost' } });
        cleanup();
      }
    };

    const channel = conn.createDataChannel('jam', { ordered: true });
    setupDataChannel(channel, hostPeerId);

    const offer = await conn.createOffer();
    await conn.setLocalDescription(offer);
    signal.send('OFFER', hostPeerId, { sdp: conn.localDescription });

    return { ok: true, roomCode };
  } catch (e) {
    cleanup();
    return { ok: false, error: e.message };
  }
}

function cleanup() {
  broadcastToAllPeers({ type: role === 'host' ? 'end' : 'leave' });

  for (const [, peer] of peers) {
    peer.channel?.close();
    peer.conn?.close();
  }
  peers.clear();

  signal?.close();
  signal = null;

  if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }

  role = null;
  roomCode = null;
  myName = '';
}

async function handleLeave() {
  cleanup();
  sendToBg({ action: 'jam-ended' });
  return { ok: true };
}

function getJamState() {
  return {
    active: role !== null,
    role,
    roomCode,
    peerCount: peers.size,
    peers: getPeerList()
  };
}

function broadcastPlaybackState(state) {
  if (role !== 'host') return;
  broadcastToAllPeers({
    type: 'state',
    data: {
      trackUri: state.item?.uri,
      trackName: state.item?.name,
      trackArtist: state.item?.artists?.map(a => a.name).join(', '),
      albumArt: state.item?.album?.images?.[0]?.url,
      positionMs: state.progress_ms,
      durationMs: state.item?.duration_ms,
      isPlaying: state.is_playing,
      timestamp: Date.now()
    }
  });
}

function broadcastAction(data) {
  if (role !== 'host') return;
  broadcastToAllPeers({ type: 'action', ...data });
}

function broadcastQueueAdd(data) {
  broadcastToAllPeers({ type: 'queue-add', ...data });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    case 'jam-create':
      handleCreate(msg.name).then(sendResponse);
      return true;
    case 'jam-join':
      handleJoin(msg.code, msg.name).then(sendResponse);
      return true;
    case 'jam-leave':
      handleLeave().then(sendResponse);
      return true;
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
