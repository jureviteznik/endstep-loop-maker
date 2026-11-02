// Builds the current game view from captured socket records.
//
// Protocol notes (from fixtures/endstep-capture-*.json):
// - Game state arrives on the engine socket (wss://endstep.cc/play/<engine>/ws):
//     GAME_STATE  full snapshot {matchId, seq, payload:{players, stack, pendingAction, ...}}
//     GAME_DELTA  {payload:{baseSeq, patch:{state:{<scalar fields>}, players?:[{i, <scalars>}]}, pendingAction}}
//     GAME_EVENT  log-style events (zone changes, triggers, ...)
//     ATTACHED    {payload:{audience:"<my player id>"}}
//   Zone changes always come as a full GAME_STATE; deltas only patch scalars and the prompt.
// - Actions go out on the site socket (wss://endstep.cc/ws) as
//     {type:"GAME_ACTION", payload:{type, ...fields, promptVersion, matchId, actionId}}
(() => {
  const ELM = (globalThis.ELM = globalThis.ELM || {});

  class GameTracker {
    constructor() {
      this.state = null;
      this.matchId = null;
      this.myPlayerId = null;
      this.sockets = new Map(); // socket id -> url
      this.listeners = new Set();
      // Some servers stop sending `macro` in GAME_STATE (seen after the page's REFRESH re-attach),
      // so a state without it means "unknown", not "no macro".
      this.macroReported = false;
      this.lastError = null; // {message, seq} of the latest server ERROR
      this.errorSeq = 0;
    }

    onChange(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }

    emit() {
      for (const fn of this.listeners) fn(this);
    }

    ingest(record) {
      if (record.kind === 'ws-event') {
        if (record.event === 'create' || record.event === 'open') this.sockets.set(record.socket, record.url);
        if (record.event === 'close') this.sockets.delete(record.socket);
        return;
      }
      if (record.kind !== 'ws' || record.dir !== 'in' || record.enc !== 'text') return;
      // Cheap prefix check so PING/PONG and lobby traffic aren't parsed.
      const head = record.data.slice(0, 40);
      if (!head.includes('"GAME_') && !head.includes('"ATTACHED"') && !head.includes('"ERROR"')) return;

      let msg;
      try {
        msg = JSON.parse(record.data);
      } catch {
        return;
      }
      if (msg.type === 'ERROR') {
        this.lastError = { message: String(msg.payload), seq: ++this.errorSeq };
        this.emit();
      } else if (msg.type === 'ATTACHED') {
        this.myPlayerId = msg.payload.audience;
        this.matchId = msg.payload.matchId;
        this.emit();
      } else if (msg.type === 'GAME_STATE') {
        this.matchId = msg.matchId;
        this.state = msg.payload;
        this.macroReported = 'macro' in msg.payload;
        this.promptViaDelta = false;
        this.emit();
      } else if (msg.type === 'GAME_DELTA') {
        if (!this.state) return;
        const { patch, pendingAction } = msg.payload;
        if (patch && patch.state) Object.assign(this.state, patch.state);
        // Per-player scalars by index, e.g. {i: 0, manaPool: {colorless: 1}}.
        for (const { i, ...fields } of (patch && patch.players) || []) {
          const player = (this.state.players || [])[i];
          if (player) Object.assign(player, fields);
        }
        const other = patch && Object.keys(patch).filter((k) => k !== 'state' && k !== 'players');
        if (other && other.length) console.warn('[endstep-loop-maker] unhandled delta keys', other);
        if ('pendingAction' in msg.payload) {
          this.state.pendingAction = pendingAction;
          // Zones only change in full states; one may still be on its way.
          this.promptViaDelta = true;
        }
        this.emit();
      }
    }

    get prompt() {
      return this.state ? this.state.pendingAction : null;
    }

    me() {
      if (!this.state) return null;
      const players = this.state.players || [];
      if (this.myPlayerId != null) {
        const p = players.find((pl) => pl.id === this.myPlayerId);
        if (p) return p;
      }
      // Fallback when we attached late: our prompts list our own cards.
      const opts = (this.prompt && this.prompt.cardOptions) || [];
      const ownerName = opts.length ? opts[0].ownerName : null;
      return players.find((pl) => pl.name === ownerName) || null;
    }

    // Socket the site sends GAME_ACTIONs on.
    actionSocketId() {
      for (const [id, url] of this.sockets) {
        if (/^wss:\/\/([^/]+\.)?endstep\.cc\/ws(\?|$)/.test(url)) return id;
      }
      return null;
    }
  }

  ELM.GameTracker = GameTracker;
})();
