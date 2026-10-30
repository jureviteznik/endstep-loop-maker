import { listSessions, getRecords, deleteSession } from '../shared/db.js';

const MAX_LIVE = 300;
const $ = (id) => document.getElementById(id);

let activeTabId = null;

// The panel may live in its own popup window (Opera), so don't rely on currentWindow:
// prefer an endstep tab that is active in its window, else the most recently used one.
async function findEndstepTab() {
  const tabs = await chrome.tabs.query({ url: ['https://endstep.cc/*', 'https://*.endstep.cc/*'] });
  tabs.sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
  const tab = tabs[0];
  const ok = Boolean(tab);
  activeTabId = ok ? tab.id : null;
  $('tab-status').textContent = ok ? 'connected to endstep tab' : 'no endstep tab';
  $('tab-status').classList.toggle('on', ok);
  return activeTabId;
}

function toPage(cmd, fields = {}) {
  if (activeTabId == null) return Promise.resolve({ ok: false, error: 'no endstep tab' });
  return chrome.tabs
    .sendMessage(activeTabId, { target: 'page', cmd, ...fields })
    .catch((err) => ({ ok: false, error: String(err.message || err) }));
}

// --- settings ---
chrome.storage.local.get({ useMacro: true }).then((v) => {
  $('use-macro').checked = v.useMacro;
});
$('use-macro').addEventListener('change', (e) => chrome.storage.local.set({ useMacro: e.target.checked }));

// --- capture toggle ---
chrome.storage.local.get({ capturing: true }).then((v) => {
  $('capturing').checked = v.capturing;
});
$('capturing').addEventListener('change', (e) => chrome.storage.local.set({ capturing: e.target.checked }));

// --- sockets ---
async function refreshSockets() {
  await findEndstepTab();
  const res = await toPage('list-sockets');
  const list = $('sockets');
  const select = $('send-socket');
  list.replaceChildren();
  select.replaceChildren();
  if (!res.ok) {
    list.append(li(res.error));
    return;
  }
  if (res.sockets.length === 0) list.append(li('no open sockets (reload the page after installing)'));
  const states = ['connecting', 'open', 'closing', 'closed'];
  for (const s of res.sockets) {
    list.append(li(`#${s.id} ${states[s.readyState]} ${s.url}`));
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `#${s.id} ${new URL(s.url).host}`;
    select.append(opt);
  }
}

function li(text) {
  const el = document.createElement('li');
  const span = document.createElement('span');
  span.className = 'grow';
  span.textContent = text;
  span.title = text;
  el.append(span);
  return el;
}

// --- live tail ---
function recordClass(r) {
  if (r.kind === 'ws' || r.kind === 'sse') return r.dir;
  return 'other';
}

function preview(r) {
  if (r.kind === 'ws' || r.kind === 'sse') {
    const body = r.enc === 'base64' ? `[binary ${Math.floor((r.data.length * 3) / 4)}B] ${r.data}` : r.data;
    return body.length > 200 ? body.slice(0, 200) + '…' : body;
  }
  if (r.kind === 'http') return `${r.method} ${r.status ?? r.error} ${r.url}`;
  return `${r.event} ${r.url ?? ''} ${r.code ?? ''} ${r.reason ?? ''}`.trim();
}

function prettyBody(r) {
  if (r.enc !== 'text') return r.data ?? JSON.stringify(r, null, 2);
  try {
    return JSON.stringify(JSON.parse(r.data), null, 2);
  } catch {
    return r.data;
  }
}

function filterAllows(cls) {
  if (cls === 'in') return $('show-in').checked;
  if (cls === 'out' || cls === 'out-ext') return $('show-out').checked;
  return $('show-other').checked;
}

function appendLive(r) {
  const cls = recordClass(r);
  const el = document.createElement('li');
  el.className = cls;
  el.dataset.cls = cls;
  el.hidden = !filterAllows(cls);
  const time = new Date(r.t).toLocaleTimeString();
  const arrow = { in: '◀', out: '▶', 'out-ext': '▶▶' }[cls] || '•';
  el.innerHTML = `<span class="meta"></span> <span class="dir"></span> <span class="body"></span>`;
  el.querySelector('.meta').textContent = `${time}${r.socket ? ' #' + r.socket : ''}`;
  el.querySelector('.dir').textContent = arrow;
  el.querySelector('.body').textContent = preview(r);
  el.addEventListener('click', () => {
    const existing = el.querySelector('pre');
    if (existing) return existing.remove();
    const pre = document.createElement('pre');
    pre.textContent = prettyBody(r);
    el.append(pre);
  });
  const log = $('live');
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
  log.append(el);
  while (log.children.length > MAX_LIVE) log.firstChild.remove();
  if (atBottom) log.scrollTop = log.scrollHeight;
}

for (const id of ['show-in', 'show-out', 'show-other']) {
  $(id).addEventListener('change', () => {
    for (const el of $('live').children) el.hidden = !filterAllows(el.dataset.cls);
  });
}
$('clear-live').addEventListener('click', () => $('live').replaceChildren());

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'live' || msg.tabId !== activeTabId) return;
  for (const r of msg.records) {
    appendLive(r);
    if (r.kind === 'ws-event' && (r.event === 'open' || r.event === 'close')) refreshSockets();
  }
});

// --- sessions ---
async function refreshSessions() {
  const list = $('sessions');
  list.replaceChildren();
  const sessions = await listSessions();
  if (sessions.length === 0) list.append(li('no captures yet'));
  for (const s of sessions) {
    const el = li(`${new Date(s.startedAt).toLocaleString()} · ${s.count} records · ${new URL(s.url).pathname}`);
    const exp = document.createElement('button');
    exp.className = 'small';
    exp.textContent = 'Export';
    exp.addEventListener('click', () => exportSession(s));
    const del = document.createElement('button');
    del.className = 'small';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      if (!confirm('Delete this capture?')) return;
      await deleteSession(s.id);
      refreshSessions();
    });
    el.append(exp, del);
    list.append(el);
  }
}

async function exportSession(session) {
  const records = (await getRecords(session.id)).map(({ sessionId, ...r }) => r);
  const { count, ...meta } = session;
  const blob = new Blob([JSON.stringify({ format: 'endstep-capture', version: 1, session: meta, records }, null, 1)], {
    type: 'application/json',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `endstep-capture-${new Date(session.startedAt).toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// --- raw send ---
$('send').addEventListener('click', async () => {
  const socket = Number($('send-socket').value);
  if (!socket) {
    $('send-result').textContent = 'pick a socket (Refresh first)';
    return;
  }
  const res = await toPage('send', { socket, enc: $('send-enc').value, data: $('send-data').value });
  $('send-result').textContent = res.ok ? 'sent' : `error: ${res.error}`;
});

// --- game & combos ---
function toCombo(cmd, fields = {}) {
  if (activeTabId == null) return Promise.resolve(null);
  return chrome.tabs.sendMessage(activeTabId, { target: 'combo', cmd, ...fields }).catch(() => null);
}

const iterationInputs = new Map(); // combo id -> chosen iteration count, survives re-render
const pickTargets = new Map(); // combo id -> pick targets myself
let deferredStatus = null;

// Status pushes arrive constantly in a game; don't rebuild the list under a focused input.
// When focus moves to a button in the list (the Run click), leave the DOM alone so the click
// lands; the status push that follows the click re-renders.
$('combos').addEventListener('focusout', (e) => {
  if (e.relatedTarget && $('combos').contains(e.relatedTarget)) return;
  if (deferredStatus) {
    const s = deferredStatus;
    deferredStatus = null;
    setTimeout(() => renderStatus(s));
  }
});

function renderStatus(s) {
  const focused = document.activeElement;
  if (focused && focused.tagName === 'INPUT' && $('combos').contains(focused)) {
    deferredStatus = s;
    return;
  }
  if (!s || !s.inGame) {
    $('game-info').textContent = 'Not in a game.';
    $('prompt-info').textContent = '';
    $('combos').replaceChildren();
    $('executor-info').textContent = '';
    return;
  }
  $('game-info').textContent = `Playing as ${s.player || '?'}.`;
  const macro = s.macro && s.macro.state !== 'IDLE' ? ` · macro ${s.macro.state.toLowerCase()}` : '';
  $('prompt-info').textContent = (s.prompt ? `Prompt: ${s.prompt.type} — ${s.prompt.message}` : 'Waiting on opponent.') + macro;

  const ex = s.executor;
  const list = $('combos');
  list.replaceChildren();
  for (const c of s.combos) {
    const el = document.createElement('li');
    const head = document.createElement('div');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = c.name;
    const state = document.createElement('span');
    const cls = c.ready ? 'ready' : c.assembled ? 'assembled' : 'missing';
    state.className = `state ${cls}`;
    state.textContent = c.ready ? 'ready' : c.assembled ? 'assembled — waiting for priority' : 'not assembled';
    head.append(name, state);
    el.append(head);

    const desc = document.createElement('p');
    desc.className = 'hint';
    desc.textContent = c.missing.length ? `Missing: ${c.missing.join(', ')}` : c.description;
    el.append(desc);

    const row = document.createElement('div');
    row.className = 'row';
    const count = document.createElement('input');
    count.type = 'number';
    count.min = '1';
    count.max = '1000';
    count.value = iterationInputs.get(c.id) || '5';
    count.addEventListener('input', () => iterationInputs.set(c.id, count.value));
    const runningThis = ex.running && ex.comboId === c.id;
    const btn = document.createElement('button');
    btn.textContent = runningThis ? 'Stop' : 'Run';
    btn.disabled = !runningThis && (ex.running || !c.ready);
    btn.addEventListener('click', async () => {
      if (runningThis) await toCombo('stop');
      else
        await toCombo('run', {
          comboId: c.id,
          iterations: Number(count.value),
          useMacro: $('use-macro').checked,
          pickTargets: Boolean(pickTargets.get(c.id)),
        });
      refreshCombos();
    });
    row.title = 'One iteration = one full loop back to the starting board (for the Retriever pair: both Retrievers recast).';
    const unit = c.unit.charAt(0).toUpperCase() + c.unit.slice(1);
    row.append(unit, count, btn);
    el.append(row);
    if (!c.macro) {
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = 'Always played by hand (no endstep macro).';
      el.append(note);
    }
    if (c.choosesTargets) {
      const label = document.createElement('label');
      label.className = 'row';
      label.title = "Off: targets the opponent's permanents automatically (creatures first, then other nonlands, then lands).";
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = Boolean(pickTargets.get(c.id));
      box.addEventListener('change', () => pickTargets.set(c.id, box.checked));
      label.append(box, ' Pick targets myself in the game');
      el.append(label);
    }
    list.append(el);
  }
  $('executor-info').textContent = ex.message || '';
}

async function refreshCombos() {
  await findEndstepTab();
  renderStatus(await toCombo('status'));
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'combo-status' && sender.tab && sender.tab.id === activeTabId) renderStatus(msg.status);
});

// --- wiring ---
$('refresh-sockets').addEventListener('click', refreshSockets);
$('refresh-sessions').addEventListener('click', refreshSessions);
chrome.tabs.onActivated.addListener(refreshSockets);
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete') refreshSockets();
});

refreshSockets();
refreshSessions();
refreshCombos();
setInterval(refreshSessions, 5000);
