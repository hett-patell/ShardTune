(function () {
  var _fetch = window.fetch;

  window.fetch = new Proxy(_fetch, {
    apply: function (target, thisArg, args) {
      var result = target.apply(thisArg, args);
      try {
        var opts = args[1] || {};
        var headers = opts.headers;
        var auth = null;
        if (headers) {
          if (typeof headers.get === 'function') {
            auth = headers.get('authorization');
          } else if (headers instanceof Array) {
            for (var i = 0; i < headers.length; i++) {
              if (headers[i][0] && headers[i][0].toLowerCase() === 'authorization') {
                auth = headers[i][1];
                break;
              }
            }
          } else {
            auth = headers.authorization || headers.Authorization;
          }
        }
        if (auth && auth.indexOf('Bearer ') === 0) {
          window.postMessage({ type: '__SHARDTUNE_TOKEN__', token: auth.slice(7) }, window.location.origin);
        }
      } catch (e) {}
      return result;
    }
  });

  var _xhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (name && name.toLowerCase() === 'authorization' && value && value.indexOf('Bearer ') === 0) {
      try {
        window.postMessage({ type: '__SHARDTUNE_TOKEN__', token: value.slice(7) }, window.location.origin);
      } catch (e) {}
    }
    return _xhrSetHeader.apply(this, arguments);
  };
})();
