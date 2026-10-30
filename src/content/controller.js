// Isolated-world glue: feeds socket records into the tracker, sends GAME_ACTIONs on the
// site socket, and serves combo status/commands to the side panel.
(() => {
  const ELM = globalThis.ELM;
  const BROADCAST_MS = 150;

  const tracker = new ELM.GameTracker();
  const combos = ELM.builtinCombos;

  async function actionSocketId() {
    let id = tracker.actionSocketId();
    if (id != null) return id;
    // Extension loaded after the page opened its sockets: ask the hook directly.
    const res = await ELM.toPage('list-sockets');
    if (res.ok) for (const s of res.sockets) tracker.sockets.set(s.id, s.url);
    return tracker.actionSocketId();
  }

  async function sendAction(type, fields) {
    const socket = await actionSocketId();
    if (socket == null) return { ok: false, error: 'site socket not found (reload the page)' };
    if (!tracker.matchId) return { ok: false, error: 'no match attached' };
    const msg = {
      type: 'GAME_ACTION',
      payload: { type, ...fields, matchId: tracker.matchId, actionId: crypto.randomUUID() },
    };
    return ELM.toPage('send', { socket, enc: 'text', data: JSON.stringify(msg) });
  }

  async function sendMacro(action, count) {
    const socket = await actionSocketId();
    if (socket == null) return { ok: false, error: 'site socket not found (reload the page)' };
    if (!tracker.matchId) return { ok: false, error: 'no match attached' };
    const payload = { matchId: tracker.matchId, action };
    if (count != null) payload.count = count;
    return ELM.toPage('send', { socket, enc: 'text', data: JSON.stringify({ type: 'MACRO', payload }) });
  }

  const executor = new ELM.ComboExecutor(tracker, sendAction, scheduleBroadcast, sendMacro);

  function snapshot() {
    const p = tracker.prompt;
    const me = tracker.me();
    const macro = tracker.state && tracker.state.macro;
    return {
      inGame: Boolean(tracker.state),
      player: me ? me.name : null,
      prompt: p ? { type: p.type, message: (p.message || '').split('\n')[0], version: p.promptVersion } : null,
      macro: macro ? { state: macro.state, lastStop: macro.lastStop || null } : null,
      combos: combos.map((c) => ELM.comboStatus(c, tracker)),
      executor: { ...executor.status },
    };
  }

  let broadcastTimer = null;
  function scheduleBroadcast() {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      chrome.runtime.sendMessage({ type: 'combo-status', status: snapshot() }).catch(() => {});
    }, BROADCAST_MS);
  }
  tracker.onChange(scheduleBroadcast);

  ELM.onRecord = (record) => tracker.ingest(record);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.target !== 'combo') return false;
    if (msg.cmd === 'status') {
      sendResponse(snapshot());
    } else if (msg.cmd === 'run') {
      const combo = combos.find((c) => c.id === msg.comboId);
      if (!combo) {
        sendResponse({ ok: false, error: 'unknown combo' });
      } else if (executor.status.running) {
        sendResponse({ ok: false, error: 'a combo is already running' });
      } else {
        executor.run(combo, msg.iterations, { useMacro: msg.useMacro !== false, pickTargets: Boolean(msg.pickTargets) });
        sendResponse({ ok: true });
      }
    } else if (msg.cmd === 'stop') {
      executor.stop();
      sendResponse({ ok: true });
    }
    return false;
  });
})();
