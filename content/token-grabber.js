(function () {
  var SPOTIFY_HOSTS = ['api.spotify.com', 'spclient.wg.spotify.com'];

  function isSpotifyUrl(url) {
    try {
      var host = new URL(url, window.location.origin).hostname;
      for (var i = 0; i < SPOTIFY_HOSTS.length; i++) {
        if (host === SPOTIFY_HOSTS[i] || host.endsWith('.' + SPOTIFY_HOSTS[i])) return true;
      }
    } catch (e) {}
    return false;
  }

  function extractUrl(args) {
    if (typeof args[0] === 'string') return args[0];
    if (args[0] && typeof args[0] === 'object' && args[0].url) return args[0].url;
    return '';
  }

  function extractAuth(args) {
    var headers = null;
    if (args[0] && typeof args[0].headers === 'object' && typeof args[0].headers.get === 'function') {
      headers = args[0].headers;
    }
    if (!headers) {
      var opts = args[1] || {};
      headers = opts.headers;
    }
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get('authorization');
    if (headers instanceof Array) {
      for (var i = 0; i < headers.length; i++) {
        if (headers[i][0] && headers[i][0].toLowerCase() === 'authorization') return headers[i][1];
      }
      return null;
    }
    return headers.authorization || headers.Authorization || null;
  }

  var _fetch = window.fetch;
  window.fetch = new Proxy(_fetch, {
    apply: function (target, thisArg, args) {
      var result = target.apply(thisArg, args);
      try {
        if (isSpotifyUrl(extractUrl(args))) {
          var auth = extractAuth(args);
          if (auth && auth.indexOf('Bearer ') === 0) {
            window.postMessage({ type: '__SHARDTUNE_TOKEN__', token: auth.slice(7) }, window.location.origin);
          }
        }
      } catch (e) {}
      return result;
    }
  });

  var _xhrOpen = XMLHttpRequest.prototype.open;
  var _xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function () {
    this.__shardtune_url = arguments[1] || '';
    return _xhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (name && name.toLowerCase() === 'authorization' && value && value.indexOf('Bearer ') === 0) {
      try {
        if (isSpotifyUrl(this.__shardtune_url || '')) {
          window.postMessage({ type: '__SHARDTUNE_TOKEN__', token: value.slice(7) }, window.location.origin);
        }
      } catch (e) {}
    }
    return _xhrSetHeader.apply(this, arguments);
  };
})();
