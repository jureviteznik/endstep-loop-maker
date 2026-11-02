// Runs a combo's loop by answering the engine's live prompts, and hands repetition to
// endstep's server-side macro whenever it can (one RUN message instead of ~9 actions per loop).
//
// Manual play resolves every choice against the *current* prompt's options by card name/zone,
// so cards that swap ids between iterations (the reason endstep's own macros stall) are fine.
//
// Macro mode:
//   1. RECORD_START, play the loop manually until the combo pieces are back on the same card ids
//      (a "cycle"; 2 iterations for a pair of Myr Retrievers), RECORD_STOP.
//   2. RUN the armed macro for whole cycles. The server tends to stop after one cycle ("could not
//      tell which card the recorded answer meant"), so RUN again from the same position while it
//      progresses, asking only for as many cycles as a run has managed so later runs end cleanly.
//   3. Play leftovers manually.
// The macro is only a shortcut: if it stalls or makes no progress, it's stopped and discarded,
// the board is brought back to the start (combo.recover), and the next loop records it afresh.
// After MAX_MACRO_FAILURES failures in a row the rest of the run is played by hand.
// Loops are also played by hand while the server isn't reporting macro state (tracker.macroReported):
// without it a recording can't be confirmed or a run counted.
(() => {
  const ELM = (globalThis.ELM = globalThis.ELM || {});

  const PROMPT_TIMEOUT_MS = 15000;
  // A macro run may send nothing until it ends: healthy runs took up to 3.5s (the server caps one
  // RUN at about 3 loops); one that hung on a choice sent nothing at all.
  const MACRO_STALL_MS = 10000;
  // RECORDING shows up anywhere from 40ms to 6s after RECORD_START, and the server sometimes drops
  // a RECORD_START altogether. Its ERROR replies come back within ~50ms, so if RECORDING hasn't
  // shown up after MACRO_PROBE_MS, RECORD_START is sent again: "You are already recording." confirms
  // it, silence means this one started it (the next probe confirms that).
  const MACRO_PROBE_MS = 1000;
  // After a prompt that came in a delta, a GAME_STATE with the zone changes may follow (median
  // 51ms). Prompts in a full GAME_STATE (about 85% of them) need no wait.
  const SETTLE_MS = 60;
  const MAX_RESOLVE_ACTIONS = 60;
  const MAX_ITERATIONS = 1000;
  const MAX_CYCLE = 4; // give up recording if the pieces don't return to their ids by then
  const MAX_MACRO_FAILURES = 2; // a macro that hangs once tends to hang again on the same board
  const MAX_MANUAL_FAILURES = 2;
  const USER_TIMEOUT_MS = 5 * 60 * 1000; // waiting for you to pick a target in the game

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Ends the run; everything else is recovered from.
  class StopError extends Error {}
  class GameOverError extends StopError {}

  class ComboExecutor {
    // sendAction(type, fields) / sendMacro(action, count?) -> Promise<{ok, error?}>
    constructor(tracker, sendAction, onUpdate, sendMacro) {
      this.tracker = tracker;
      this.sendAction = sendAction;
      this.sendMacro = sendMacro;
      this.onUpdate = onUpdate;
      this.waiters = new Set();
      this.armed = null; // {comboId, signature, cycle} for a macro we recorded
      this.recent = []; // card ids this executor chose, most recent first
      this.combo = null; // the combo being run
      this.options = { pickTargets: false };
      this.macroStallMs = MACRO_STALL_MS;
      this.macroProbeMs = MACRO_PROBE_MS;
      this.recording = false; // we sent RECORD_START and haven't stopped or discarded it
      this.status = { running: false, comboId: null, iteration: 0, iterations: 0, step: null, message: '' };
      tracker.onChange(() => {
        for (const w of [...this.waiters]) w.check();
      });
    }

    update(fields) {
      Object.assign(this.status, fields);
      this.onUpdate(this.status);
    }

    stop() {
      if (!this.status.running) return;
      this.stopRequested = true;
      if (this.sendMacro && this.macro() && this.macro().state === 'RUNNING') this.sendMacro('STOP');
      for (const w of [...this.waiters]) w.reject(new StopError('Stopped by you.'));
    }

    macro() {
      return this.tracker.state ? this.tracker.state.macro : null;
    }

    // Resolves with the first non-undefined value of probe(), re-checked on every state change.
    // idleTimeout: the timer restarts whenever the state changes instead of running once.
    waitFor(probe, what, { timeout = PROMPT_TIMEOUT_MS, idleTimeout = false } = {}) {
      return new Promise((resolve, reject) => {
        let timer = null;
        const arm = () => {
          clearTimeout(timer);
          timer = setTimeout(() => w.reject(new Error(`Timed out waiting for ${what}.`)), timeout);
        };
        const cleanup = () => {
          clearTimeout(timer);
          this.waiters.delete(w);
        };
        const w = {
          check: () => {
            const value = probe();
            if (value !== undefined) {
              cleanup();
              resolve(value);
            } else if (this.tracker.state && this.tracker.state.status !== 'ACTIVE') {
              cleanup();
              reject(new GameOverError(`Game is no longer active (${this.tracker.state.status}).`));
            } else if (idleTimeout) {
              arm();
            }
          },
          reject: (err) => {
            cleanup();
            reject(err);
          },
        };
        arm();
        this.waiters.add(w);
        w.check();
      });
    }

    waitForPrompt(predicate, what) {
      return this.waitFor(() => {
        const p = this.tracker.prompt;
        return p && predicate(p) ? p : undefined;
      }, what);
    }

    waitForMacro(predicate, what, opts) {
      return this.waitFor(() => {
        const m = this.macro();
        return m && predicate(m) ? m : undefined;
      }, what, opts);
    }

    checkStop() {
      if (this.stopRequested) throw new StopError('Stopped by you.');
    }

    async act(type, fields) {
      this.checkStop();
      const pv = this.tracker.prompt.promptVersion;
      const res = await this.sendAction(type, { ...fields, promptVersion: pv });
      if (!res || !res.ok) throw new Error(`Could not send ${type}: ${(res && res.error) || 'unknown error'}`);
      await this.waitForPrompt((p) => p.promptVersion > pv, `the engine to answer ${type}`);
      if (this.tracker.promptViaDelta) await sleep(SETTLE_MS);
    }

    async macroCommand(action, count) {
      this.checkStop();
      const res = await this.sendMacro(action, count);
      if (!res || !res.ok) throw new Error(`Could not send macro ${action}: ${(res && res.error) || 'unknown error'}`);
    }

    // Card ids bound to the combo pieces, or null if the pieces aren't all there.
    signature(combo) {
      const pieces = ELM.checkPieces(combo, this.tracker.me());
      return pieces.assembled ? pieces.bound.map((c) => c.id).join(',') : null;
    }

    // pickTargets: wait for you to answer prompts whose answer has `userPick` (e.g. what to destroy).
    async run(combo, iterations, { useMacro = false, pickTargets = false } = {}) {
      if (this.status.running) throw new Error('A combo is already running.');
      const total = Math.max(1, Math.min(MAX_ITERATIONS, Math.floor(iterations) || 1));
      this.stopRequested = false;
      this.combo = combo;
      this.options = { pickTargets };
      this.update({ running: true, comboId: combo.id, iteration: 0, iterations: total, step: null, message: 'Starting…' });
      const macroOk = useMacro && Boolean(this.sendMacro) && combo.macro !== false;
      let macroFailures = 0; // in a row
      let manualFailures = 0; // in a row
      let byMacro = 0;
      let recoveries = 0;
      let unreported = 0; // loops played by hand because the server wasn't reporting macro state
      const split = () => {
        const parts = [];
        if (byMacro) parts.push(`${byMacro} by macro, ${this.status.iteration - byMacro} by hand`);
        if (unreported) parts.push(`endstep wasn't reporting macro state, so ${unreported} played by hand`);
        if (recoveries) parts.push(`recovered ${recoveries}×`);
        return parts.length ? ` (${parts.join('; ')})` : '';
      };
      try {
        while (this.status.iteration < total) {
          this.checkStop();
          const sig = this.requireSignature(combo);
          await this.waitForPrompt((p) => p.type === 'PRIORITY', 'priority');
          const left = total - this.status.iteration;
          const macroOn = macroOk && macroFailures < MAX_MACRO_FAILURES && this.tracker.macroReported;
          if (macroOk && macroFailures < MAX_MACRO_FAILURES && !macroOn) unreported++;
          const armed = macroOn ? this.armedFor(combo) : null;
          let viaMacro = false;
          try {
            if (armed && sig === armed.signature && left >= armed.cycle) {
              viaMacro = true;
              const count = Math.min(Math.floor(left / armed.cycle), armed.perRun);
              const cycles = await this.runMacro(count);
              byMacro += cycles * armed.cycle;
              this.update({ iteration: this.status.iteration + cycles * armed.cycle });
              if (cycles === 0) throw new Error(`The macro made no progress${lastStop(this.macro())}.`);
              if (cycles < count) armed.perRun = cycles;
              macroFailures = 0;
              // A run ends right after its last action, maybe with that spell still on the stack.
              await this.recover(combo);
            } else if (macroOn && left >= 2 && !(armed && sig === armed.signature)) {
              // No macro yet, or it was recorded on other cards: (re-)record it.
              viaMacro = true;
              await this.recordMacro(combo, sig, left);
            } else {
              await this.runIteration(combo);
              manualFailures = 0;
            }
          } catch (err) {
            if (err instanceof StopError) throw err;
            if (viaMacro) {
              macroFailures++;
              await this.dropMacro();
            } else if (++manualFailures >= MAX_MANUAL_FAILURES) {
              throw err;
            }
            const next = viaMacro && macroFailures < MAX_MACRO_FAILURES ? 're-recording the macro' : 'continuing by hand';
            this.update({ message: `${err.message} Recovering, then ${next}…` });
            await this.recover(combo);
            recoveries++;
          }
        }
        this.update({ message: `Done: ${this.status.iteration} iteration(s)${split()}.` });
      } catch (err) {
        if (this.sendMacro && (this.recording || (this.macro() && this.macro().state === 'RECORDING'))) {
          this.recording = false;
          this.sendMacro('RECORD_STOP').then(() => this.sendMacro('DISCARD'));
        }
        this.update({ message: `Stopped after ${this.status.iteration} iteration(s)${split()}: ${err.message}` });
      } finally {
        this.update({ running: false, step: null });
      }
    }

    requireSignature(combo) {
      const sig = this.signature(combo);
      if (sig) return sig;
      const missing = ELM.checkPieces(combo, this.tracker.me()).missing.map((p) => `${p.name} (${p.zone})`);
      throw new Error(`missing ${missing.join(', ')}`);
    }

    // Stops and discards whatever macro is on the server; best effort.
    async dropMacro() {
      this.armed = null;
      if (!this.sendMacro) return;
      const m = this.macro();
      if (this.recording || (m && m.state === 'RECORDING')) {
        // Never play on by hand while the server may still be recording: it would all end up in
        // the macro. The server may not report RECORDING at all, so stop it regardless.
        this.recording = false;
        await this.sendMacro('RECORD_STOP');
        await this.sendMacro('DISCARD');
        if (this.tracker.macroReported) {
          await this.waitForMacro((x) => x.state === 'IDLE', 'the macro to be discarded', { timeout: this.macroStallMs }).catch(() => {});
        }
        return;
      }
      if (!m) return;
      if (m.state === 'RUNNING') {
        await this.sendMacro('STOP');
        await this.waitForMacro((x) => x.state !== 'RUNNING', 'the macro to stop', { timeout: this.macroStallMs }).catch(() => {});
      }
      if (this.macro().state !== 'IDLE') {
        await this.sendMacro('DISCARD');
        await this.waitForMacro((x) => x.state === 'IDLE', 'the macro to be discarded', { timeout: this.macroStallMs }).catch(() => {});
      }
    }

    // Gets back to priority with an empty stack and the pieces assembled, finishing a loop that
    // broke off halfway. Throws when the board can't be put back.
    async recover(combo) {
      const answers = recoveryAnswers(combo);
      for (let n = 0; n < MAX_RESOLVE_ACTIONS; n++) {
        await this.waitForPrompt(() => true, 'a prompt');
        await sleep(SETTLE_MS);
        const prompt = await this.waitForPrompt(() => true, 'a prompt');
        if (prompt.type !== 'PRIORITY') {
          const answer = answers.find((a) => promptMatches(a, prompt));
          if (!answer) throw new Error(`Can't recover from ${describe(prompt)}.`);
          await this.answer(answer, prompt);
        } else if ((this.tracker.state.stack || []).length) {
          await this.act('PASS_PRIORITY', {});
        } else if (this.signature(combo)) {
          return;
        } else {
          const holds = (w) => (w.count || w.counters ? this.conditionMet(w) : hasOption(prompt, w, this.tracker.me()));
          const fix = (combo.recover || []).find((r) => holds(r.when));
          if (!fix) this.requireSignature(combo); // throws "missing ..."
          for (const step of fix.steps) await this.runStep(step);
        }
      }
      throw new Error('Could not get the board back to the start.');
    }

    armedFor(combo) {
      const m = this.macro();
      if (!this.armed || this.armed.comboId !== combo.id || !m || m.state !== 'ARMED') {
        this.armed = null;
        return null;
      }
      return this.armed;
    }

    async recordMacro(combo, startSig, left) {
      const m = this.macro();
      if (m && m.state !== 'IDLE') {
        await this.macroCommand('DISCARD');
        await this.waitForMacro((x) => x.state === 'IDLE', 'the old macro to be discarded');
      }
      await this.startRecording();
      let cycle = 0;
      while (cycle < Math.min(MAX_CYCLE, left)) {
        this.update({ message: `Recording macro: iteration ${cycle + 1}` });
        await this.runIteration(combo);
        cycle++;
        if (this.signature(combo) === startSig) break;
      }
      if (this.signature(combo) !== startSig) {
        // The pieces never came back to the same cards; a replay couldn't line up.
        throw new Error('The recorded loop did not return the pieces to the same cards.');
      }
      await this.macroCommand('RECORD_STOP');
      await this.waitForMacro((x) => x.state === 'ARMED', 'the macro to arm', { timeout: this.macroStallMs });
      this.recording = false;
      // perRun: most cycles one RUN has completed so far (the server often stops after one).
      this.armed = { comboId: combo.id, signature: startSig, cycle, perRun: Infinity };
    }

    // Sends RECORD_START until the server confirms it is recording (see MACRO_PROBE_MS).
    async startRecording() {
      this.update({ message: 'Starting the macro recording…' });
      const deadline = Date.now() + this.macroStallMs;
      while (Date.now() < deadline) {
        const errSeq = this.tracker.errorSeq;
        await this.macroCommand('RECORD_START');
        this.recording = true;
        const started = await this.waitFor(
          () => {
            const m = this.macro();
            if (m && m.state === 'RECORDING') return { ok: true };
            const e = this.tracker.lastError;
            if (e && e.seq > errSeq) return { ok: /already recording/i.test(e.message), error: e.message };
            return undefined;
          },
          'macro recording to start',
          { timeout: Math.min(this.macroProbeMs, Math.max(1, deadline - Date.now())) }
        ).catch((err) => {
          if (err instanceof StopError) throw err;
          return null; // no answer yet: probe again
        });
        if (started && started.ok) return;
        if (started) throw new Error(`endstep refused to record the macro: ${started.error}`);
      }
      throw new Error('endstep never confirmed the macro recording.');
    }

    // Returns how many cycles the server completed. Throws if the macro doesn't finish within
    // MACRO_STALL_MS of the last state change; the caller stops and discards it.
    // The server may report RUNNING and then the result, or run silently and send only the
    // result (ARMED, iterationsRequested = count, prompt version moved on).
    async runMacro(count) {
      this.update({ message: `Macro running ${count} cycle(s)…` });
      const pv = this.tracker.prompt ? this.tracker.prompt.promptVersion : -1;
      await this.macroCommand('RUN', count);
      let sawRunning = false;
      const end = await this.waitForMacro(
        (x) => {
          if (x.state === 'RUNNING') sawRunning = true;
          if (x.state === 'RUNNING') return undefined;
          const p = this.tracker.prompt;
          const silentResult = x.iterationsRequested === count && p && p.promptVersion > pv;
          return sawRunning || silentResult ? x : undefined;
        },
        'the macro',
        { timeout: this.macroStallMs, idleTimeout: true }
      ).catch((err) => {
        if (err instanceof StopError) throw err;
        throw new Error(`The macro ${sawRunning ? 'stalled' : 'did not report back'}${lastStop(this.macro())}.`);
      });
      return end.iterationsDone || 0;
    }

    async runIteration(combo) {
      for (let i = 0; i < combo.loop.length; i++) {
        this.update({ step: i, message: `Iteration ${this.status.iteration + 1}/${this.status.iterations}, step ${i + 1}/${combo.loop.length}` });
        await this.runStep(combo.loop[i]);
      }
      this.update({ iteration: this.status.iteration + 1, step: null });
    }

    async runStep(step) {
      if (step.do === 'RESOLVE') return this.resolveStack(step.answers || []);
      if (step.do === 'REPEAT') return this.repeat(step);
      const prompt = await this.waitForPrompt(() => true, step.prompt || 'a prompt');
      if (!promptMatches(step, prompt)) {
        if (step.optional) return;
        throw new Error(`Expected ${step.prompt}${step.match ? ` (${step.match})` : ''} but got ${describe(prompt)}.`);
      }
      if (step.do === 'PAY') return this.pay();
      await this.answer(step, prompt);
    }

    // Sends the answer `step` gives to `prompt`. PAY answers make one payment action.
    async answer(step, prompt) {
      if (step.do === 'PAY') return this.payOnce(prompt);
      if (step.userPick && this.options.pickTargets) return this.waitForUser(prompt);
      await this.act(step.do, this.fields(step, prompt));
    }

    fields(step, prompt) {
      const fields = buildFields(step, prompt, this.recent, this.tracker.me());
      const ids = [fields.cardId, ...(fields.targets || []), ...(fields.orderedCards || [])].filter((id) => id != null);
      if (ids.length) this.recent = [...ids, ...this.recent.filter((id) => !ids.includes(id))].slice(0, 20);
      return fields;
    }

    async waitForUser(prompt) {
      const before = this.status.message;
      this.update({ message: `Your turn: ${(prompt.message || 'answer the prompt').split('\n')[0]} (in the game).` });
      await this.waitFor(() => {
        const p = this.tracker.prompt;
        return p && p.promptVersion > prompt.promptVersion ? p : undefined;
      }, 'you to answer', { timeout: USER_TIMEOUT_MS });
      await sleep(SETTLE_MS);
      this.update({ message: before });
    }

    // Runs `steps` until `until` holds (checked first, so it may run zero times).
    async repeat(step) {
      for (let n = 0; !this.conditionMet(step.until); n++) {
        if (n >= (step.max || 50)) throw new Error(`Gave up after ${n} rounds waiting for ${describeCondition(step.until)}.`);
        if (step.label) this.update({ message: `${step.label} (${describeCondition(step.until)})` });
        for (const s of step.steps) await this.runStep(s);
      }
    }

    conditionMet(cond) {
      const me = this.tracker.me() || {};
      if (cond.count) {
        const { name, zone, atLeast } = cond.count;
        return (me[zone] || []).filter((c) => ELM.sameName(c.name, name)).length >= atLeast;
      }
      if (cond.counters) {
        const { name, kind, atLeast } = cond.counters;
        const card = (me.battlefield || []).find((c) => ELM.sameName(c.name, name));
        return Boolean(card) && ((card.counters || {})[kind] || 0) >= atLeast;
      }
      throw new Error(`Unknown condition ${JSON.stringify(cond)}.`);
    }

    // Pays the PAY_MANA prompt(s) in front of us, including nested ones for mana abilities.
    async pay() {
      for (let n = 0; n < MAX_RESOLVE_ACTIONS; n++) {
        const prompt = await this.waitForPrompt(() => true, 'a mana payment');
        if (prompt.type !== 'PAY_MANA') return;
        await this.payOnce(prompt);
      }
      throw new Error('The payment did not finish.');
    }

    // One payment action, using combo.mana = {altar, fodder, anyColor}:
    //   - floating mana covers the rest: AUTO_PAY (it spends the pool first);
    //   - a colored symbol isn't floating: activate `anyColor` (its own {2} comes next, nested);
    //   - otherwise sacrifice a `fodder` creature to `altar`.
    // Never AUTO_PAY otherwise: it could sacrifice a combo piece or tap one we need untapped.
    async payOnce(prompt) {
      const mana = (this.combo && this.combo.mana) || null;
      const cost = parseCost(prompt.remainingCost || '');
      const floating = prompt.floatingMana || {};
      if (!mana || covers(floating, cost)) return this.act('AUTO_PAY', {});
      const colorShort = cost.colors.some((c) => !(floating[COLOR_NAMES[c]] > 0));
      if (colorShort && mana.anyColor && hasOption(prompt, { name: mana.anyColor })) {
        return this.act('TAP_MANA', { cardId: pickCard(prompt, { name: mana.anyColor }).id });
      }
      if (!hasOption(prompt, { name: mana.altar })) {
        throw new Error(`Can't pay ${prompt.remainingCost}: ${mana.altar} is not among the mana sources.`);
      }
      await this.act('TAP_MANA', { cardId: pickCard(prompt, { name: mana.altar }).id });
      const next = this.tracker.prompt;
      if (next && next.type === 'CHOOSE_CARDS' && /sacrifice/i.test(next.message || '')) {
        if (!hasOption(next, { name: mana.fodder })) {
          await this.act('CANCEL', {});
          throw new Error(`Out of ${mana.fodder} tokens to sacrifice for mana.`);
        }
        await this.act('CHOOSE_CARDS', { orderedCards: [pickCard(next, { name: mana.fodder }).id] });
      }
    }

    async resolveStack(answers) {
      for (let n = 0; n < MAX_RESOLVE_ACTIONS; n++) {
        const prompt = await this.waitForPrompt(() => true, 'the stack to resolve');
        if (prompt.type === 'PRIORITY') {
          if ((this.tracker.state.stack || []).length === 0) return;
          await this.act('PASS_PRIORITY', {});
          continue;
        }
        const answer = answers.find((a) => promptMatches(a, prompt));
        if (!answer) throw new Error(`No answer for ${describe(prompt)}.`);
        await this.answer(answer, prompt);
      }
      throw new Error('The stack did not empty out.');
    }
  }

  const COLOR_NAMES = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green', C: 'colorless' };

  // "{3}{B}" -> {generic: 3, colors: ['B']}. Hybrid/X symbols aren't needed by any combo yet.
  function parseCost(text) {
    const cost = { generic: 0, colors: [] };
    for (const [, sym] of text.matchAll(/\{([^}]+)\}/g)) {
      if (/^\d+$/.test(sym)) cost.generic += Number(sym);
      else if (COLOR_NAMES[sym]) cost.colors.push(sym);
    }
    return cost;
  }

  function covers(floating, cost) {
    const pool = { ...floating };
    for (const c of cost.colors) {
      const key = COLOR_NAMES[c];
      if (!(pool[key] > 0)) return false;
      pool[key]--;
    }
    const left = Object.values(pool).reduce((a, b) => a + (Number(b) || 0), 0);
    return left >= cost.generic;
  }

  function describeCondition(cond) {
    if (cond.count) return `${cond.count.atLeast}× ${cond.count.name} on the ${cond.count.zone}`;
    if (cond.counters) return `${cond.counters.atLeast} ${cond.counters.kind} counters on ${cond.counters.name}`;
    return JSON.stringify(cond);
  }

  function promptMatches(step, prompt) {
    if (step.prompt && step.prompt !== prompt.type) return false;
    if (step.match && !new RegExp(step.match, 'i').test(prompt.message || '')) return false;
    if (step.source && !ELM.sameName(prompt.sourceCardName || '', step.source)) return false;
    return true;
  }

  function describe(prompt) {
    return `${prompt.type} "${(prompt.message || '').split('\n')[0]}"`;
  }

  function lastStop(macro) {
    return macro && macro.lastStop ? ` (${macro.lastStop})` : '';
  }

  // Every choice the loop knows how to make, for prompts met mid-loop.
  function recoveryAnswers(combo) {
    const flat = (steps) => steps.flatMap((s) => (s.do === 'REPEAT' ? flat(s.steps) : [s]));
    const steps = flat([...combo.loop, ...(combo.recover || []).flatMap((r) => r.steps)]);
    return steps.flatMap((s) => (s.do === 'RESOLVE' ? s.answers || [] : s.prompt && s.prompt !== 'PRIORITY' ? [s] : []));
  }

  // sel: {name?, zone?, owner?: 'opponent'}. Without a name, any card matches.
  function selects(c, sel, me) {
    if (sel.name && !ELM.sameName(c.name, sel.name)) return false;
    if (sel.zone && (c.zone || '').toLowerCase() !== sel.zone.toLowerCase()) return false;
    if (sel.owner === 'opponent' && (!me || c.ownerName === me.name)) return false;
    return true;
  }

  function hasOption(prompt, sel, me) {
    return (prompt.cardOptions || []).some((c) => selects(c, sel, me));
  }

  // Opponent's permanents to destroy first: creatures, then other nonland cards, then lands;
  // real cards before tokens; costlier first.
  function threat(c) {
    const types = c.types || [];
    const kind = types.includes('Creature') ? 0 : types.includes('Land') ? 2 : 1;
    const token = /\btoken$/i.test(c.name || '') ? 1 : 0;
    return kind * 1000 + token * 100 - (c.cmc || 0);
  }

  // Among matching options, prefer the card chosen most recently (`recent`, newest first);
  // for opponent selectors, the biggest threat.
  function pickCard(prompt, sel, recent = [], me = null, exclude = []) {
    const opts = prompt.cardOptions || [];
    const matches = opts.filter((c) => !exclude.includes(c.id) && selects(c, sel, me));
    const rank = sel.owner === 'opponent' ? threat : (c) => (recent.includes(c.id) ? recent.indexOf(c.id) : Infinity);
    const card = matches.sort((a, b) => rank(a) - rank(b))[0];
    if (!card) {
      const wanted = sel.owner === 'opponent' ? `An opponent's permanent` : `${sel.name}${sel.zone ? ` (${sel.zone})` : ''}`;
      const listed = opts.map((c) => `${c.name} (${c.zone})`).join(', ') || 'none';
      throw new Error(`${wanted} is not among the options: ${listed}.`);
    }
    return card;
  }

  // One distinct card per selector, at most prompt.max of them.
  function pickCards(prompt, sels, recent, me) {
    const ids = [];
    for (const sel of sels.slice(0, prompt.max || sels.length)) {
      if (!hasOption({ cardOptions: (prompt.cardOptions || []).filter((c) => !ids.includes(c.id)) }, sel, me)) continue;
      ids.push(pickCard(prompt, sel, recent, me, ids).id);
    }
    if (!ids.length) pickCard(prompt, sels[0], recent, me); // throws with the option list
    return ids;
  }

  function buildFields(step, prompt, recent, me) {
    switch (step.do) {
      case 'PLAY_CARD': {
        // `ability` picks one of the card's playableAbilities up front, like the site's own UI
        // does; otherwise a CHOOSE_ABILITY prompt follows.
        const card = pickCard(prompt, step.card, recent, me);
        const ability = step.ability && (card.playableAbilities || []).find((a) => new RegExp(step.ability, 'i').test(a.description));
        return ability ? { cardId: card.id, abilityIndex: ability.index, autoPassAfter: false } : { cardId: card.id, autoPassAfter: false };
      }
      case 'TAP_MANA':
        return { cardId: pickCard(prompt, step.card, recent, me).id };
      case 'CHOOSE_CARDS':
        return { orderedCards: step.cards ? pickCards(prompt, step.cards, recent, me) : [pickCard(prompt, step.card, recent, me).id] };
      case 'CHOOSE_TARGETS':
        return { targets: step.cards ? pickCards(prompt, step.cards, recent, me) : [pickCard(prompt, step.card, recent, me).id] };
      case 'ARRANGE_CARDS':
        // Scry/surveil: keep every card on top, in the order shown.
        return { orderedCards: (prompt.cardOptions || []).map((c) => c.id) };
      case 'CHOOSE_ABILITY': {
        const mode = (prompt.modeOptions || []).find((m) => new RegExp(step.ability, 'i').test(m.description));
        if (!mode) throw new Error(`No ability matching /${step.ability}/ in ${describe(prompt)}.`);
        return { numberValue: mode.index };
      }
      default:
        return {};
    }
  }

  ELM.ComboExecutor = ComboExecutor;
})();
