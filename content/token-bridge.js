var _lastToken = null;

window.addEventListener('message', function (event) {
  if (event.source !== window) return;
  if (event.origin !== 'https://open.spotify.com') return;
  if (!event.data || event.data.type !== '__SHARDTUNE_TOKEN__') return;
  if (!event.data.token) return;
  if (event.data.token === _lastToken) return;

  _lastToken = event.data.token;
  chrome.storage.local.set({
    shardtune_web_token: event.data.token,
    shardtune_web_token_ts: Date.now()
  });
});
