// Runs in the page's MAIN world at document_start, before endstep.cc's own scripts.
// Wraps WebSocket / EventSource / fetch so every frame the game exchanges with the
// server is reported to the isolated bridge script, and lets the extension send
// frames on the game's live socket.
(() => {
  if (window.__endstepLoopMakerHooked) return;
  window.__endstepLoopMakerHooked = true;

  const TAG = '__endstepLoopMaker';
  const NativeWebSocket = window.WebSocket;
  const nativeSend = NativeWebSocket.prototype.send;

  const sockets = new Map();
  let nextSocketId = 1;
  let seq = 0;

  function post(msg) {
    window.postMessage({ [TAG]: 'page', ...msg }, window.location.origin);
  }

  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  function fromBase64(b64) {
    const s = atob(b64);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes.buffer;
  }

  async function encodePayload(data) {
    if (typeof data === 'string') return { enc: 'text', data };
    if (data instanceof ArrayBuffer) return { enc: 'base64', data: toBase64(data) };
    if (ArrayBuffer.isView(data)) {
      return { enc: 'base64', data: toBase64(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) };
    }
    if (data instanceof Blob) return { enc: 'base64', data: toBase64(await data.arrayBuffer()) };
    return { enc: 'unknown', data: String(data) };
  }

  // seq and t are taken synchronously so async Blob decoding can't reorder frames.
  function record(kind, fields, payload) {
    const base = { kind, seq: seq++, t: Date.now(), ...fields };
    if (payload === undefined) {
      post({ type: 'record', record: base });
      return;
    }
    encodePayload(payload).then((p) => post({ type: 'record', record: { ...base, ...p } }));
  }

  class HookedWebSocket extends NativeWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      const id = nextSocketId++;
      this.__elmId = id;
      sockets.set(id, this);
      const wsUrl = String(url);
      record('ws-event', { socket: id, event: 'create', url: wsUrl });
      // Registered before any page listener, so it sees every incoming frame first.
      this.addEventListener('open', () => record('ws-event', { socket: id, event: 'open', url: wsUrl, protocol: this.protocol }));
      this.addEventListener('message', (e) => record('ws', { socket: id, dir: 'in' }, e.data));
      this.addEventListener('error', () => record('ws-event', { socket: id, event: 'error', url: wsUrl }));
      this.addEventListener('close', (e) => {
        record('ws-event', { socket: id, event: 'close', url: wsUrl, code: e.code, reason: e.reason });
        sockets.delete(id);
      });
    }

    send(data) {
      record('ws', { socket: this.__elmId, dir: 'out' }, data);
      return super.send(data);
    }
  }
  window.WebSocket = HookedWebSocket;

  if (window.EventSource) {
    const NativeEventSource = window.EventSource;
    window.EventSource = class HookedEventSource extends NativeEventSource {
      constructor(url, init) {
        super(url, init);
        const esUrl = String(url);
        record('sse-event', { event: 'create', url: esUrl });
        this.addEventListener('message', (e) => record('sse', { dir: 'in', url: esUrl }, e.data));
      }
    };
  }

  // Only method/URL/status: enough to spot HTTP polling without logging auth bodies.
  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init && init.method) || (input instanceof Request ? input.method : 'GET');
    const p = nativeFetch.apply(this, arguments);
    p.then(
      (res) => record('http', { method, url, status: res.status }),
      (err) => record('http', { method, url, error: String(err) })
    );
    return p;
  };

  function listSockets() {
    return [...sockets.entries()].map(([id, ws]) => ({ id, url: ws.url, readyState: ws.readyState }));
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data[TAG] !== 'ext') return;
    const { cmd, reqId } = e.data;
    let result;
    try {
      if (cmd === 'list-sockets') {
        result = { ok: true, sockets: listSockets() };
      } else if (cmd === 'send') {
        const ws = sockets.get(e.data.socket);
        if (!ws) throw new Error(`no open socket ${e.data.socket}`);
        const payload = e.data.enc === 'base64' ? fromBase64(e.data.data) : e.data.data;
        record('ws', { socket: e.data.socket, dir: 'out-ext' }, payload);
        nativeSend.call(ws, payload);
        result = { ok: true };
      } else {
        throw new Error(`unknown command ${cmd}`);
      }
    } catch (err) {
      result = { ok: false, error: String(err && err.message ? err.message : err) };
    }
    post({ type: 'reply', reqId, result });
  });
})();
