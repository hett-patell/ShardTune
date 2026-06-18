import { esc, safeImg, fmt } from '../utils/dom.js';
import { energyProxy } from '../utils/analytics.js';

const $ = id => document.getElementById(id);

// --- Theme: apply stored value + live-sync when changed in the popup ---
chrome.storage.local.get('theme', r => {
  document.documentElement.dataset.theme = r.theme || 'default';
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.theme) {
    document.documentElement.dataset.theme = changes.theme.newValue || 'default';
  }
});

let port = null;
let portAlive = false;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;

function connectPort() {
  port = chrome.runtime.connect({ name: 'dashboard' });
  portAlive = true;

  port.onDisconnect.addListener(() => {
    portAlive = false;
    setTimeout(connectPort, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  });

  port.onMessage.addListener(msg => {
    reconnectDelay = 1000;
    handleMessage(msg);
  });

  // Small delay to ensure port is fully connected before requesting data
  setTimeout(requestAll, 100);
}

function send(msg) {
  if (portAlive && port) {
    try { port.postMessage(msg); } catch { portAlive = false; }
  }
}

let currentState = null;
let analyticsData = null;
let historyData = null;

setLoadingStates();
connectPort();

function requestAll() {
  const actions = [
    'get-analytics',
    'get-devices',
    'get-history',
    'get-music-memory',
    'get-friends',
    'get-vibe-sync',
    'get-liked-songs'
  ];
  actions.forEach((action, i) => {
    setTimeout(() => send({ action }), i * 50);
  });
}

function setLoadingStates() {
  const l = '<div class="empty-panel">Loading...</div>';
  $('top-artists').innerHTML = l;
  $('top-tracks').innerHTML = l;
  $('listen-log').innerHTML = l;
  $('heatmap').innerHTML = l;
  $('device-list').innerHTML = l;
}

function safe(fn, label) {
  try { fn(); }
  catch (e) { console.error(`[ShardTune] ${label}:`, e); }
}

// --- Refresh ---

$('refresh-all').addEventListener('click', () => {
  setLoadingStates();
  requestAll();
});

// --- Messages ---

function handleMessage(msg) {
  switch (msg.type) {
    case 'auth-success':
      $('dash-auth')?.classList.add('hidden');
      $('dash-main')?.classList.remove('hidden');
      requestAll();
      break;
    case 'state':
      currentState = msg.data;
      safe(() => renderHero(msg.data), 'hero');
      break;
    case 'analytics':
      analyticsData = msg.data;
      safe(() => renderStats(msg.data), 'stats');
      if (!historyData || !hasApiData(historyData)) {
        if (msg.data.session?.energyHistory?.length) safe(() => renderEnergyChart(msg.data.session.energyHistory), 'energy-fb');
        if (msg.data.peakHours) safe(() => renderHeatmap(msg.data.peakHours), 'heatmap-fb');
        if (msg.data.session?.history?.length) safe(() => renderLog(msg.data.session.history), 'log-fb');
      }
      break;
    case 'history':
      historyData = msg.data;
      safe(() => renderEnergyChart(msg.data.energyCurve), 'energy');
      safe(() => renderHeatmap(msg.data.peakHours), 'heatmap');
      safe(() => renderTopArtists(msg.data.topArtists), 'artists');
      safe(() => renderTopTracks(msg.data.topTracks), 'tracks');
      safe(() => renderLog(msg.data.history), 'log');
      safe(() => renderSessionVibe(msg.data.energyCurve), 'vibe');
      safe(() => renderAlbumMosaic(msg.data.history, msg.data.topTracks), 'mosaic');
      // Use energy proxy for taste profile (audio-features deprecated)
      if (msg.data.topTracks?.length) {
        safe(() => renderTasteProfile(msg.data.topTracks), 'taste');
      }
      if (msg.data.errors?.length) {
        console.warn('[ShardTune]', msg.data.errors);
        showApiWarning(msg.data.errors);
      }
      break;
    case 'devices':
      safe(() => renderDevices(msg.data), 'devices');
      break;
    case 'friends':
      safe(() => renderFriends(msg.data), 'friends');
      break;
    case 'vibe-sync':
      safe(() => renderVibeSync(msg.data), 'vibe-sync');
      break;
    case 'music-memory':
      safe(() => renderMusicMemory(msg.data), 'music-memory');
      break;
    case 'audio-features':
      // Audio features deprecated for new apps - use energy proxy instead
      break;
    case 'liked-songs':
      safe(() => renderLibraryStats(msg.data), 'library');
      break;
    case 'auth-required':
      $('dash-auth')?.classList.remove('hidden');
      $('dash-main')?.classList.add('hidden');
      break;
  }
}

function hasApiData(d) {
  return d && (d.energyCurve?.length || d.topArtists?.length || d.topTracks?.length || d.history?.length);
}

function showApiWarning(errors) {
  if (!errors.some(e => e.includes('403'))) return;
  let b = $('api-warning');
  if (!b) {
    b = document.createElement('div');
    b.id = 'api-warning';
    b.className = 'api-warning';
    document.querySelector('.bento').before(b);
  }
  b.innerHTML = '<strong>Some Spotify API calls returned 403</strong><br>Try logging out and reconnecting from the popup.';
}

// === Hero ===

function renderHero(state) {
  if (!state?.item) {
    $('hero-track').textContent = 'Not playing';
    $('hero-artist').textContent = 'Open Spotify on a device';
    $('hero-album').textContent = '';
    $('hero-art-img').style.display = 'none';
    $('hero-art-placeholder').style.display = 'flex';
    return;
  }

  $('dash-auth')?.classList.add('hidden');
  $('dash-main')?.classList.remove('hidden');

  const t = state.item;
  $('hero-track').textContent = t.name || 'Unknown';
  $('hero-artist').textContent = t.artists?.map(a => a.name).join(', ') || '';
  $('hero-album').textContent = t.album?.name || '';

  const url = t.album?.images?.[0]?.url;
  if (url) {
    $('hero-art-img').src = url;
    $('hero-art-img').style.display = 'block';
    $('hero-art-placeholder').style.display = 'none';
  }
}

function renderStats(data) {
  if (!data) return;
  const { session, streak } = data;
  if (session) {
    animateVal($('h-stat-min'), Math.round(session.totalListenMs / 60000));
    animateVal($('h-stat-skips'), session.skips);
    animateVal($('h-stat-artists'), session.artistCount);
  }
  if (streak) {
    $('h-stat-streak').textContent = `${streak.count}d`;
  }
}

function animateVal(el, target) {
  if (target == null || isNaN(target)) return;
  const current = parseInt(el.textContent) || 0;
  if (current === target) return;
  const steps = 12;
  const delta = (target - current) / steps;
  let step = 0;
  const tick = () => {
    step++;
    el.textContent = step >= steps ? target : Math.round(current + delta * step);
    if (step < steps) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// === Energy Waveform ===

let waveformBars = [];

function renderEnergyChart(data) {
  const canvas = $('energy-chart');
  const wrap = canvas.parentElement;
  const tip = $('waveform-tooltip');
  const badge = $('waveform-count');

  if (!data?.length) {
    canvas.style.display = 'none';
    wrap.querySelector('.empty-panel')?.remove();
    const e = document.createElement('div');
    e.className = 'empty-panel';
    e.textContent = 'No energy data yet';
    wrap.appendChild(e);
    if (badge) badge.textContent = '';
    return;
  }

  canvas.style.display = 'block';
  wrap.querySelector('.empty-panel')?.remove();
  if (badge) badge.textContent = `${data.length} tracks`;

  const dpr = window.devicePixelRatio || 1;
  const rect = wrap.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const W = rect.width, H = rect.height;
  const pad = 8;
  const plotW = W - pad * 2;
  const plotH = H - pad * 2;
  const centerY = pad + plotH / 2;
  const halfH = plotH / 2 - 2;

  ctx.clearRect(0, 0, W, H);

  // Theme-aware bar color: read the data-viz RGB triple from CSS so the
  // waveform follows the active theme (green default, olive/ochre/grey themes).
  const dataRgb = getComputedStyle(document.documentElement)
    .getPropertyValue('--data-rgb').trim() || '29,185,84';

  const n = data.length;
  const gap = Math.min(2, plotW / n * 0.15);
  const barW = Math.max(2, (plotW - (n - 1) * gap) / n);
  waveformBars = [];

  for (let i = 0; i < n; i++) {
    const e = data[i];
    const pct = Math.min(e.value, 100) / 100;
    const barH = Math.max(2, pct * halfH);
    const x = pad + i * (barW + gap);

    // Energy drives opacity (0.45→1.0) instead of a green ramp.
    ctx.fillStyle = `rgba(${dataRgb},${(0.45 + pct * 0.55).toFixed(2)})`;

    ctx.fillRect(x, centerY - barH, barW, barH);
    ctx.globalAlpha = 0.5;
    ctx.fillRect(x, centerY + 1, barW, barH * 0.6);
    ctx.globalAlpha = 1;

    /* energy-bar glow removed — Clean Swiss */

    waveformBars.push({ x, w: barW, label: e.label, value: e.value });
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, centerY);
  ctx.lineTo(pad + plotW, centerY);
  ctx.stroke();

  canvas.onmousemove = ev => {
    const cr = canvas.getBoundingClientRect();
    const mx = ev.clientX - cr.left;
    const hit = waveformBars.find(b => mx >= b.x && mx <= b.x + b.w);
    if (hit) {
      tip.style.display = 'block';
      tip.innerHTML = `<div class="wf-tip-name">${esc(hit.label)}</div><div class="wf-tip-val">Energy ${hit.value}%</div>`;
      tip.style.left = Math.min(ev.clientX - cr.left + 12, W - 140) + 'px';
      tip.style.top = (ev.clientY - cr.top - 40) + 'px';
    } else {
      tip.style.display = 'none';
    }
  };
  canvas.onmouseleave = () => { tip.style.display = 'none'; };
}

// === Peak Hours ===

function renderHeatmap(hours) {
  const c = $('heatmap');
  if (!hours) return;

  const total = hours.reduce((a, b) => a + b, 0);
  if (total === 0) {
    c.innerHTML = '<div class="empty-panel">No listening data yet</div>';
    return;
  }

  const max = Math.max(...hours, 1);

  // Single row showing aggregate hours
  const cellsHtml = hours.map((val, i) => {
    const intensity = val > 0 ? 0.15 + (val / max) * 0.85 : 0.04;
    const h = String(i).padStart(2, '0');
    const tip = `${h}:00 · ${val} play${val !== 1 ? 's' : ''}`;
    return `<div class="peak-cell" style="background:rgba(var(--data-rgb),${intensity})" data-tip="${tip}"></div>`;
  }).join('');

  c.innerHTML = `
    <div class="peak-row">
      <span class="peak-period">All</span>
      <div class="peak-cells">${cellsHtml}</div>
    </div>
    <div class="peak-labels">
      <span class="peak-label">00</span>
      <span class="peak-label">03</span>
      <span class="peak-label">06</span>
      <span class="peak-label">09</span>
      <span class="peak-label">12</span>
      <span class="peak-label">15</span>
      <span class="peak-label">18</span>
      <span class="peak-label">21</span>
    </div>`;
}

// === Session Vibe ===

function renderSessionVibe(energyData) {
  const c = $('session-vibe');
  if (!energyData?.length) {
    c.innerHTML = '<div class="empty-panel">Play some tracks to see your vibe</div>';
    return;
  }

  const values = energyData.map(e => e.value);
  const avg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min;
  const variance = Math.round(Math.sqrt(values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length));

  let mood, emoji, desc;
  if (avg >= 80) { mood = 'ON FIRE'; emoji = '\u{1F525}'; desc = 'High intensity session'; }
  else if (avg >= 65) { mood = 'ENERGETIC'; emoji = '\u{26A1}'; desc = 'Upbeat and lively'; }
  else if (avg >= 50) { mood = 'GROOVING'; emoji = '\u{1F3B5}'; desc = 'Balanced and flowing'; }
  else if (avg >= 35) { mood = 'MELLOW'; emoji = '\u{1F30A}'; desc = 'Laid back vibes'; }
  else { mood = 'CHILL'; emoji = '\u{1F319}'; desc = 'Low-key and relaxed'; }

  if (range > 50) desc += ' · varied mix';
  else if (range < 15) desc += ' · consistent mood';

  const bars = [
    { label: 'Avg', value: avg, color: 'var(--green)' },
    { label: 'Peak', value: max, color: '#22d3ee' },
    { label: 'Low', value: min, color: '#8b5cf6' },
    { label: 'Range', value: range, color: 'var(--amber)' },
    { label: 'Spread', value: Math.min(variance, 100), color: '#f472b6' }
  ];

  c.innerHTML = `
    <div class="vibe-top">
      <div class="vibe-icon">${emoji}</div>
      <div>
        <div class="vibe-mood-label">${mood}</div>
        <div class="vibe-mood-desc">${desc}</div>
      </div>
    </div>
    <div class="vibe-bars">
      ${bars.map(b => `<div class="vibe-row">
        <span class="vibe-row-label">${b.label}</span>
        <div class="vibe-bar"><div class="vibe-fill" style="width:${b.value}%;background:${b.color}"></div></div>
        <span class="vibe-row-val">${b.value}%</span>
      </div>`).join('')}
    </div>
    <div class="vibe-footer">Based on ${values.length} track${values.length !== 1 ? 's' : ''}</div>`;
}

// === Album Mosaic ===

function renderAlbumMosaic(history, topTracks) {
  const c = $('album-mosaic');
  const seen = new Set();
  const albums = [];

  const sources = [...(history || []), ...(topTracks || [])];
  for (const item of sources) {
    const url = item.artUrl || item.album?.images?.[1]?.url || item.album?.images?.[0]?.url;
    const albumName = typeof item.album === 'string' ? item.album : item.album?.name || '';
    if (url && !seen.has(url)) {
      seen.add(url);
      albums.push({ url, name: albumName });
    }
    if (albums.length >= 9) break;
  }

  if (!albums.length) {
    c.innerHTML = '<div class="empty-panel">No albums yet</div>';
    return;
  }

  c.innerHTML = albums.map(a =>
    `<div class="mosaic-cell" data-album="${esc(a.name)}"><img src="${safeImg(a.url)}" alt="" loading="lazy"></div>`
  ).join('');
}

// === Top Artists ===

function renderTopArtists(artists) {
  const c = $('top-artists');
  if (!artists?.length) {
    c.innerHTML = '<div class="empty-panel">No top artists yet</div>';
    return;
  }

  c.innerHTML = artists.slice(0, 10).map((a, i) => {
    const img = a.images?.[2]?.url || a.images?.[0]?.url || '';
    const genres = a.genres?.slice(0, 2).join(', ') || '';
    const medal = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
    return `<div class="rank-row">
      <span class="rank-num ${medal}">${i + 1}</span>
      <div class="rank-art round">${img ? `<img src="${safeImg(img)}" alt="">` : ''}</div>
      <div class="rank-info">
        <div class="rank-name">${esc(a.name)}</div>
        ${genres ? `<div class="rank-sub">${esc(genres)}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

// === Top Tracks ===

function renderTopTracks(tracks) {
  const c = $('top-tracks');
  if (!tracks?.length) {
    c.innerHTML = '<div class="empty-panel">No top tracks yet</div>';
    return;
  }

  c.innerHTML = tracks.slice(0, 10).map((t, i) => {
    const art = t.album?.images?.[2]?.url || '';
    const artist = t.artists?.map(a => a.name).join(', ') || '';
    const medal = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
    return `<div class="rank-row">
      <span class="rank-num ${medal}">${i + 1}</span>
      <div class="rank-art">${art ? `<img src="${safeImg(art)}" alt="">` : ''}</div>
      <div class="rank-info">
        <div class="rank-name">${esc(t.name || '')}</div>
        <div class="rank-sub">${esc(artist)}</div>
      </div>
      <span class="rank-right">${fmt(t.duration_ms)}</span>
    </div>`;
  }).join('');
}

// === Devices ===

function renderDevices(data) {
  const c = $('device-list');
  if (!data?.devices?.length) {
    c.innerHTML = '<div class="empty-panel">No devices found</div>';
    return;
  }

  const icons = {
    Computer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="20" height="20"><rect x="2" y="3" width="20" height="14" rx="1"/><path d="M8 21h8M12 17v4"/></svg>',
    Smartphone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="20" height="20"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h0"/></svg>',
    Speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="20" height="20"><rect x="4" y="2" width="16" height="20" rx="2"/><circle cx="12" cy="14" r="4"/><circle cx="12" cy="6" r="1"/></svg>'
  };

  c.innerHTML = data.devices.map(d => {
    const icon = icons[d.type] || icons.Computer;
    return `<div class="device-row ${d.is_active ? 'active' : ''}">
      <div class="dev-icon">${icon}</div>
      <div class="dev-info">
        <div class="dev-name">${esc(d.name)}</div>
        <div class="dev-type">${esc(d.type)}${d.is_active ? ' · Active' : ''}</div>
      </div>
      ${d.is_active ? '' : `<button class="transfer-btn" data-id="${esc(d.id)}">Transfer</button>`}
    </div>`;
  }).join('');

  c.querySelectorAll('.transfer-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      send({ action: 'transfer', deviceId: btn.dataset.id });
      setTimeout(() => send({ action: 'get-devices' }), 1000);
    });
  });
}

// === Listening Log ===

function renderLog(history) {
  const c = $('listen-log');
  const badge = $('log-count');

  if (!history?.length) {
    c.innerHTML = '<div class="empty-panel">No recently played tracks</div>';
    if (badge) badge.textContent = '';
    return;
  }

  if (badge) badge.textContent = `${history.length} tracks`;

  c.innerHTML = history.slice(-40).reverse().map(t => {
    const time = new Date(t.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const artUrl = t.artUrl || '';
    return `<div class="log-item">
      <span class="log-time">${time}</span>
      <div class="log-art">${artUrl ? `<img src="${safeImg(artUrl)}" alt="" loading="lazy">` : ''}</div>
      <div class="log-meta">
        <div class="log-track">${esc(t.name)}</div>
        <div class="log-artist">${esc(t.artist)}</div>
      </div>
      <span class="log-dur">${fmt(t.durationMs)}</span>
    </div>`;
  }).join('');
}

// === Friends ===

function renderFriends(data) {
  const c = $('friends-list');
  if (!data) return;

  if (data.error) {
    c.innerHTML = `<div class="friends-error">${esc(data.error)}</div>`;
    return;
  }

  if (!data.friends?.length) {
    c.innerHTML = '<div class="empty-panel">No friend activity right now</div>';
    return;
  }

  c.innerHTML = data.friends.map(f => {
    const ago = timeAgo(f.timestamp);
    const initial = esc((f.user.name || '?')[0].toUpperCase());
    const avatar = f.user.image
      ? `<img src="${safeImg(f.user.image)}" alt="">`
      : `<div class="friend-avatar-ph">${initial}</div>`;
    const trackArt = f.track.image ? `<img src="${safeImg(f.track.image)}" alt="">` : '';
    const ctx = f.track.context ? `<div class="friend-context">${esc(f.track.context)}</div>` : '';

    return `<div class="friend-row">
      <div class="friend-avatar">${avatar}</div>
      <div class="friend-info">
        <div class="friend-name">${esc(f.user.name)}</div>
        <div class="friend-track">${esc(f.track.name)}${f.track.artist ? ' · ' + esc(f.track.artist) : ''}</div>
        ${ctx}
      </div>
      <div class="friend-art">${trackArt}</div>
      <div class="friend-time">${ago}</div>
    </div>`;
  }).join('');
}

function timeAgo(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  const m = Math.floor(d / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

$('friends-refresh').addEventListener('click', () => {
  $('friends-list').innerHTML = '<div class="empty-panel">Loading...</div>';
  send({ action: 'get-friends' });
});

// === Vibe Sync ===

$('vibe-refresh').addEventListener('click', () => {
  $('vibe-sync').innerHTML = '<div class="empty-panel">Loading...</div>';
  send({ action: 'get-vibe-sync' });
});

function vibeMood(energy) {
  if (energy >= 80) return 'grind mode';
  if (energy >= 65) return 'upbeat flow';
  if (energy >= 50) return 'cruise control';
  if (energy >= 35) return 'chill wave';
  return 'zen mode';
}

function calculateVibeScore(my, friend) {
  if (my.energy == null || friend.energy == null) return null;

  // Factor 1: Energy similarity (50%)
  const energyDiff = Math.abs(my.energy - friend.energy);
  const energyScore = Math.max(0, 100 - energyDiff * 1.2);

  // Factor 2: Artist match (35%)
  let artistScore = 0;
  if (my.artist && friend.artist) {
    if (my.artist === friend.artist) {
      artistScore = 100; // Same artist
    } else if (my.artist.includes(friend.artist) || friend.artist.includes(my.artist)) {
      artistScore = 70; // Partial match (e.g., "feat." collaborations)
    }
  }

  // Factor 3: Time alignment (15%) — circular distance for hour wrap-around
  const rawDiff = Math.abs(my.hour - friend.hour);
  const hourDiff = Math.min(rawDiff, 24 - rawDiff);
  const timeScore = Math.max(0, 100 - hourDiff * 20);

  return Math.round(energyScore * 0.5 + artistScore * 0.35 + timeScore * 0.15);
}

function vibeMessage(name, score, myEnergy, friendEnergy, sameArtist) {
  if (score >= 85 && sameArtist) return `You and <strong>${esc(name)}</strong> are both vibing to the same artist`;
  if (score >= 85) return `You and <strong>${esc(name)}</strong> are in perfect sync`;
  if (score >= 70 && sameArtist) return `You and <strong>${esc(name)}</strong> share the same taste`;
  if (score >= 70) return `<strong>${esc(name)}</strong> is vibing close to you`;
  if (score >= 50) return `<strong>${esc(name)}</strong> is on a different wavelength`;
  return `<strong>${esc(name)}</strong> is worlds apart`;
}

function scoreClass(s) {
  if (s >= 85) return 'hot';
  if (s >= 70) return 'match';
  if (s >= 50) return 'warm';
  if (s >= 30) return 'cool';
  return 'cold';
}

function renderVibeSync(data) {
  const c = $('vibe-sync');
  if (!data) return;

  if (data.error) {
    c.innerHTML = `<div class="friends-error">${esc(data.error)}</div>`;
    return;
  }

  if (!data.friends?.length) {
    c.innerHTML = '<div class="empty-panel">No friends online to vibe check</div>';
    return;
  }

  if (data.myEnergy == null) {
    c.innerHTML = '<div class="empty-panel">Play something first to see vibe matches</div>';
    return;
  }

  const myData = {
    energy: data.myEnergy,
    artist: data.myArtist || '',
    hour: data.myHour || new Date().getHours()
  };

  c.innerHTML = data.friends.map(f => {
    if (f.energy == null) {
      return `<div class="vs-row">
        <div class="vs-avatar">${f.user.image ? `<img src="${safeImg(f.user.image)}">` : `<div class="vs-avatar-ph">${esc((f.user.name || '?')[0])}</div>`}</div>
        <div class="vs-info">
          <div class="vs-line"><strong>${esc(f.user.name)}</strong></div>
          <div class="vs-sub">${esc(f.track.name)}${f.track.artist ? ' · ' + esc(f.track.artist) : ''}</div>
        </div>
        <div class="vs-score"><span class="vs-pct cold">--</span><div class="vs-score-label">NO DATA</div></div>
      </div>`;
    }

    const friendData = {
      energy: f.energy,
      artist: f.artist || '',
      hour: f.hour || myData.hour
    };

    const score = calculateVibeScore(myData, friendData);
    const sameArtist = myData.artist && friendData.artist && 
                       (myData.artist === friendData.artist || 
                        myData.artist.includes(friendData.artist) || 
                        friendData.artist.includes(myData.artist));
    const msg = vibeMessage(f.user.name, score, myData.energy, friendData.energy, sameArtist);

    return `<div class="vs-row">
      <div class="vs-avatar">${f.user.image ? `<img src="${safeImg(f.user.image)}">` : `<div class="vs-avatar-ph">${esc((f.user.name || '?')[0])}</div>`}</div>
      <div class="vs-info">
        <div class="vs-line">${msg}</div>
        <div class="vs-sub">${esc(f.track.name)}${f.track.artist ? ' · ' + esc(f.track.artist) : ''}</div>
      </div>
      <div class="vs-score"><span class="vs-pct ${scoreClass(score)}">${score}%</span><div class="vs-score-label">MATCH</div></div>
    </div>`;
  }).join('');
}

// === Music Memory ===

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function timePeriod(h) {
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 21) return 'evening';
  if (h >= 21) return 'night';
  return 'late night';
}

function memoryInsights(mem) {
  const insights = [];
  const totalPlays = mem.reduce((s, m) => s + m.plays, 0);
  if (totalPlays < 5) return insights;

  const slots = mem.map((m, i) => ({
    day: Math.floor(i / 24),
    hour: i % 24,
    plays: m.plays,
    avgEnergy: m.plays > 0 ? Math.round(m.energy / m.plays) : 0
  })).filter(s => s.plays > 0);

  slots.sort((a, b) => b.plays - a.plays);

  const peak = slots[0];
  if (peak) {
    const period = timePeriod(peak.hour);
    const dayName = DAY_FULL[peak.day];
    const mood = vibeMood(peak.avgEnergy);
    insights.push({
      headline: `${dayName} ${period}s are your peak`,
      detail: `Most active at ${String(peak.hour).padStart(2, '0')}:00 — usually ${mood}`
    });
  }

  const dayTotals = new Array(7).fill(0);
  const dayEnergy = new Array(7).fill(0);
  const dayCounts = new Array(7).fill(0);
  for (const s of slots) {
    dayTotals[s.day] += s.plays;
    dayEnergy[s.day] += s.avgEnergy * s.plays;
    dayCounts[s.day] += s.plays;
  }

  const topDay = dayTotals.indexOf(Math.max(...dayTotals));
  const topDayAvgE = dayCounts[topDay] > 0 ? Math.round(dayEnergy[topDay] / dayCounts[topDay]) : 50;
  const topMood = vibeMood(topDayAvgE);

  if (topDay !== peak?.day) {
    insights.push({
      headline: `${DAY_FULL[topDay]} is your biggest listening day`,
      detail: `Average vibe: ${topMood}`
    });
  }

  const nightSlots = slots.filter(s => s.hour >= 22 || s.hour < 5);
  const nightPlays = nightSlots.reduce((s, sl) => s + sl.plays, 0);
  const morningSlots = slots.filter(s => s.hour >= 6 && s.hour < 11);
  const morningPlays = morningSlots.reduce((s, sl) => s + sl.plays, 0);

  if (nightPlays > morningPlays * 2 && nightPlays >= 3) {
    const nightE = nightSlots.reduce((s, sl) => s + sl.avgEnergy * sl.plays, 0) / nightPlays;
    const nm = vibeMood(nightE);
    insights.push({
      headline: 'Night owl detected',
      detail: `Your late nights lean ${nm}`
    });
  } else if (morningPlays > nightPlays * 2 && morningPlays >= 3) {
    const mornE = morningSlots.reduce((s, sl) => s + sl.avgEnergy * sl.plays, 0) / morningPlays;
    const mm = vibeMood(mornE);
    insights.push({
      headline: 'Early bird vibes',
      detail: `Mornings are ${mm} for you`
    });
  }

  const weekdayE = [], weekendE = [];
  for (const s of slots) {
    if (s.day === 0 || s.day === 6) weekendE.push(...Array(s.plays).fill(s.avgEnergy));
    else weekdayE.push(...Array(s.plays).fill(s.avgEnergy));
  }

  if (weekdayE.length >= 3 && weekendE.length >= 3) {
    const wdAvg = Math.round(weekdayE.reduce((a, b) => a + b, 0) / weekdayE.length);
    const weAvg = Math.round(weekendE.reduce((a, b) => a + b, 0) / weekendE.length);
    const diff = weAvg - wdAvg;
    if (Math.abs(diff) > 10) {
      const higher = diff > 0 ? 'Weekends' : 'Weekdays';
      const lower = diff > 0 ? 'weekdays' : 'weekends';
      insights.push({
        headline: `${higher} hit different`,
        detail: `Energy goes ${diff > 0 ? 'up' : 'down'} by ${Math.abs(diff)}% vs ${lower}`
      });
    }
  }

  if (insights.length === 0) {
    insights.push({
      headline: 'Building your profile',
      detail: `${totalPlays} data points collected — patterns emerge after a few days`
    });
  }

  return insights.slice(0, 3);
}

function renderMusicMemory(mem) {
  const c = $('music-memory');

  if (!mem) {
    c.innerHTML = '<div class="empty-panel">No data yet</div>';
    return;
  }

  const totalPlays = mem.reduce((s, m) => s + m.plays, 0);
  if (totalPlays < 2) {
    c.innerHTML = '<div class="empty-panel">Keep listening — patterns will appear after a few sessions</div>';
    return;
  }

  const insights = memoryInsights(mem);
  const maxPlays = Math.max(...mem.map(m => m.plays), 1);

  const gridHtml = buildMemoryGrid(mem, maxPlays);

  c.innerHTML = `
    <div class="mm-wrap">
      <div class="mm-insights">
        ${insights.map(i => `
          <div class="mm-insight">
            <div class="mm-dot"></div>
            <div class="mm-text">
              <div class="mm-headline">${i.headline}</div>
              <div class="mm-detail">${i.detail}</div>
            </div>
          </div>`).join('')}
      </div>
      ${gridHtml}
    </div>`;
}

function buildMemoryGrid(mem, maxPlays) {
  let html = '<div class="mm-grid">';

  html += '<div class="mm-day-label"></div>';
  for (let h = 0; h < 24; h++) {
    if (h % 6 === 0) html += `<span class="mm-hour-label">${String(h).padStart(2, '0')}</span>`;
    else html += '<span></span>';
  }

  for (let d = 0; d < 7; d++) {
    html += `<div class="mm-day-label">${DAYS[d]}</div>`;
    for (let h = 0; h < 24; h++) {
      const slot = mem[d * 24 + h];
      const intensity = slot.plays > 0 ? 0.2 + (slot.plays / maxPlays) * 0.8 : 0.04;
      const color = slot.plays > 0 ? `rgba(var(--data-rgb),${intensity})` : 'var(--elevated)';
      const tip = `${DAYS[d]} ${String(h).padStart(2, '0')}:00 · ${slot.plays} play${slot.plays !== 1 ? 's' : ''}`;

      html += `<div class="mm-cell" style="background:${color}" data-tip="${tip}"></div>`;
    }
  }

  html += '</div>';
  
  // Legend
  html += `<div class="mm-legend">
    <span class="mm-legend-label">Less</span>
    <div class="mm-legend-scale">
      <div class="mm-legend-cell" style="background:var(--elevated)"></div>
      <div class="mm-legend-cell" style="background:rgba(var(--data-rgb),0.2)"></div>
      <div class="mm-legend-cell" style="background:rgba(var(--data-rgb),0.4)"></div>
      <div class="mm-legend-cell" style="background:rgba(var(--data-rgb),0.6)"></div>
      <div class="mm-legend-cell" style="background:rgba(var(--data-rgb),0.8)"></div>
      <div class="mm-legend-cell" style="background:rgba(var(--data-rgb),1.0)"></div>
    </div>
    <span class="mm-legend-label">More</span>
  </div>`;
  
  return html;
}

// === Taste Profile ===

function renderTasteProfile(tracks) {
  const c = $('taste-profile');
  if (!tracks?.length) {
    c.innerHTML = '<div class="empty-panel">No tracks data available</div>';
    return;
  }

  // Use energy proxy for each track
  const energies = tracks.map(t => energyProxy(t));
  const avgEnergy = Math.round(energies.reduce((s, e) => s + e, 0) / energies.length);
  const maxEnergy = Math.max(...energies);
  const minEnergy = Math.min(...energies);
  const range = maxEnergy - minEnergy;

  // Calculate avg popularity and duration
  const avgPopularity = Math.round(tracks.reduce((s, t) => s + (t.popularity || 50), 0) / tracks.length);
  const avgDuration = Math.round(tracks.reduce((s, t) => s + (t.duration_ms || 0), 0) / tracks.length / 1000);
  const explicitCount = tracks.filter(t => t.explicit).length;
  const explicitPct = Math.round((explicitCount / tracks.length) * 100);

  // Determine mood
  let mood, moodDesc;
  if (avgEnergy >= 80) { mood = 'High Energy'; moodDesc = 'Intense and upbeat'; }
  else if (avgEnergy >= 60) { mood = 'Energetic'; moodDesc = 'Active and lively'; }
  else if (avgEnergy >= 40) { mood = 'Balanced'; moodDesc = 'Mix of vibes'; }
  else { mood = 'Chill'; moodDesc = 'Relaxed and mellow'; }

  const bars = [
    { label: 'Energy', value: avgEnergy, color: 'var(--green)' },
    { label: 'Popularity', value: avgPopularity, color: '#22d3ee' },
    { label: 'Explicit', value: explicitPct, color: 'var(--amber)' },
    { label: 'Variety', value: Math.min(range * 2, 100), color: '#8b5cf6' }
  ];

  c.innerHTML = `
    <div class="taste-bars">
      ${bars.map(b => `<div class="taste-bar-row">
        <span class="taste-bar-label">${b.label}</span>
        <div class="taste-bar-track"><div class="taste-bar-fill" style="width:${b.value}%;background:${b.color}"></div></div>
        <span class="taste-bar-val">${b.value}%</span>
      </div>`).join('')}
    </div>
    <div class="taste-summary">
      <div class="taste-stat">
        <div class="taste-stat-val">${avgEnergy}%</div>
        <div class="taste-stat-label">AVG ENERGY</div>
      </div>
      <div class="taste-stat">
        <div class="taste-stat-val">${avgDuration}s</div>
        <div class="taste-stat-label">AVG LENGTH</div>
      </div>
      <div class="taste-stat">
        <div class="taste-stat-val">${tracks.length}</div>
        <div class="taste-stat-label">TRACKS</div>
      </div>
    </div>
    <div style="margin-top:8px;font-size:10px;color:var(--fg-faint);text-align:center">${mood} · ${moodDesc}</div>`;
}

// === Library Stats ===

function renderLibraryStats(data) {
  const c = $('library-stats');
  const badge = $('library-count');

  if (!data?.items?.length) {
    c.innerHTML = '<div class="empty-panel">No liked songs found</div>';
    return;
  }

  const items = data.items;
  const total = data.total || items.length;
  if (badge) badge.textContent = `${total} tracks`;

  // Calculate stats
  const addedThisMonth = items.filter(i => {
    const added = new Date(i.added_at);
    const monthAgo = new Date();
    monthAgo.setMonth(monthAgo.getMonth() - 1);
    return added > monthAgo;
  }).length;

  const uniqueArtists = new Set();
  items.forEach(i => {
    i.track?.artists?.forEach(a => uniqueArtists.add(a.id));
  });

  // Recent additions
  const recent = items.slice(0, 5);

  c.innerHTML = `
    <div class="library-summary">
      <div class="library-stat">
        <div class="library-stat-val green">${total}</div>
        <div class="library-stat-label">LIKED SONGS</div>
      </div>
      <div class="library-stat">
        <div class="library-stat-val amber">${addedThisMonth}</div>
        <div class="library-stat-label">ADDED THIS MONTH</div>
      </div>
      <div class="library-stat">
        <div class="library-stat-val">${uniqueArtists.size}</div>
        <div class="library-stat-label">UNIQUE ARTISTS</div>
      </div>
    </div>
    <div class="library-recent">
      <div class="library-recent-title">Recently Added</div>
      ${recent.map(i => {
        const t = i.track;
        if (!t) return '';
        const art = t.album?.images?.[2]?.url || '';
        const artist = t.artists?.map(a => a.name).join(', ') || '';
        const date = new Date(i.added_at).toLocaleDateString([], { month: 'short', day: 'numeric' });
        return `<div class="library-recent-item">
          <div class="library-recent-art">${art ? `<img src="${safeImg(art)}" alt="">` : ''}</div>
          <div class="library-recent-info">
            <div class="library-recent-name">${esc(t.name || '')}</div>
            <div class="library-recent-artist">${esc(artist)}</div>
          </div>
          <div class="library-recent-date">${date}</div>
        </div>`;
      }).join('')}
    </div>`;
}

// === Share Card ===

$('share-btn').addEventListener('click', () => {
  renderShareCard();
  $('share-preview').classList.add('active');
});

$('share-close').addEventListener('click', () => {
  $('share-preview').classList.remove('active');
});

$('share-preview').addEventListener('click', e => {
  if (e.target === $('share-preview')) $('share-preview').classList.remove('active');
});

function renderShareCard() {
  const canvas = $('share-canvas');
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  ctx.fillStyle = '#08080a';
  ctx.fillRect(0, 0, 600, 340);

  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, 598, 338);

  ctx.strokeStyle = '#1db954';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, 10); ctx.lineTo(0, 0); ctx.lineTo(10, 0); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(590, 0); ctx.lineTo(600, 0); ctx.lineTo(600, 10); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, 330); ctx.lineTo(0, 340); ctx.lineTo(10, 340); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(590, 340); ctx.lineTo(600, 340); ctx.lineTo(600, 330); ctx.stroke();

  ctx.fillStyle = '#1db954';
  ctx.fillRect(20, 20, 6, 20);
  ctx.fillRect(30, 14, 6, 32);
  ctx.fillRect(40, 22, 6, 16);
  ctx.globalAlpha = 0.4;
  ctx.fillRect(50, 26, 4, 8);
  ctx.globalAlpha = 1;

  ctx.font = '600 12px "Inter Tight"';
  ctx.fillStyle = '#1db954';
  ctx.fillText('SHARDTUNE', 62, 36);

  const track = currentState?.item;
  if (track) {
    ctx.font = '600 24px "Inter Tight"';
    ctx.fillStyle = '#f0f0f2';
    ctx.fillText(trunc(track.name || 'Unknown', 28), 20, 90);

    ctx.font = '15px "Inter Tight"';
    ctx.fillStyle = '#a0a0aa';
    ctx.fillText(track.artists?.map(a => a.name).join(', ') || '', 20, 115);

    ctx.font = '12px "Inter Tight"';
    ctx.fillStyle = '#55555e';
    ctx.fillText(track.album?.name || '', 20, 138);
  }

  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.fillRect(20, 158, 560, 1);

  if (analyticsData?.session) {
    const s = analyticsData.session;
    const stats = [
      { label: 'MINUTES', val: Math.round(s.totalListenMs / 60000), color: '#1db954' },
      { label: 'SKIPS', val: s.skips, color: '#f0f0f2' },
      { label: 'ARTISTS', val: s.artistCount, color: '#f0f0f2' }
    ];

    stats.forEach((stat, i) => {
      const x = 20 + i * 180;
      ctx.font = '600 30px "IBM Plex Mono"';
      ctx.fillStyle = stat.color;
      ctx.fillText(String(stat.val), x, 210);

      ctx.font = '600 9px "IBM Plex Mono"';
      ctx.fillStyle = '#55555e';
      ctx.fillText(stat.label, x, 228);
    });
  }

  if (analyticsData?.streak) {
    ctx.font = '600 30px "IBM Plex Mono"';
    ctx.fillStyle = '#f59e0b';
    ctx.fillText(`${analyticsData.streak.count}d`, 20, 290);

    ctx.font = '600 9px "IBM Plex Mono"';
    ctx.fillStyle = '#92400e';
    ctx.fillText('STREAK', 20, 306);
  }

  ctx.font = '10px "IBM Plex Mono"';
  ctx.fillStyle = '#33333a';
  ctx.fillText('shardtune · shard ecosystem', 380, 325);

  if (track?.album?.images?.[0]?.url) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 454, 56, 128, 128);
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 2;
      ctx.strokeRect(454, 56, 128, 128);
    };
    img.src = track.album.images[0].url;
  }
}

$('share-copy').addEventListener('click', async () => {
  try {
    const blob = await new Promise(r => $('share-canvas').toBlob(r, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    $('share-copy').textContent = 'Copied!';
    setTimeout(() => { $('share-copy').textContent = 'Copy to clipboard'; }, 2000);
  } catch { $('share-copy').textContent = 'Failed'; }
});

$('share-download').addEventListener('click', () => {
  const a = document.createElement('a');
  a.download = `shardtune-${new Date().toISOString().split('T')[0]}.png`;
  a.href = $('share-canvas').toDataURL('image/png');
  a.click();
});

// === Export ===

$('export-json-btn').addEventListener('click', () => {
  const d = { ...analyticsData };
  if (historyData) d.history = historyData;
  const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.download = `shardtune-${new Date().toISOString().split('T')[0]}.json`;
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// === Helpers ===

function trunc(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// === Resize waveform on window resize ===

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (historyData?.energyCurve) renderEnergyChart(historyData.energyCurve);
  }, 200);
});
