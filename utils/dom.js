const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(str) {
  return String(str == null ? '' : str).replace(ESCAPE_RE, c => ESCAPE_MAP[c]);
}

export function safeImg(url) {
  return /^https:\/\//i.test(url || '') ? esc(url) : '';
}

export function fmt(ms) {
  const s = Math.floor((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
