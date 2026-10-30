// Isolated-world content script: relays records from ws-hook.js (MAIN world) to the
// service worker in batches, and relays commands from the side panel back to the page.
(() => {
  const ELM = (globalThis.ELM = globalThis.ELM || {});
  const TAG = '__endstepLoopMaker';
  const FLUSH_MS = 250;

  const session = {
    id: crypto.randomUUID(),
    url: location.href,
    startedAt: Date.now(),
  };

  let port = null;
  let buffer = [];
  const pendingReplies = new Map();
  let nextReqId = 1;

  function ensurePort() {
    if (port) return port;
    port = chrome.runtime.connect({ name: 'bridge' });
    port.onDisconnect.addListener(() => {
      port = null;
    });
    port.postMessage({ type: 'hello', session });
    return port;
  }

  function flush() {
    if (buffer.length === 0) return;
    const records = buffer;
    buffer = [];
    try {
      ensurePort().postMessage({ type: 'batch', sessionId: session.id, records });
    } catch {
      // Service worker restarted mid-send; reconnect and retry once.
      port = null;
      try {
        ensurePort().postMessage({ type: 'batch', sessionId: session.id, records });
      } catch {
        buffer = records.concat(buffer);
      }
    }
  }
  setInterval(flush, FLUSH_MS);

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data[TAG] !== 'page') return;
    if (e.data.type === 'record') {
      buffer.push(e.data.record);
      if (ELM.onRecord) ELM.onRecord(e.data.record);
    } else if (e.data.type === 'reply') {
      const resolve = pendingReplies.get(e.data.reqId);
      if (resolve) {
        pendingReplies.delete(e.data.reqId);
        resolve(e.data.result);
      }
    }
  });

  function toPage(cmd, fields) {
    const reqId = nextReqId++;
    return new Promise((resolve) => {
      pendingReplies.set(reqId, resolve);
      window.postMessage({ [TAG]: 'ext', cmd, reqId, ...fields }, location.origin);
      setTimeout(() => {
        if (pendingReplies.delete(reqId)) resolve({ ok: false, error: 'page did not reply' });
      }, 3000);
    });
  }
  ELM.toPage = toPage;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.target !== 'page') return false;
    const { target, cmd, ...fields } = msg;
    toPage(cmd, fields).then(sendResponse);
    return true;
  });
})();
