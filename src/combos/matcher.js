// Checks whether a combo's pieces are in place for the local player.
(() => {
  const ELM = (globalThis.ELM = globalThis.ELM || {});

  const ZONES = ['hand', 'battlefield', 'graveyard', 'exile'];

  // Tokens are named "<name> Token" in prompts and state ("Golem Token"); "Golem" matches them.
  function sameName(a, b) {
    const norm = (s) => s.trim().toLowerCase().replace(/ token$/, '');
    return norm(a) === norm(b);
  }

  // Returns {assembled, missing:[piece], bound:[card]}; each piece takes a distinct card.
  function checkPieces(combo, me) {
    if (!me) return { assembled: false, missing: combo.pieces.slice(), bound: [] };
    const used = new Set();
    const missing = [];
    const bound = [];
    for (const piece of combo.pieces) {
      const zone = piece.zone.toLowerCase();
      const cards = ZONES.includes(zone) ? me[zone] || [] : [];
      const card = cards.find((c) => !used.has(c.id) && sameName(c.name, piece.name) && !c.isPhasedOut);
      if (card) {
        used.add(card.id);
        bound.push(card);
      } else {
        missing.push(piece);
      }
    }
    return { assembled: missing.length === 0, missing, bound };
  }

  // Assembled and the engine is waiting on us with a priority prompt.
  function comboStatus(combo, tracker) {
    const me = tracker.me();
    const pieces = checkPieces(combo, me);
    const prompt = tracker.prompt;
    const canAct = Boolean(prompt && prompt.type === 'PRIORITY' && tracker.state && tracker.state.status === 'ACTIVE');
    return {
      id: combo.id,
      name: combo.name,
      description: combo.description,
      unit: combo.unit || 'iterations',
      macro: combo.macro !== false,
      choosesTargets: Boolean(combo.choosesTargets),
      assembled: pieces.assembled,
      missing: pieces.missing.map((p) => `${p.name} (${p.zone})`),
      ready: pieces.assembled && canAct,
    };
  }

  ELM.checkPieces = checkPieces;
  ELM.comboStatus = comboStatus;
  ELM.sameName = sameName;
})();
