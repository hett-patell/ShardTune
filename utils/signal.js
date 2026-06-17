export class SignalClient {
  #ws = null;
  #peerId;
  #token;
  #heartbeat = null;

  constructor(peerId, options = {}) {
    this.#peerId = peerId;
    this.#token = options.token || crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  }

  get peerId() { return this.#peerId; }

  onOpen = null;
  onOffer = null;
  onAnswer = null;
  onCandidate = null;
  onError = null;
  onClose = null;
  onExpire = null;

  async connect() {
    return new Promise((resolve, reject) => {
      const url = `wss://0.peerjs.com/peerjs?key=peerjs&id=${encodeURIComponent(this.#peerId)}&token=${this.#token}`;
      this.#ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        reject(new Error('Signaling connection timed out'));
        this.close();
      }, 10000);

      this.#ws.onopen = () => {
        this.#heartbeat = setInterval(() => {
          if (this.#ws?.readyState === WebSocket.OPEN) {
            this.#ws.send(JSON.stringify({ type: 'HEARTBEAT' }));
          }
        }, 25000);
      };

      this.#ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }

        switch (msg.type) {
          case 'OPEN':
            clearTimeout(timeout);
            this.onOpen?.();
            resolve();
            break;
          case 'OFFER':
            this.onOffer?.(msg.src, msg.payload);
            break;
          case 'ANSWER':
            this.onAnswer?.(msg.src, msg.payload);
            break;
          case 'CANDIDATE':
            this.onCandidate?.(msg.src, msg.payload);
            break;
          case 'EXPIRE':
            this.onExpire?.(msg.src);
            break;
          case 'ERROR':
            this.onError?.(new Error(msg.payload?.msg || 'Signaling error'));
            break;
          case 'ID-TAKEN':
            clearTimeout(timeout);
            reject(new Error('Peer ID already taken'));
            break;
        }
      };

      this.#ws.onerror = () => {
        clearTimeout(timeout);
        this.onError?.(new Error('WebSocket error'));
        reject(new Error('Signaling connection failed'));
      };

      this.#ws.onclose = () => {
        clearTimeout(timeout);
        clearInterval(this.#heartbeat);
        this.#heartbeat = null;
        this.onClose?.();
      };
    });
  }

  send(type, dst, payload) {
    if (this.#ws?.readyState !== WebSocket.OPEN) return;
    this.#ws.send(JSON.stringify({
      type,
      src: this.#peerId,
      dst,
      payload
    }));
  }

  close() {
    clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    if (this.#ws) {
      this.#ws.onclose = null;
      this.#ws.close();
      this.#ws = null;
    }
  }
}
