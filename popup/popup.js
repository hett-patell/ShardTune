import { esc, safeImg, fmt } from '../utils/dom.js';

let port = null;
let portAlive = false;
let shouldReconnect = true;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;

function connectPort() {
  if (!shouldReconnect) return;
  port = chrome.runtime.connect({ name: 'popup' });
  portAlive = true;

  port.onDisconnect.addListener(() => {
    portAlive = false;
    if (shouldReconnect) {
      setTimeout(connectPort, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    }
  });

  port.onMessage.addListener(msg => {
    // A delivered message means the connection is healthy — reset the backoff
    // here, NOT on connect (which fires even when the worker is unreachable).
    reconnectDelay = 1000;
    handleMessage(msg);
  });
}

let rateLimitedUntil = 0;

function send(msg) {
  if (Date.now() < rateLimitedUntil) {
    console.warn('[ShardTune Popup] Rate limited, skipping:', msg.action);
    return;
  }
  if (portAlive && port) {
    try { port.postMessage(msg); } catch (e) { 
      console.error('[ShardTune Popup] Send failed:', e);
      portAlive = false; 
    }
  } else {
    console.warn('[ShardTune Popup] Port not alive:', { portAlive, port: !!port });
  }
}

connectPort();

const $ = id => document.getElementById(id);

const els = {
  authScreen: $('auth-screen'),
  playerScreen: $('player-screen'),
  authBtn: $('auth-btn'),
  authError: $('auth-error'),
  setupSection: $('setup-section'),
  clientIdInput: $('client-id-input'),
  saveIdBtn: $('save-id-btn'),
  redirectUri: $('redirect-uri'),
  openSpotifyDev: $('open-spotify-dev'),
  greetingLabel: $('greeting-label'),
  greetingNameLg: $('greeting-name-lg'),
  settingsBtn: $('settings-btn'),
  albumArt: $('album-art'),
  artPlaceholder: $('art-placeholder'),
  trackName: $('track-name'),
  trackSub: $('track-sub'),
  deviceTag: $('device-tag'),
  deviceLabel: $('device-label'),
  likeBtn: $('like-btn'),
  copyBtn: $('copy-btn'),
  waveform: $('waveform'),
  progressTrack: $('progress-track'),
  progressFill: $('progress-fill'),
  timeCurrent: $('time-current'),
  timeTotal: $('time-total'),
  playBtn: $('play-btn'),
  iconPlay: $('icon-play'),
  iconPause: $('icon-pause'),
  prevBtn: $('prev-btn'),
  nextBtn: $('next-btn'),
  shuffleBtn: $('shuffle-btn'),
  repeatBtn: $('repeat-btn'),
  volTrack: $('vol-track'),
  volFill: $('vol-fill'),
  volPct: $('vol-pct'),
  queueList: $('queue-list'),
  queueLabel: $('queue-label'),
  playlistsList: $('playlists-list'),
  statMin: $('stat-min'),
  statSkips: $('stat-skips'),
  statArtists: $('stat-artists'),
  statStreak: $('stat-streak'),
  sleepBtn: $('sleep-btn'),
  sleepDropdown: $('sleep-dropdown'),
  sleepBadge: $('sleep-badge'),
  sleepCountdown: $('sleep-countdown'),
  dashboardBtn: $('dashboard-btn'),
  logoutBtn: $('logout-btn'),
  deviceTrigger: $('device-trigger'),
  deviceDropdown: $('device-dropdown'),
  settingsScreen: $('settings-screen'),
  settingsBack: $('settings-back'),
  sClientId: $('s-client-id'),
  sSaveId: $('s-save-id'),
  sRedirectUri: $('s-redirect-uri'),
  sClearData: $('s-clear-data'),
  notifLiked: $('notif-liked'),
  notifFriends: $('notif-friends'),
  notifFocus: $('notif-focus'),
  linkGithub: $('link-github'),
  linkWeb: $('link-web'),
  shortcutsList: $('shortcuts-list'),
  sConfigureShortcuts: $('s-configure-shortcuts'),
  sCheckUpdate: $('s-check-update'),
  updateStatus: $('update-status'),
  sAboutVer: $('s-about-ver'),
};

let currentState = null;
let currentTrackUri = null;
let currentTrackId = null;
let isTrackSaved = false;
let sleepInterval = null;
let sleepExpiresAt = null;
let authenticated = false;
let userName = null;
let lastDeviceId = null;
let availableDeviceList = [];
let progressTimer = null;

// --- Greeting ---

function getGreeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Good Night';
  if (h < 12) return 'Good Morning';
  if (h < 17) return 'Good Afternoon';
  if (h < 21) return 'Good Evening';
  return 'Good Night';
}

function updateGreeting() {
  const greeting = getGreeting();
  if (userName) {
    els.greetingLabel.textContent = greeting;
    els.greetingNameLg.textContent = userName.split(' ')[0];
  } else {
    els.greetingLabel.textContent = '';
    els.greetingNameLg.textContent = greeting;
  }
}

// Load cached name immediately so the greeting shows your name without a flash
chrome.storage.local.get('displayName', r => {
  if (r.displayName && !userName) {
    userName = r.displayName;
    updateGreeting();
  }
});

// Decide the initial screen from the stored session so the popup doesn't flash
// "Connect Spotify" on a cold service worker. A stored token (or refresh token)
// means we're logged in — show the player right away; if the token turns out to
// be dead, the background's auth-required will bounce us back to the auth screen.
chrome.storage.local.get(['access_token', 'refresh_token'], r => {
  if ((r.access_token || r.refresh_token) && !authenticated) {
    authenticated = true;
    showPlayer();
  }
});

// --- Setup ---

const REDIRECT_URI = 'http://127.0.0.1:43827/spotify/callback';
els.redirectUri.textContent = REDIRECT_URI;

els.redirectUri.addEventListener('click', () => {
  navigator.clipboard.writeText(REDIRECT_URI);
  els.redirectUri.style.color = 'var(--green)';
  setTimeout(() => { els.redirectUri.style.color = ''; }, 1200);
});

els.openSpotifyDev.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://developer.spotify.com/dashboard' });
});

send({ action: 'check-client-id' });
els.sAboutVer.textContent = `v${chrome.runtime.getManifest().version}`;

els.saveIdBtn.addEventListener('click', () => {
  const id = els.clientIdInput.value.trim();
  if (!id || id.length < 10) {
    els.authError.textContent = 'Invalid Client ID';
    els.authError.classList.remove('hidden');
    return;
  }
  els.authError.classList.add('hidden');
  send({ action: 'set-client-id', clientId: id });
});

els.clientIdInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') els.saveIdBtn.click();
});

function showSetupDone() {
  els.setupSection.classList.add('configured');
  els.authBtn.classList.remove('hidden');
}

els.settingsBtn.addEventListener('click', () => {
  els.playerScreen.classList.add('hidden');
  els.settingsScreen.classList.remove('hidden');
  send({ action: 'get-notif-settings' });
  loadShortcuts();
});

els.settingsBack.addEventListener('click', () => {
  els.settingsScreen.classList.add('hidden');
  els.playerScreen.classList.remove('hidden');
});

// --- Settings: Redirect URI ---

els.sRedirectUri.textContent = REDIRECT_URI;
els.sRedirectUri.addEventListener('click', () => {
  navigator.clipboard.writeText(REDIRECT_URI);
  showToast('Copied to clipboard');
});

// --- Settings: Client ID ---

els.sSaveId.addEventListener('click', () => {
  const id = els.sClientId.value.trim();
  if (!id || id.length < 10) {
    showToast('Invalid Client ID');
    return;
  }
  send({ action: 'set-client-id', clientId: id });
  showToast('Client ID saved');
});

els.sClientId.addEventListener('keydown', e => {
  if (e.key === 'Enter') els.sSaveId.click();
});

// --- Settings: Notifications ---

[els.notifLiked, els.notifFriends, els.notifFocus].forEach(cb => {
  cb.addEventListener('change', () => {
    send({
      action: 'set-notif-settings',
      settings: {
        liked: els.notifLiked.checked,
        friends: els.notifFriends.checked,
        focus: els.notifFocus.checked
      }
    });
    showToast('Notification settings updated');
  });
});

// --- Settings: Clear Data ---

els.sClearData.addEventListener('click', () => {
  send({ action: 'clear-analytics' });
  showToast('Analytics data cleared');
});

// --- Settings: Links ---

els.linkGithub.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://github.com/ShardTune' });
});

els.linkWeb.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://networkshard.com' });
});

// --- Settings: Shortcuts ---

function loadShortcuts() {
  chrome.commands.getAll(commands => {
    els.shortcutsList.innerHTML = commands
      .filter(cmd => cmd.name !== '_execute_action')
      .map(cmd => {
        const key = cmd.shortcut || 'Not set';
        const notSet = !cmd.shortcut;
        return `<div class="s-shortcut">
          <span>${esc(cmd.description || cmd.name)}</span>
          <kbd class="${notSet ? 's-kbd-unset' : ''}">${esc(key)}</kbd>
        </div>`;
      }).join('');
  });
}

els.sConfigureShortcuts.addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// --- Check for Updates ---

els.sCheckUpdate.addEventListener('click', () => {
  els.sCheckUpdate.textContent = 'Checking...';
  els.sCheckUpdate.disabled = true;
  send({ action: 'check-for-updates' });
});

function showUpdateStatus(updateInfo) {
  els.updateStatus.classList.remove('hidden');
  if (updateInfo.available) {
    els.updateStatus.innerHTML = `
      <div style="color:var(--green);margin-bottom:4px">Update available: v${esc(updateInfo.remoteVersion)}</div>
      <a href="${esc(updateInfo.releaseUrl)}" target="_blank" style="color:var(--green);text-decoration:underline;font-size:10px">View on GitHub</a>
    `;
  } else {
    els.updateStatus.innerHTML = '<div style="color:var(--fg-faint)">You\'re on the latest version</div>';
  }
  els.sCheckUpdate.textContent = 'Check for Updates';
  els.sCheckUpdate.disabled = false;
}

// --- Search ---

const searchInput = $('search-input');
const searchResults = $('search-results');
let searchTimeout = null;
let searchSeq = 0;
let lastRenderedSeq = 0;

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  const query = searchInput.value.trim();
  if (query.length < 2) {
    searchResults.classList.add('hidden');
    return;
  }
  searchTimeout = setTimeout(() => {
    searchSeq++;
    send({ action: 'search', query, types: ['track', 'artist'], limit: 8, seq: searchSeq });
  }, 300);
});

searchInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    searchInput.value = '';
    searchResults.classList.add('hidden');
  }
});

document.addEventListener('click', e => {
  if (!searchInput.contains(e.target) && !searchResults.contains(e.target)) {
    searchResults.classList.add('hidden');
  }
});

function renderSearchResults(data) {
  if (!data?.tracks?.items?.length && !data?.artists?.items?.length) {
    searchResults.innerHTML = '<div style="padding:12px;text-align:center;color:var(--fg-faint);font-size:10px">No results found</div>';
    searchResults.classList.remove('hidden');
    return;
  }

  let html = '';

  // Artists
  if (data.artists?.items?.length) {
    html += data.artists.items.slice(0, 3).map(a => {
      const img = a.images?.[2]?.url || a.images?.[0]?.url || '';
      return `<div class="search-result-item" data-uri="${esc(a.uri)}" data-type="artist">
        <div class="search-result-art round">${img ? `<img src="${safeImg(img)}" alt="">` : ''}</div>
        <div class="search-result-info">
          <div class="search-result-name">${esc(a.name)}</div>
          <div class="search-result-sub">Artist</div>
        </div>
      </div>`;
    }).join('');
  }

  // Tracks
  if (data.tracks?.items?.length) {
    html += data.tracks.items.slice(0, 5).map(t => {
      const img = t.album?.images?.[2]?.url || '';
      const artist = t.artists?.map(a => a.name).join(', ') || '';
      return `<div class="search-result-item" data-uri="${esc(t.uri)}" data-type="track">
        <div class="search-result-art">${img ? `<img src="${safeImg(img)}" alt="">` : ''}</div>
        <div class="search-result-info">
          <div class="search-result-name">${esc(t.name)}</div>
          <div class="search-result-sub">${esc(artist)}</div>
        </div>
        <div class="search-result-actions">
          <button class="search-action-btn" data-action="queue" data-uri="${esc(t.uri)}" title="Add to queue">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>
          </button>
        </div>
      </div>`;
    }).join('');
  }

  searchResults.innerHTML = html;
  searchResults.classList.remove('hidden');

  // Click handlers
  searchResults.querySelectorAll('.search-result-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.search-action-btn')) return;
      const uri = el.dataset.uri;
      const type = el.dataset.type;
      if (!uri) return;
      // Play based on type - artists need context_uri
      if (type === 'artist') {
        send({ action: 'play', contextUri: uri });
      } else {
        send({ action: 'play', uris: [uri] });
        const trackId = uri.split(':').pop();
        if (trackId) {
          currentTrackId = trackId;
          isTrackSaved = false;
          updateLikeButton();
          checkIfTrackSaved(trackId);
        }
      }
      searchInput.value = '';
      searchResults.classList.add('hidden');
      els.iconPlay.classList.add('hidden');
      els.iconPause.classList.remove('hidden');
      startProgressTimer();
    });
  });

  searchResults.querySelectorAll('.search-action-btn[data-action="queue"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const uri = btn.dataset.uri;
      if (!uri) return;
      send({ action: 'add-to-queue', uri });
      showToast('Added to queue');
    });
  });
}

// --- Waveform ---

const BAR_COUNT = 32;
const barHeights = Array.from({ length: BAR_COUNT }, (_, i) => 3 + ((i * 7 + 5) % 18));
let cachedBars = [];

function initWaveform() {
  els.waveform.innerHTML = '';
  cachedBars = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.setProperty('--d', `${i * 0.06}s`);
    bar.style.setProperty('--h', `${barHeights[i]}px`);
    els.waveform.appendChild(bar);
    cachedBars.push(bar);
  }
}

function updateWaveform(state) {
  if (!cachedBars.length) return;

  const progress = state?.progress_ms || 0;
  const duration = state?.item?.duration_ms || 1;
  const pct = progress / duration;
  const activeCount = Math.floor(pct * BAR_COUNT);
  const isPlaying = state?.is_playing;

  cachedBars.forEach((bar, i) => {
    bar.classList.toggle('active', i < activeCount);
    bar.classList.toggle('playing', isPlaying && i < activeCount);
    if (!isPlaying) {
      bar.style.height = `${barHeights[i]}px`;
    }
  });
}

initWaveform();

// --- Auth ---

els.authBtn.addEventListener('click', () => {
  els.authBtn.textContent = 'Connecting...';
  els.authBtn.disabled = true;
  els.authError.classList.add('hidden');
  send({ action: 'authenticate' });
});

function showAuth() {
  els.authScreen.classList.remove('hidden');
  els.playerScreen.classList.add('hidden');
  els.settingsScreen.classList.add('hidden');
  authenticated = false;
  stopProgressTimer();
}

let playerDataRequested = false;

function showPlayer() {
  if (!authenticated) return;
  if (!els.settingsScreen.classList.contains('hidden')) return;
  els.authScreen.classList.add('hidden');
  els.playerScreen.classList.remove('hidden');
  updateGreeting();
  if (!playerDataRequested) {
    playerDataRequested = true;
    send({ action: 'get-queue' });
    setTimeout(() => send({ action: 'get-sleep' }), 200);
    setTimeout(() => send({ action: 'get-profile' }), 400);
    setTimeout(() => send({ action: 'get-playlists' }), 600);
  }
}

function showAuthError(message) {
  els.authBtn.textContent = 'Connect Spotify';
  els.authBtn.disabled = false;
  els.authError.textContent = typeof message === 'string' ? message : (message?.message || 'Authentication failed');
  els.authError.classList.remove('hidden');
}

// --- Progress Timer (smooth local interpolation between polls) ---

function startProgressTimer() {
  stopProgressTimer();
  progressTimer = setInterval(() => {
    if (!currentState?.is_playing || !currentState?.item) return;
    const duration = currentState.item.duration_ms || 1;
    currentState.progress_ms = Math.min(currentState.progress_ms + 1000, duration);
    const pct = (currentState.progress_ms / duration) * 100;
    els.progressFill.style.width = `${pct}%`;
    els.timeCurrent.textContent = fmt(currentState.progress_ms);
    updateWaveform(currentState);
  }, 1000);
}

function stopProgressTimer() {
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
}

// --- State Rendering ---

function renderState(state, availableDevices) {
  if (!state || !state.item) {
    els.trackName.textContent = 'Not playing';
    const devices = availableDevices || [];
    availableDeviceList = devices;
    if (devices.length > 0) {
      const active = devices.find(d => d.is_active) || devices[0];
      lastDeviceId = active.id;
      const label = devices.length > 1
        ? `${active.name} + ${devices.length - 1} more`
        : active.name;
      els.trackSub.textContent = `Ready on ${label}`;
      els.deviceTag.classList.remove('hidden');
      els.deviceLabel.textContent = active.name;
    } else {
      availableDeviceList = [];
      els.trackSub.textContent = 'Open Spotify on a device';
      els.deviceTag.classList.add('hidden');
    }
    els.albumArt.classList.add('hidden');
    els.artPlaceholder.classList.remove('hidden');
    els.copyBtn.classList.add('hidden');
    els.deviceTrigger.classList.remove('playing');
    els.volTrack.parentElement.classList.remove('disabled');
    els.volFill.style.width = '0%';
    els.volPct.textContent = '--';
    els.progressFill.style.width = '0%';
    els.timeCurrent.textContent = '0:00';
    els.timeTotal.textContent = '0:00';
    updateWaveform(null);
    stopProgressTimer();
    return;
  }

  const track = state.item;

  if (currentState?.item?.id === track.id && state.is_playing) {
    const drift = Math.abs((currentState.progress_ms || 0) - (state.progress_ms || 0));
    if (drift < 2000) {
      state.progress_ms = currentState.progress_ms;
    }
  }

  currentState = state;
  currentTrackUri = track.external_urls?.spotify || null;
  
  // Check if track changed and update like button + queue
  if (track.id !== currentTrackId) {
    currentTrackId = track.id;
    isTrackSaved = false;
    els.likeBtn.classList.remove('liked');
    els.likeBtn.classList.remove('hidden');
    checkIfTrackSaved(track.id);
    send({ action: 'get-queue' });
  }

  els.trackName.textContent = track.name || 'Unknown';

  const artists = track.artists?.map(a => a.name).join(', ') || 'Unknown';
  const album = track.album?.name || '';
  els.trackSub.textContent = album ? `${artists} · ${album}` : artists;

  const artUrl = track.album?.images?.[1]?.url || track.album?.images?.[0]?.url;
  if (artUrl) {
    if (els.albumArt.src !== artUrl) {
      els.albumArt.src = artUrl;
    }
    els.albumArt.classList.remove('hidden');
    els.artPlaceholder.classList.add('hidden');
  } else {
    els.albumArt.classList.add('hidden');
    els.artPlaceholder.classList.remove('hidden');
  }

  if (state.device) {
    lastDeviceId = state.device.id;
    els.deviceTag.classList.remove('hidden');
    els.deviceLabel.textContent = state.device.name;
  } else {
    els.deviceTag.classList.add('hidden');
  }

  els.copyBtn.classList.toggle('hidden', !currentTrackUri);

  els.iconPlay.classList.toggle('hidden', state.is_playing);
  els.iconPause.classList.toggle('hidden', !state.is_playing);

  const progress = state.progress_ms || 0;
  const duration = track.duration_ms || 1;
  const pct = (progress / duration) * 100;
  els.progressFill.style.width = `${pct}%`;
  els.timeCurrent.textContent = fmt(progress);
  els.timeTotal.textContent = fmt(duration);

  if (state.device) {
    const canVolume = state.device.supports_volume !== false;
    els.volTrack.parentElement.classList.toggle('disabled', !canVolume);
    if (canVolume) {
      const vol = state.device.volume_percent ?? 0;
      els.volFill.style.width = `${vol}%`;
      els.volPct.textContent = `${vol}%`;
    } else {
      els.volFill.style.width = '0%';
      els.volPct.textContent = '--';
    }
  } else {
    // No device object on this tick — don't leave a stale disabled slider.
    els.volTrack.parentElement.classList.remove('disabled');
  }

  els.deviceTrigger.classList.toggle('playing', state.is_playing);
  const shuffled = state.shuffle_state === true;
  els.shuffleBtn.classList.toggle('active', shuffled);
  // Spotify's queue API can't expose true shuffle order — flag it as approximate.
  els.queueLabel.textContent = shuffled ? 'Up Next · approximate' : 'Up Next';
  els.repeatBtn.classList.toggle('active', state.repeat_state !== 'off');
  els.repeatBtn.classList.toggle('repeat-one', state.repeat_state === 'track');
  els.repeatBtn.title = `Repeat: ${state.repeat_state || 'off'}`;

  updateWaveform(state);

  if (state.is_playing) {
    startProgressTimer();
  } else {
    stopProgressTimer();
  }
}

function renderAnalytics(data) {
  if (!data) return;
  const { session, streak } = data;

  if (session) {
    els.statMin.textContent = Math.round(session.totalListenMs / 60000);
    els.statSkips.textContent = session.skips;
    els.statArtists.textContent = session.artistCount;
  }

  if (streak) {
    els.statStreak.textContent = `${streak.count}d`;
  }
}

function renderQueue(data) {
  // Spotify's /me/player/queue is the only public source for "up next", and it
  // can echo the current track and return consecutive duplicates. Clean those
  // out. (Note: the API does NOT expose true shuffle order — that order isn't
  // retrievable, so this list is best-effort under shuffle/radio.)
  const currentId = data?.currently_playing?.id || currentState?.item?.id || null;
  const tracks = [];
  for (const t of (data?.queue || [])) {
    if (!t || !t.id || t.id === currentId) continue;
    if (tracks.length && tracks[tracks.length - 1].id === t.id) continue;
    tracks.push(t);
    if (tracks.length >= 3) break;
  }

  if (!tracks.length) {
    els.queueList.innerHTML = `
      <div class="q-item">
        <span class="q-idx" style="color:var(--fg-faint)">Queue empty</span>
      </div>`;
    return;
  }

  els.queueList.innerHTML = tracks.map((t, i) => {
    const artUrl = t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || '';
    const artHtml = artUrl ? `<img src="${safeImg(artUrl)}" alt="">` : '';
    const dur = fmt(t.duration_ms || 0);
    const artists = t.artists || [];
    const artist = artists.length > 1 ? `${artists[0].name}...` : (artists[0]?.name || '');
    const uri = t.uri || '';
    const contextUri = t.album?.uri || '';
    const trackData = JSON.stringify({ name: t.name || '', artist, artUrl, durationMs: t.duration_ms || 0 });
    return `
      <div class="q-item" data-uri="${esc(uri)}" data-id="${esc(t.id || '')}" data-context-uri="${esc(contextUri)}" data-track="${esc(trackData)}">
        <span class="q-idx">${String(i + 1).padStart(2, '0')}</span>
        <div class="q-art">${artHtml}</div>
        <div class="q-info">
          <div class="q-name">${esc(t.name || '')}</div>
          <div class="q-artist">${esc(artist)}</div>
        </div>
        <span class="q-dur">${dur}</span>
      </div>`;
  }).join('');

  els.queueList.querySelectorAll('.q-item[data-uri]').forEach(el => {
    el.addEventListener('click', () => {
      const uri = el.dataset.uri;
      const contextUri = el.dataset.contextUri;
      if (!uri) return;
      if (contextUri) {
        send({ action: 'play', contextUri, offset: { uri } });
      } else {
        send({ action: 'play', uris: [uri] });
      }
      // Optimistic UI update
      try {
        const track = JSON.parse(el.dataset.track);
        els.trackName.textContent = track.name;
        els.trackSub.textContent = track.artist;
        if (track.artUrl) {
          els.albumArt.src = track.artUrl;
          els.albumArt.classList.remove('hidden');
          els.artPlaceholder.classList.add('hidden');
        }
        els.progressFill.style.width = '0%';
        els.timeCurrent.textContent = '0:00';
        els.timeTotal.textContent = fmt(track.durationMs);
        currentState = { is_playing: true, progress_ms: 0, item: { duration_ms: track.durationMs } };
        const queueTrackId = el.dataset.id;
        if (queueTrackId) {
          currentTrackId = queueTrackId;
          isTrackSaved = false;
          updateLikeButton();
          checkIfTrackSaved(queueTrackId);
        }
      } catch {}
      els.iconPlay.classList.add('hidden');
      els.iconPause.classList.remove('hidden');
      startProgressTimer();
    });
  });
}

// --- Playlists ---

function renderPlaylists(data) {
  
  if (!data) {
    els.playlistsList.innerHTML = '<div style="font-size:10px;color:var(--fg-faint);padding:4px 0;grid-column:1/-1">No data received</div>';
    return;
  }
  
  if (!data.items) {
    els.playlistsList.innerHTML = '<div style="font-size:10px;color:var(--fg-faint);padding:4px 0;grid-column:1/-1">No items in response</div>';
    return;
  }
  
  if (!data.items.length) {
    els.playlistsList.innerHTML = '<div style="font-size:10px;color:var(--fg-faint);padding:4px 0;grid-column:1/-1">No playlists found</div>';
    return;
  }

  const html = data.items.slice(0, 8).map(p => {
    const artUrl = p.images?.[2]?.url || p.images?.[0]?.url || '';
    const artHtml = artUrl ? `<img src="${safeImg(artUrl)}" alt="">` : '';
    const contextUri = p.uri || '';
    return `
      <div class="playlist-item" data-context-uri="${esc(contextUri)}" title="${esc(p.name || '')}">
        <div class="playlist-art">${artHtml}</div>
        <div class="playlist-info">
          <div class="playlist-name">${esc(p.name || '')}</div>
        </div>
      </div>`;
  }).join('');
  
  els.playlistsList.innerHTML = html;

  els.playlistsList.querySelectorAll('.playlist-item[data-context-uri]').forEach(el => {
    el.addEventListener('click', () => {
      const contextUri = el.dataset.contextUri;
      if (!contextUri) return;
      send({ action: 'play-playlist', contextUri, deviceId: lastDeviceId });
      els.iconPlay.classList.add('hidden');
      els.iconPause.classList.remove('hidden');
      startProgressTimer();
    });
  });
}

// --- Transport Controls ---

els.playBtn.addEventListener('click', () => {
  if (currentState?.is_playing) {
    send({ action: 'pause' });
    currentState.is_playing = false;
    els.iconPlay.classList.remove('hidden');
    els.iconPause.classList.add('hidden');
    stopProgressTimer();
  } else if (!currentState?.item && availableDeviceList.length > 1) {
    showPlayDevicePicker();
  } else {
    playOnDevice(lastDeviceId || undefined);
  }
});

function playOnDevice(deviceId) {
  send({ action: 'play', deviceId });
  if (currentState) currentState.is_playing = true;
  els.iconPlay.classList.add('hidden');
  els.iconPause.classList.remove('hidden');
  els.deviceDropdown.classList.remove('open');
  startProgressTimer();
}

function showPlayDevicePicker() {
  els.deviceDropdown.innerHTML = availableDeviceList.map(d => `
    <div class="device-option" data-play-id="${esc(d.id)}">
      <div>
        <div class="d-name">${esc(d.name)}</div>
        <div class="d-type">${esc(d.type)} · Play here</div>
      </div>
    </div>`).join('');

  els.deviceDropdown.querySelectorAll('.device-option[data-play-id]').forEach(el => {
    el.addEventListener('click', () => {
      lastDeviceId = el.dataset.playId;
      playOnDevice(el.dataset.playId);
    });
  });

  els.deviceDropdown.classList.add('open');
}

els.nextBtn.addEventListener('click', () => send({ action: 'next' }));
els.prevBtn.addEventListener('click', () => send({ action: 'previous' }));

els.shuffleBtn.addEventListener('click', () => {
  const newState = !(currentState?.shuffle_state === true);
  send({ action: 'shuffle', state: newState });
  els.shuffleBtn.classList.toggle('active', newState);
});

els.repeatBtn.addEventListener('click', () => {
  const modes = ['off', 'context', 'track'];
  const current = currentState?.repeat_state || 'off';
  const nextIdx = (modes.indexOf(current) + 1) % modes.length;
  const next = modes[nextIdx];
  send({ action: 'repeat', mode: next });
  els.repeatBtn.classList.toggle('active', next !== 'off');
  els.repeatBtn.classList.toggle('repeat-one', next === 'track');
  els.repeatBtn.title = `Repeat: ${next}`;
});

// --- Seek ---

els.progressTrack.addEventListener('click', e => {
  if (!currentState?.item) return;
  const rect = els.progressTrack.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const posMs = Math.round(pct * currentState.item.duration_ms);
  send({ action: 'seek', positionMs: posMs });
  currentState.progress_ms = posMs;
  els.progressFill.style.width = `${pct * 100}%`;
  els.timeCurrent.textContent = fmt(posMs);
});

// --- Volume ---

els.volTrack.addEventListener('click', e => {
  if (els.volTrack.parentElement.classList.contains('disabled')) return;
  const rect = els.volTrack.getBoundingClientRect();
  const pct = Math.round(((e.clientX - rect.left) / rect.width) * 100);
  const clamped = Math.max(0, Math.min(100, pct));
  send({ action: 'volume', percent: clamped });
  els.volFill.style.width = `${clamped}%`;
  els.volPct.textContent = `${clamped}%`;
});

// --- Copy Link ---

els.copyBtn.addEventListener('click', async () => {
  if (!currentTrackUri) return;
  try {
    await navigator.clipboard.writeText(currentTrackUri);
    els.copyBtn.classList.add('copied');
    setTimeout(() => els.copyBtn.classList.remove('copied'), 1500);
  } catch {}
});

// --- Like/Save Track ---

els.likeBtn.addEventListener('click', () => {
  if (!currentTrackId) return;
  send({ action: 'toggle-save', trackId: currentTrackId, saved: isTrackSaved });
});

function updateLikeButton() {
  els.likeBtn.classList.toggle('liked', isTrackSaved);
  els.likeBtn.title = isTrackSaved ? 'Remove from library' : 'Save to library';
}

function checkIfTrackSaved(trackId) {
  if (!trackId) return;
  send({ action: 'check-saved', trackId });
}

// --- Sleep Timer ---

els.sleepBtn.addEventListener('click', e => {
  e.stopPropagation();
  els.sleepDropdown.classList.toggle('open');
  els.deviceDropdown.classList.remove('open');
});

els.sleepDropdown.addEventListener('click', e => {
  const option = e.target.closest('.sleep-option');
  if (!option) return;
  const minutes = parseInt(option.dataset.minutes);
  send({ action: 'set-sleep', minutes });
  els.sleepDropdown.classList.remove('open');
});

const sleepCustomInput = $('sleep-custom-input');
const sleepCustomBtn = $('sleep-custom-btn');

function setCustomSleep() {
  const minutes = parseInt(sleepCustomInput.value);
  if (!minutes || minutes < 1 || minutes > 480) return;
  send({ action: 'set-sleep', minutes });
  els.sleepDropdown.classList.remove('open');
  sleepCustomInput.value = '';
}

sleepCustomBtn.addEventListener('click', e => {
  e.stopPropagation();
  setCustomSleep();
});

sleepCustomInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.stopPropagation();
    setCustomSleep();
  }
});

sleepCustomInput.addEventListener('click', e => e.stopPropagation());

function updateSleepBadge() {
  if (!sleepExpiresAt || Date.now() >= sleepExpiresAt) {
    els.sleepBadge.classList.remove('active');
    if (sleepInterval) { clearInterval(sleepInterval); sleepInterval = null; }
    return;
  }

  els.sleepBadge.classList.add('active');
  const remaining = Math.max(0, Math.ceil((sleepExpiresAt - Date.now()) / 60000));
  els.sleepCountdown.textContent = `${remaining}m`;
}

// --- Device Picker ---

els.deviceTrigger.addEventListener('click', () => {
  els.deviceDropdown.classList.toggle('open');
  els.sleepDropdown.classList.remove('open');
  if (els.deviceDropdown.classList.contains('open')) {
    send({ action: 'get-devices' });
  }
});

function renderDevices(data) {
  if (!data?.devices?.length) {
    els.deviceDropdown.innerHTML = `
      <div class="device-option">
        <div><div class="d-name" style="color:var(--fg-faint)">No devices found</div></div>
      </div>`;
    return;
  }

  els.deviceDropdown.innerHTML = data.devices.map(d => `
    <div class="device-option ${d.is_active ? 'active' : ''}" data-id="${esc(d.id)}">
      <div>
        <div class="d-name">${esc(d.name)}</div>
        <div class="d-type">${esc(d.type)}</div>
      </div>
    </div>`).join('');

  els.deviceDropdown.querySelectorAll('.device-option[data-id]').forEach(el => {
    el.addEventListener('click', () => {
      send({ action: 'transfer', deviceId: el.dataset.id });
      els.deviceDropdown.classList.remove('open');
    });
  });
}

// --- Dashboard ---

els.dashboardBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
});

// --- Logout ---

els.logoutBtn.addEventListener('click', () => {
  shouldReconnect = false;
  send({ action: 'logout' });
  userName = null;
  stopProgressTimer();
});

// --- Close dropdowns on outside click ---

document.addEventListener('click', e => {
  if (!els.sleepBtn.contains(e.target) && !els.sleepDropdown.contains(e.target)) {
    els.sleepDropdown.classList.remove('open');
  }
  if (!els.deviceTrigger.contains(e.target) && !els.deviceDropdown.contains(e.target)) {
    els.deviceDropdown.classList.remove('open');
  }
});

// --- Message Handling ---

function handleMessage(msg) {
  switch (msg.type) {
    case 'client-id-status':
      if (msg.data) showSetupDone();
      break;
    case 'client-id-saved':
      showSetupDone();
      break;
    case 'auth-success':
      authenticated = true;
      els.authBtn.textContent = 'Connect Spotify';
      els.authBtn.disabled = false;
      showPlayer();
      break;
    case 'auth-error':
      showAuthError(msg.data);
      break;
    case 'state':
      if (authenticated) showPlayer();
      renderState(msg.data, msg.devices);
      break;
    case 'analytics':
      renderAnalytics(msg.data);
      break;
    case 'queue':
      renderQueue(msg.data);
      break;
    case 'devices':
      renderDevices(msg.data);
      break;
    case 'profile': {
      const name = msg.data?.display_name || msg.data?.id;
      if (name) {
        userName = name;
        chrome.storage.local.set({ displayName: name });
        updateGreeting();
      }
      break;
    }
    case 'auth-required':
      showAuth();
      els.authBtn.textContent = 'Connect Spotify';
      els.authBtn.disabled = false;
      break;
    case 'sleep-set':
      sleepExpiresAt = msg.data?.expiresAt;
      updateSleepBadge();
      if (sleepInterval) clearInterval(sleepInterval);
      sleepInterval = setInterval(updateSleepBadge, 10000);
      break;
    case 'sleep-cleared':
    case 'sleep-fired':
      sleepExpiresAt = null;
      updateSleepBadge();
      break;
    case 'sleep-status':
      if (msg.data?.expiresAt && msg.data.expiresAt > Date.now()) {
        sleepExpiresAt = msg.data.expiresAt;
        updateSleepBadge();
        if (sleepInterval) clearInterval(sleepInterval);
        sleepInterval = setInterval(updateSleepBadge, 10000);
      }
      break;
    case 'notif-settings':
      if (msg.data) {
        els.notifLiked.checked = msg.data.liked !== false;
        els.notifFriends.checked = msg.data.friends !== false;
        els.notifFocus.checked = msg.data.focus !== false;
      }
      break;
    case 'saved-status':
      if (msg.data?.trackId === currentTrackId) {
        isTrackSaved = msg.data.saved;
        updateLikeButton();
        if (msg.data.toggled) {
          showToast(isTrackSaved ? 'Saved to library' : 'Removed from library');
        }
      }
      break;
    case 'playlists':
      renderPlaylists(msg.data);
      break;
    case 'update-info':
      showUpdateStatus(msg.data);
      break;
    case 'search-results':
      if (!msg.seq || msg.seq >= lastRenderedSeq) {
        lastRenderedSeq = msg.seq || 0;
        renderSearchResults(msg.data);
      }
      break;
    case 'queue-added':
      showToast('Added to queue');
      setTimeout(() => send({ action: 'get-queue' }), 500);
      break;
    case 'error': {
      const errMsg = typeof msg.data === 'string' ? msg.data : (msg.data?.message || 'Something went wrong');
      console.error('ShardTune:', errMsg);
      if (errMsg.includes('Rate limited')) {
        showToast('Rate limited by Spotify. Please wait.');
      } else {
        showToast(errMsg);
      }
      break;
    }
  }
}

// --- Toast ---

let toastTimer = null;

function showToast(message) {
  let el = document.querySelector('.s-toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 's-toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
}
