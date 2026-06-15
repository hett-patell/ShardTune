const BUDDYLIST_URL = 'https://spclient.wg.spotify.com/presence-view/v1/buddylist';
const TOKEN_MAX_AGE = 3500000;

async function getCachedToken() {
  const result = await chrome.storage.local.get(['shardtune_web_token', 'shardtune_web_token_ts']);
  if (result.shardtune_web_token && result.shardtune_web_token_ts) {
    if (Date.now() - result.shardtune_web_token_ts < TOKEN_MAX_AGE) {
      return result.shardtune_web_token;
    }
  }
  return null;
}

async function getWebToken() {
  const cached = await getCachedToken();
  if (cached) return cached;

  const tab = await chrome.tabs.create({ url: 'https://open.spotify.com', active: false });

  try {
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const token = await getCachedToken();
      if (token) return token;
    }
    throw new Error('Could not get web token — make sure you are logged into open.spotify.com in this browser');
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

export async function getFriendActivity() {
  const token = await getWebToken();

  const response = await fetch(BUDDYLIST_URL, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (!response.ok) {
    if (response.status === 401) {
      await chrome.storage.local.remove(['shardtune_web_token', 'shardtune_web_token_ts']);
      throw new Error('Web token expired — try refreshing again');
    }
    throw new Error(`Friend activity failed: ${response.status}`);
  }

  const data = await response.json();
  return (data.friends || []).map(f => ({
    user: {
      uri: f.user?.uri || '',
      name: f.user?.name || 'Unknown',
      image: f.user?.imageUrl || ''
    },
    track: {
      uri: f.track?.uri || '',
      name: f.track?.name || '',
      image: f.track?.imageUrl || '',
      artist: f.track?.artist?.name || '',
      album: f.track?.album?.name || '',
      context: f.track?.context?.name || ''
    },
    timestamp: f.timestamp || 0
  }));
}
