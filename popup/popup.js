let port = null;
let portAlive = false;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;

function connectPort() {
  port = chrome.runtime.connect({ name: 'popup' });
  portAlive = true;

  port.onDisconnect.addListener(() => {
    portAlive = false;
    setTimeout(connectPort, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  });

  port.onMessage.addListener(msg => {
    // A delivered message means the connection is healthy — reset the backoff
    // here, NOT on connect (which fires even when the worker is unreachable).
    reconnectDelay = 1000;
    handleMessage(msg);
  });
}

function send(msg) {
  if (portAlive && port) {
    try { port.postMessage(msg); } catch { portAlive = false; }
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
};

let currentState = null;
let currentTrackUri = null;
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
chrome.storage.local.get('display_name', r => {
  if (r.display_name && !userName) {
    userName = r.display_name;
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
          <span>${escapeHtml(cmd.description || cmd.name)}</span>
          <kbd class="${notSet ? 's-kbd-unset' : ''}">${escapeHtml(key)}</kbd>
        </div>`;
      }).join('');
  });
}

els.sConfigureShortcuts.addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

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

function showPlayer() {
  if (!authenticated) return;
  if (!els.settingsScreen.classList.contains('hidden')) return;
  els.authScreen.classList.add('hidden');
  els.playerScreen.classList.remove('hidden');
  updateGreeting();
  send({ action: 'get-queue' });
  send({ action: 'get-sleep' });
  send({ action: 'get-profile' });
}

function showAuthError(message) {
  els.authBtn.textContent = 'Connect Spotify';
  els.authBtn.disabled = false;
  els.authError.textContent = message;
  els.authError.classList.remove('hidden');
}

// --- Progress Timer (smooth local interpolation between polls) ---

function startProgressTimer() {
  stopProgressTimer();
  progressTimer = setInterval(() => {
    if (!currentState?.is_playing || !currentState?.item) return;
    currentState.progress_ms += 1000;
    const duration = currentState.item.duration_ms || 1;
    const pct = Math.min((currentState.progress_ms / duration) * 100, 100);
    els.progressFill.style.width = `${pct}%`;
    els.timeCurrent.textContent = formatTime(currentState.progress_ms);
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
  els.timeCurrent.textContent = formatTime(progress);
  els.timeTotal.textContent = formatTime(duration);

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
    const artUrl = t.album?.images?.[2]?.url || '';
    const artHtml = artUrl ? `<img src="${safeImg(artUrl)}" alt="">` : '';
    const dur = formatTime(t.duration_ms || 0);
    const artist = t.artists?.map(a => a.name).join(', ') || '';
    return `
      <div class="q-item">
        <span class="q-idx">${String(i + 1).padStart(2, '0')}</span>
        <div class="q-art">${artHtml}</div>
        <div class="q-info">
          <div class="q-name">${escapeHtml(t.name || '')}</div>
          <div class="q-artist">${escapeHtml(artist)}</div>
        </div>
        <span class="q-dur">${dur}</span>
      </div>`;
  }).join('');
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
    <div class="device-option" data-play-id="${escAttr(d.id)}">
      <div>
        <div class="d-name">${escapeHtml(d.name)}</div>
        <div class="d-type">${escapeHtml(d.type)} · Play here</div>
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
  send({ action: 'repeat', mode: modes[nextIdx] });
  els.repeatBtn.classList.toggle('active', modes[nextIdx] !== 'off');
  els.repeatBtn.title = `Repeat: ${modes[nextIdx]}`;
});

// --- Seek ---

els.progressTrack.addEventListener('click', e => {
  if (!currentState?.item) return;
  const rect = els.progressTrack.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  const posMs = Math.round(pct * currentState.item.duration_ms);
  send({ action: 'seek', positionMs: posMs });
  currentState.progress_ms = posMs;
  els.progressFill.style.width = `${pct * 100}%`;
  els.timeCurrent.textContent = formatTime(posMs);
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
    <div class="device-option ${d.is_active ? 'active' : ''}" data-id="${escAttr(d.id)}">
      <div>
        <div class="d-name">${escapeHtml(d.name)}</div>
        <div class="d-type">${escapeHtml(d.type)}</div>
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
        chrome.storage.local.set({ display_name: name });
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
      sleepExpiresAt = msg.data.expiresAt;
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
      if (msg.data.expiresAt && msg.data.expiresAt > Date.now()) {
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
    case 'error':
      console.error('ShardTune:', msg.data);
      break;
  }
}

// --- Helpers ---

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// Attribute-safe escape — also encodes quotes, which escapeHtml does NOT.
// Required for any value placed inside a quoted HTML attribute.
function escAttr(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Only allow https URLs into src="" — blocks javascript:/data: schemes and
// attribute breakout via a stray quote in the URL.
function safeImg(url) {
  return /^https:\/\//i.test(url || '') ? escAttr(url) : '';
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
