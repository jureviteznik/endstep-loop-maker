// Replays a captured bot game through the tracker, matcher and executor.
// The fake engine feeds recorded server frames; every action the executor sends must equal
// the action the player sent by hand at that point in the recording.
//
// Run: npm test   (or, without Node installed, VS Code's bundled one:
//   ELECTRON_RUN_AS_NODE=1 "<VS Code>/Code.exe" tests/replay.test.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('../src/game/tracker.js');
require('../src/combos/builtin.js');
require('../src/combos/matcher.js');
require('../src/combos/executor.js');
const ELM = globalThis.ELM;

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'endstep-capture-2026-10-30T15-44-05-008Z.json');
// The player's second hand-recorded run: two full iterations of the Altar/Retriever loop.
const LOOP_START_SEQ = 934;
const LOOP_END_SEQ = 1020;
// The player's RECORD_START for that run (an earlier attempt was cancelled after a misclick).
const MACRO_RECORD_SEQ = 924;

function loadRecords(file = FIXTURE) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).records.filter((r) => r.kind === 'ws');
}

function isPlayerAction(r) {
  if ((r.dir !== 'out' && r.dir !== 'out-ext') || !r.data.includes('"GAME_ACTION"')) return false;
  return !JSON.parse(r.data).payload.type.startsWith('SET_');
}

function comparable(payload) {
  const { matchId, actionId, autoPassAfter, ...rest } = payload;
  return rest;
}

function makeReplay(file) {
  const records = loadRecords(file);
  const tracker = new ELM.GameTracker();
  let i = 0;
  const feedUntil = (stop) => {
    while (i < records.length && !stop(records[i])) tracker.ingest(records[i++]);
  };
  return { records, tracker, feedUntil, next: () => records[i], advance: () => i++ };
}

test('the Altar/Retriever combo is ready right before the recorded loop', { skip: !fs.existsSync(FIXTURE) }, () => {
  const { tracker, feedUntil } = makeReplay();
  feedUntil((r) => r.seq >= LOOP_START_SEQ);
  const combo = ELM.builtinCombos.find((c) => c.id === 'altar-retriever-pair');
  const status = ELM.comboStatus(combo, tracker);
  assert.equal(status.assembled, true, `missing: ${status.missing}`);
  assert.equal(status.ready, true);
  assert.equal(tracker.me().name, 'Nikey');
});

function isMacro(r) {
  return r.dir === 'out' && r.data.startsWith('{"type":"MACRO"');
}

// Fake engine: each send must match the next outgoing frame in the recording (a player action
// or a macro command); then the recorded server frames up to the following send are replayed.
function fakeEngine(replay, { endSeq = Infinity, isSend }) {
  const sent = [];
  const answer = () => setTimeout(() => replay.feedUntil((r) => isSend(r) || r.seq >= endSeq));
  const sendAction = async (type, fields) => {
    const expected = replay.next();
    assert.ok(expected && isPlayerAction(expected), `executor sent ${type} but the recording expects ${expected && expected.data.slice(0, 80)}`);
    const actual = comparable({ type, ...fields });
    assert.deepEqual(actual, comparable(JSON.parse(expected.data).payload), `send #${sent.length + 1}`);
    sent.push(actual);
    replay.advance();
    answer();
    return { ok: true };
  };
  const sendMacro = async (action, count) => {
    const expected = replay.next();
    assert.ok(expected && isMacro(expected), `executor sent MACRO ${action} but the recording expects ${expected && expected.data.slice(0, 80)}`);
    // Counts differ by design (the player asked for 3 each time); the action must match.
    assert.equal(action, JSON.parse(expected.data).payload.action, `send #${sent.length + 1}`);
    sent.push({ macro: action, count });
    replay.advance();
    answer();
    return { ok: true };
  };
  return { sent, sendAction, sendMacro };
}

const combo = () => ELM.builtinCombos.find((c) => c.id === 'altar-retriever-pair');

test('the executor reproduces a hand-played loop (both Retrievers)', { skip: !fs.existsSync(FIXTURE) }, async () => {
  const replay = makeReplay();
  replay.feedUntil((r) => r.seq >= LOOP_START_SEQ);
  const engine = fakeEngine(replay, { endSeq: LOOP_END_SEQ, isSend: isPlayerAction });

  const executor = new ELM.ComboExecutor(replay.tracker, engine.sendAction, () => {});
  await executor.run(combo(), 1);

  assert.equal(executor.status.message, 'Done: 1 iteration(s).');
  assert.equal(engine.sent.length, 18);
});

// The recording has the player starting a macro recording, playing one full cycle (2 iterations),
// then pressing RUN five times; each run completed one loop before the server stopped it.
test('macro mode records one cycle, then re-runs the server macro whenever it stops', { skip: !fs.existsSync(FIXTURE) }, async () => {
  const replay = makeReplay();
  replay.feedUntil((r) => r.seq >= MACRO_RECORD_SEQ);
  const engine = fakeEngine(replay, { isSend: (r) => isPlayerAction(r) || isMacro(r) });

  const executor = new ELM.ComboExecutor(replay.tracker, engine.sendAction, () => {}, engine.sendMacro);
  await executor.run(combo(), 6, { useMacro: true });

  assert.equal(executor.status.message, 'Done: 6 iteration(s) (5 by macro, 1 by hand).');
  const macros = engine.sent.filter((s) => s.macro);
  assert.deepEqual(macros.map((m) => m.macro), ['RECORD_START', 'RECORD_STOP', 'RUN', 'RUN', 'RUN', 'RUN', 'RUN']);
  // The first run only manages one loop, so later runs ask for exactly one.
  assert.deepEqual(macros.filter((m) => m.macro === 'RUN').map((m) => m.count), [5, 1, 1, 1, 1]);
  assert.equal(engine.sent.length - macros.length, 18, 'only the recorded loop is played by hand');
});

function setMacroState(tracker, state) {
  const payload = { ...tracker.state, macro: { ...tracker.state.macro, state } };
  tracker.ingest({ kind: 'ws', dir: 'in', enc: 'text', data: JSON.stringify({ type: 'GAME_STATE', matchId: tracker.matchId, payload }) });
}

test('a macro that never starts is discarded and the loop carries on by hand', { skip: !fs.existsSync(FIXTURE) }, async () => {
  const replay = makeReplay();
  replay.feedUntil((r) => r.seq >= MACRO_RECORD_SEQ);
  const engine = fakeEngine(replay, { isSend: (r) => isPlayerAction(r) || isMacro(r) });
  const log = [];
  let recorded = false;
  const sendMacro = async (action, count) => {
    log.push(action);
    if (action === 'RECORD_STOP') recorded = true;
    if (!recorded || action === 'RECORD_STOP') return engine.sendMacro(action, count);
    // After the recording the server goes silent: RUN does nothing, DISCARD clears it.
    if (action === 'DISCARD') setTimeout(() => setMacroState(replay.tracker, 'IDLE'));
    return { ok: true };
  };
  const sendAction = async (type, fields) => {
    log.push(type);
    // The recording has no hand-played loop after this point; end the test there.
    if (recorded) return { ok: false, error: 'end of recording' };
    return engine.sendAction(type, fields);
  };

  const executor = new ELM.ComboExecutor(replay.tracker, sendAction, () => {}, sendMacro);
  executor.macroStallMs = 50;
  await executor.run(combo(), 2, { useMacro: true });

  const afterStop = log.slice(log.indexOf('RECORD_STOP') + 1);
  assert.deepEqual(afterStop.slice(0, 3), ['RUN', 'DISCARD', 'PLAY_CARD'], 'drops the stuck macro, then plays by hand');
  // The macro failure, then the end of the recording: one retry by hand before giving up.
  assert.match(executor.status.message, /^Stopped after 1 iteration\(s\) \(recovered 2×\): Could not send PLAY_CARD/);
});

// Mid-loop: one Retriever was sacrificed and the other returned to hand, the run broke off there.
test('recovery finishes a loop that broke off with a Retriever in hand', { skip: !fs.existsSync(FIXTURE) }, async () => {
  const replay = makeReplay();
  replay.feedUntil((r) => r.seq >= 953);
  const c = combo();
  assert.equal(ELM.checkPieces(c, replay.tracker.me()).assembled, false);
  const engine = fakeEngine(replay, { endSeq: LOOP_END_SEQ, isSend: isPlayerAction });

  const executor = new ELM.ComboExecutor(replay.tracker, engine.sendAction, () => {});
  await executor.recover(c);

  assert.deepEqual(engine.sent.map((s) => s.type), ['PLAY_CARD', 'AUTO_PAY', 'PASS_PRIORITY', 'YES', 'PASS_PRIORITY']);
  assert.equal(ELM.checkPieces(c, replay.tracker.me()).assembled, true);
});

// Second game: no Eldrazi Spawn tokens, so Forge sacrificed the only creature without asking,
// and a spare Myr Retriever sat in hand next to the one the trigger returned.
const FIXTURE_NO_SAC_PROMPT = path.join(__dirname, '..', 'fixtures', 'endstep-capture-2026-10-30T16-48-44-635Z.json');

test('skips a sacrifice prompt the engine never asks, then recasts the returned Retriever', { skip: !fs.existsSync(FIXTURE_NO_SAC_PROMPT) }, async () => {
  const replay = makeReplay(FIXTURE_NO_SAC_PROMPT);
  replay.feedUntil(isPlayerAction);
  const engine = fakeEngine(replay, { isSend: isPlayerAction });
  const attempts = [];
  const sendAction = async (type, fields) => {
    attempts.push({ type, ...fields });
    if (!replay.next()) return { ok: false, error: 'end of recording' };
    return engine.sendAction(type, fields);
  };

  const executor = new ELM.ComboExecutor(replay.tracker, sendAction, () => {});
  await executor.run(combo(), 1);

  // (The 5th attempt is the retry after the recording runs out.)
  assert.deepEqual(attempts.slice(0, 4).map((a) => a.type), ['PLAY_CARD', 'CHOOSE_TARGETS', 'PASS_PRIORITY', 'PLAY_CARD']);
  assert.equal(attempts[3].cardId, 52, 'recasts the Retriever the trigger returned, not the spare (54)');
});

// --- Giant's Boulder loop: no capture yet, so these run against a small simulated engine. ---

function synthState(tracker, fields) {
  tracker.ingest({ kind: 'ws', dir: 'in', enc: 'text', data: JSON.stringify({ type: 'GAME_STATE', matchId: 'm', payload: { status: 'ACTIVE', stack: [], ...fields } }) });
}

const card = (id, name, zone, extra = {}) => ({ id, name, zone, ownerName: 'Me', ...extra });

// Forge-like payment: tapping the Altar asks what to sacrifice and puts {C}{C} toward the cost
// (the rest floats); Energy Refractor asks for its own {2} first, then pays one colored symbol.
function paymentEngine(tracker, { cost, floating = 0, golems = 3 }) {
  const me = { id: '0', name: 'Me', battlefield: [], hand: [], graveyard: [], exile: [] };
  const sources = [card(1, "Ashnod's Altar", 'Battlefield'), card(2, 'Energy Refractor', 'Battlefield')];
  let golemIds = Array.from({ length: golems }, (_, i) => 100 + i);
  const payments = [{ generic: cost.generic, colors: [...cost.colors], for: 'Blood Fountain' }];
  let pool = floating;
  let pv = 1;
  const log = [];
  const fmt = (p) => `${p.generic ? `{${p.generic}}` : ''}${p.colors.map((c) => `{${c}}`).join('')}`;
  const show = (pendingAction) => synthState(tracker, { players: [me], pendingAction: { promptVersion: pv++, ...pendingAction } });
  const showPayment = () => {
    if (!payments.length) return show({ type: 'PRIORITY', message: 'Choose a spell or ability to play, or pass priority', cardOptions: [] });
    const top = payments[payments.length - 1];
    show({ type: 'PAY_MANA', message: `Pay ${fmt(top)} for ${top.for}`, remainingCost: fmt(top), floatingMana: pool ? { colorless: pool } : {}, cardOptions: sources });
  };
  const applyGeneric = (n) => {
    const top = payments[payments.length - 1];
    const used = Math.min(n, top.generic);
    top.generic -= used;
    pool += n - used;
  };
  const settle = () => {
    while (payments.length) {
      const top = payments[payments.length - 1];
      if (top.generic || top.colors.length) break;
      payments.pop();
      if (top.for === 'Energy Refractor') payments[payments.length - 1].colors.shift(); // its {B}
    }
  };
  const sendAction = async (type, fields) => {
    log.push(type === 'CHOOSE_CARDS' ? `${type} ${fields.orderedCards}` : type === 'TAP_MANA' ? `${type} ${fields.cardId}` : type);
    setTimeout(() => {
      if (type === 'TAP_MANA' && fields.cardId === 1) {
        show({ type: 'CHOOSE_CARDS', message: "Sacrifice 1 Creature for Ashnod's Altar", cardOptions: [...golemIds.map((id) => card(id, 'Golem Token', 'Battlefield')), card(50, 'Myr Retriever', 'Battlefield')] });
        return;
      }
      if (type === 'CHOOSE_CARDS') {
        assert.ok(golemIds.includes(fields.orderedCards[0]), 'only Golems are sacrificed for mana');
        golemIds = golemIds.filter((id) => id !== fields.orderedCards[0]);
        applyGeneric(2);
      } else if (type === 'TAP_MANA' && fields.cardId === 2) {
        payments.push({ generic: 2, colors: [], for: 'Energy Refractor' });
      } else if (type === 'AUTO_PAY') {
        const top = payments[payments.length - 1];
        assert.ok(!top.colors.length && pool >= top.generic, `AUTO_PAY only when the pool covers ${fmt(top)} (pool ${pool})`);
        pool -= top.generic;
        top.generic = 0;
      } else {
        assert.fail(`unexpected ${type}`);
      }
      settle();
      showPayment();
    });
    return { ok: true };
  };
  return { sendAction, log, start: showPayment, golemsLeft: () => golemIds.length, pool: () => pool };
}

const boulder = () => ELM.builtinCombos.find((c) => c.id === 'boulder-destroy-loop');

test('pays {3}{B} with Golems and Energy Refractor, using floating mana', async () => {
  const tracker = new ELM.GameTracker();
  tracker.ingest({ kind: 'ws', dir: 'in', enc: 'text', data: JSON.stringify({ type: 'ATTACHED', payload: { audience: '0', matchId: 'm' } }) });
  const engine = paymentEngine(tracker, { cost: { generic: 3, colors: ['B'] }, floating: 1 });
  engine.start();
  const executor = new ELM.ComboExecutor(tracker, engine.sendAction, () => {});
  executor.combo = boulder();
  await executor.pay();

  assert.deepEqual(engine.log, ['TAP_MANA 2', 'TAP_MANA 1', 'CHOOSE_CARDS 100', 'TAP_MANA 1', 'CHOOSE_CARDS 101', 'AUTO_PAY']);
  assert.equal(tracker.prompt.type, 'PRIORITY');
  assert.equal(engine.golemsLeft(), 1);
});

test('auto targets go after the opponent\'s best creature, Blood Fountain takes both Retrievers', () => {
  const tracker = new ELM.GameTracker();
  tracker.ingest({ kind: 'ws', dir: 'in', enc: 'text', data: JSON.stringify({ type: 'ATTACHED', payload: { audience: '0', matchId: 'm' } }) });
  synthState(tracker, { players: [{ id: '0', name: 'Me', battlefield: [], hand: [], graveyard: [] }] });
  const executor = new ELM.ComboExecutor(tracker, async () => ({ ok: true }), () => {});
  const loop = boulder().loop;
  const destroy = loop[2].answers.find((a) => a.prompt === 'CHOOSE_TARGETS');
  const bot = (id, name, types, cmc) => ({ id, name, zone: 'Battlefield', types, cmc, ownerName: 'Bot' });
  const targets = {
    type: 'CHOOSE_TARGETS',
    max: 1,
    cardOptions: [bot(10, 'Forest', ['Land'], 0), bot(11, 'Sol Ring', ['Artifact'], 1), card(12, 'Golem Token', 'Battlefield', { types: ['Creature'] }), bot(13, 'Llanowar Elves', ['Creature'], 1), bot(14, 'Craterhoof Behemoth', ['Creature'], 8)],
  };
  assert.deepEqual(executor.fields(destroy, targets).targets, [14]);
  targets.cardOptions = targets.cardOptions.filter((c) => c.types[0] !== 'Creature' || c.ownerName === 'Me');
  assert.deepEqual(executor.fields(destroy, targets).targets, [11], 'then nonland permanents, never my own');

  const fountain = loop.find((s) => s.do === 'RESOLVE' && s.answers.some((a) => a.cards)).answers[0];
  const myrs = { type: 'CHOOSE_TARGETS', max: 2, cardOptions: [card(50, 'Myr Retriever', 'Graveyard'), card(51, 'Myr Retriever', 'Graveyard'), card(60, 'Golem Foundry', 'Graveyard')] };
  assert.deepEqual(executor.fields(fountain, myrs).targets, [50, 51]);
});

// Capture 2026-10-30T23-09-48: RUN 4 sent nothing until one GAME_STATE with the result,
// macro ARMED done=3/4 ("it ran for as long as one turn of play should"); no RUNNING state.
test('a macro run that only reports its result is counted, not discarded', async () => {
  const tracker = new ELM.GameTracker();
  tracker.ingest({ kind: 'ws', dir: 'in', enc: 'text', data: JSON.stringify({ type: 'ATTACHED', payload: { audience: '0', matchId: 'm' } }) });
  const priority = (v) => ({ type: 'PRIORITY', message: 'Choose a spell or ability to play, or pass priority', cardOptions: [], promptVersion: v });
  const players = [{ id: '0', name: 'Me', battlefield: [], hand: [], graveyard: [] }];
  synthState(tracker, { players, pendingAction: priority(401), macro: { state: 'ARMED', stepCount: 16, iterationsDone: 0, iterationsRequested: 0 } });
  const sendMacro = async (action, count) => {
    assert.equal(action, 'RUN');
    setTimeout(() => {
      // An unrelated delta first (the real one only bumps sequenceNumber), then the result.
      synthState(tracker, { players, pendingAction: priority(401), macro: { state: 'ARMED', stepCount: 16, iterationsDone: 0, iterationsRequested: 0 } });
      synthState(tracker, { players, pendingAction: priority(449), macro: { state: 'ARMED', stepCount: 16, iterationsDone: 3, iterationsRequested: count, lastStop: 'The macro stopped: it ran for as long as one turn of play should.' } });
    }, 30);
    return { ok: true };
  };
  const executor = new ELM.ComboExecutor(tracker, async () => ({ ok: true }), () => {}, sendMacro);
  assert.equal(await executor.runMacro(4), 3);
});

// Capture 2026-10-30T23-09-48: the site's UI activates the Boulder with
// PLAY_CARD {cardId: 46, abilityIndex: 1} straight from playableAbilities, no CHOOSE_ABILITY.
test('the Boulder is activated with its destroy ability index in one message', () => {
  const tracker = new ELM.GameTracker();
  const executor = new ELM.ComboExecutor(tracker, async () => ({ ok: true }), () => {});
  const step = boulder().loop.find((s) => s.do === 'PLAY_CARD' && s.ability);
  const prompt = {
    type: 'PRIORITY',
    cardOptions: [
      card(46, "Giant's Boulder", 'Battlefield', {
        playableAbilities: [
          { index: 0, description: '{1}, {T}: Add one mana of any color.' },
          { index: 1, description: '{7}, {T}, Sacrifice this artifact: Destroy target permanent.' },
        ],
      }),
    ],
  };
  assert.deepEqual(executor.fields(step, prompt), { cardId: 46, abilityIndex: 1, autoPassAfter: false });
});

// Third game (forge-w6): after the page's routine REFRESH the server stopped sending `macro` in
// GAME_STATE, so RECORD_START was never confirmed. The runner then played by hand while the
// server was still recording, and the macro ended up with 80 steps.
const FIXTURE_NO_MACRO_STATE = path.join(__dirname, '..', 'fixtures', 'endstep-capture-2026-10-31T19-43-12-246Z.json');

function replayToFirstExtAction() {
  const replay = makeReplay(FIXTURE_NO_MACRO_STATE);
  replay.feedUntil((r) => r.dir === 'out-ext' && isPlayerAction(r));
  return replay;
}

test('without macro reports, loops are played by hand and no recording is started', { skip: !fs.existsSync(FIXTURE_NO_MACRO_STATE) }, async () => {
  const replay = replayToFirstExtAction();
  assert.equal(replay.tracker.macroReported, false);
  const engine = fakeEngine(replay, { isSend: isPlayerAction });
  const macros = [];
  const executor = new ELM.ComboExecutor(replay.tracker, engine.sendAction, () => {}, async (a) => (macros.push(a), { ok: true }));
  await executor.run(combo(), 2, { useMacro: true });

  assert.deepEqual(macros, []);
  assert.equal(executor.status.message, "Done: 2 iteration(s) (endstep wasn't reporting macro state, so 2 played by hand).");
});

test('an unconfirmed recording is stopped and discarded before anything is played by hand', { skip: !fs.existsSync(FIXTURE_NO_MACRO_STATE) }, async () => {
  const replay = replayToFirstExtAction();
  replay.tracker.macroReported = true; // as if the last state still had it; RECORDING never comes
  const engine = fakeEngine(replay, { isSend: isPlayerAction });
  const log = [];
  const sendAction = async (type, fields) => (log.push(type), engine.sendAction(type, fields));
  const sendMacro = async (action) => (log.push(action), { ok: true });
  const executor = new ELM.ComboExecutor(replay.tracker, sendAction, () => {}, sendMacro);
  executor.macroProbeMs = 20;
  executor.macroStallMs = 50;
  await executor.run(combo(), 2, { useMacro: true });

  const firstOther = log.findIndex((e) => e !== 'RECORD_START');
  assert.ok(firstOther > 1, 'probes with RECORD_START again');
  assert.deepEqual(log.slice(firstOther, firstOther + 2), ['RECORD_STOP', 'DISCARD']);
  let recording = false;
  for (const entry of log) {
    if (entry === 'RECORD_START') recording = true;
    if (entry === 'RECORD_STOP') recording = false;
    assert.ok(!(recording && entry === 'PLAY_CARD'), `played by hand while recording: ${log.join(' ')}`);
  }
  assert.match(executor.status.message, /^Done: 2 iteration\(s\)/);
});

// Fourth game (forge-w5): the server dropped a RECORD_START and never showed RECORDING within 3s.
const FIXTURE_SLOW_RECORD = path.join(__dirname, '..', 'fixtures', 'endstep-capture-2026-10-31T20-08-51-266Z.json');

test('an unanswered RECORD_START is probed; "already recording" confirms it', { skip: !fs.existsSync(FIXTURE_SLOW_RECORD) }, async () => {
  const replay = makeReplay(FIXTURE_SLOW_RECORD);
  replay.feedUntil((r) => r.dir === 'out-ext' && isPlayerAction(r));
  assert.equal(replay.tracker.macroReported, true);
  const engine = fakeEngine(replay, { isSend: isPlayerAction });
  const log = [];
  const serverFrame = (msg) => replay.tracker.ingest({ kind: 'ws', dir: 'in', enc: 'text', data: JSON.stringify(msg) });
  const sendMacro = async (action) => {
    log.push(action);
    const starts = log.filter((e) => e === 'RECORD_START').length;
    // The first RECORD_START gets no answer at all; the second one finds it recording.
    if (action === 'RECORD_START' && starts === 2) setTimeout(() => serverFrame({ type: 'ERROR', payload: 'You are already recording.' }));
    if (action === 'RECORD_STOP') setTimeout(() => setMacroState(replay.tracker, 'ARMED'));
    return { ok: true };
  };
  const sendAction = async (type, fields) => (log.push(type), engine.sendAction(type, fields));
  const executor = new ELM.ComboExecutor(replay.tracker, sendAction, () => {}, sendMacro);
  executor.macroProbeMs = 20;
  executor.macroStallMs = 50; // the fake server never answers the RUN that follows
  await executor.run(combo(), 2, { useMacro: true });

  const recorded = log.slice(0, log.indexOf('RECORD_STOP') + 1);
  assert.deepEqual(recorded.slice(0, 3), ['RECORD_START', 'RECORD_START', 'PLAY_CARD']);
  assert.equal(recorded.length - 3, 18, 'one full loop played into the recording, then RECORD_STOP');
  assert.equal(log[recorded.length], 'RUN');
});
