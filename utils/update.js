import * as storage from './storage.js';

const GITHUB_OWNER = 'hett-patell';
const GITHUB_REPO = 'ShardTune';
const CHECK_INTERVAL = 60 * 60 * 1000;

function getLocalVersion() {
  return chrome.runtime.getManifest().version;
}

function getChannel() {
  return chrome.runtime.getManifest().update_channel || 'stable';
}

async function getLatestRelease(channel) {
  if (channel === 'beta') {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;
    const response = await fetch(url, {
      headers: { 'Accept': 'application/vnd.github.v3+json' }
    });
    if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
    const releases = await response.json();
    if (!releases.length) throw new Error('No releases found');
    return releases[0];
  }

  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
  const response = await fetch(url, {
    headers: { 'Accept': 'application/vnd.github.v3+json' }
  });
  if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
  return response.json();
}

function compareVersions(local, remote) {
  const localParts = local.split('.').map(Number);
  const remoteParts = remote.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const lp = localParts[i] || 0;
    const rp = remoteParts[i] || 0;
    if (rp > lp) return 1;
    if (rp < lp) return -1;
  }
  return 0;
}

export async function checkForUpdates() {
  try {
    const lastCheck = await storage.get('lastUpdateCheck');
    const now = Date.now();

    if (lastCheck && (now - lastCheck) < CHECK_INTERVAL) {
      const cached = await storage.get('updateInfo');
      return cached || { available: false };
    }

    const channel = getChannel();
    const localVersion = getLocalVersion();
    const release = await getLatestRelease(channel);
    const remoteVersion = release.tag_name.replace(/^v/, '').replace(/-.*$/, '');

    const updateAvailable = compareVersions(localVersion, remoteVersion) > 0;

    const updateInfo = {
      available: updateAvailable,
      localVersion,
      remoteVersion,
      channel,
      prerelease: release.prerelease || false,
      releaseUrl: release.html_url,
      releaseNotes: release.body?.substring(0, 200) || '',
      publishedAt: release.published_at
    };

    await storage.set('updateInfo', updateInfo);
    await storage.set('lastUpdateCheck', now);

    return updateInfo;
  } catch (err) {
    console.warn('[ShardTune] Update check failed:', err.message);
    return { available: false, error: err.message };
  }
}

export async function getUpdateInfo() {
  return await storage.get('updateInfo') || { available: false };
}
