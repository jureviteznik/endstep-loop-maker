// Hardcoded combos. Each one is plain data in the same shape user-recorded combos will use.
//
// pieces: cards that must be in a zone of mine before the loop starts (each matches a distinct card).
//   zone is one of hand | battlefield | graveyard | exile.
// loop: steps run in order for every iteration. Each step answers the current prompt:
//   { prompt, do, card?, ability?, match? }
//     prompt   pendingAction.type the step expects (PRIORITY, CHOOSE_CARDS, CHOOSE_TARGETS, PAY_MANA, ...)
//     match    optional regex source tested against the prompt message
//     do       GAME_ACTION type to send (PLAY_CARD, CHOOSE_CARDS, CHOOSE_TARGETS, AUTO_PAY, YES, NO, ...)
//     card     {name, zone} picked from the prompt's cardOptions *by name*, never by a recorded id
//     ability  regex source picked from the prompt's modeOptions (CHOOSE_ABILITY)
//     optional skip the step if the current prompt doesn't match it. Use it for choices the
//              engine makes by itself when there's only one candidate (e.g. a single creature to sacrifice).
//   When several options match a card selector, the card the loop chose most recently wins
//   (so the Retriever just returned to hand is the one recast, not a spare copy).
//   { do: 'RESOLVE', answers: [ {prompt, match?, do, card?} ] }
//     pass priority until the stack is empty, answering prompts that pop up with `answers`.
//   { do: 'REPEAT', until, steps, max?, label? }
//     run `steps` until `until` holds: {count: {name, zone, atLeast}} (cards of mine in a zone) or
//     {counters: {name, kind, atLeast}} (counters on my permanent, e.g. kind 'Charge').
//   { prompt: 'PAY_MANA', do: 'PAY' }
//     pay the cost with combo.mana: sacrifice `fodder` to `altar` for generic mana, activate
//     `anyColor` for colored symbols. Without combo.mana it's AUTO_PAY.
//   Selectors: card {name?, zone?, owner?: 'opponent'}; `cards: [...]` picks one distinct card each
//   (multi-target). Opponent selectors pick creatures first, then other nonlands, then lands.
//   userPick: with "pick targets myself" on, wait for you to answer that prompt in the game.
//   source: match the prompt's sourceCardName.
// unit: what an iteration is, for the panel. macro: false keeps endstep macros out of it.
// recover: ways back to the starting board when a run broke off mid-loop (e.g. a stalled macro).
//   [{ when, steps: [...] }]: while the pieces aren't assembled, run the first rule whose `when`
//   holds. `when` is {name, zone} (among the priority prompt's options) or a REPEAT condition.
//   Prompts met while recovering are answered with the loop's own choice steps and RESOLVE answers.
(() => {
  const ELM = (globalThis.ELM = globalThis.ELM || {});

  // Sacrifice one Retriever to the Altar ({C}{C}), return the other, recast it.
  const retrieverHalf = [
    { prompt: 'PRIORITY', do: 'PLAY_CARD', card: { name: "Ashnod's Altar", zone: 'Battlefield' } },
    { prompt: 'CHOOSE_CARDS', match: 'Sacrifice', do: 'CHOOSE_CARDS', card: { name: 'Myr Retriever', zone: 'Battlefield' }, optional: true },
    { prompt: 'CHOOSE_TARGETS', do: 'CHOOSE_TARGETS', card: { name: 'Myr Retriever', zone: 'Graveyard' }, optional: true },
    { do: 'RESOLVE', answers: [] },
    { prompt: 'PRIORITY', do: 'PLAY_CARD', card: { name: 'Myr Retriever', zone: 'Hand' } },
    { prompt: 'PAY_MANA', do: 'AUTO_PAY', optional: true },
    { do: 'RESOLVE', answers: [{ prompt: 'YES_NO', match: 'Golem Foundry', do: 'YES' }] },
  ];

  ELM.builtinCombos = [
    {
      id: 'altar-retriever-pair',
      name: "Ashnod's Altar + 2× Myr Retriever",
      description:
        'Each loop recasts both Retrievers (2 artifact casts: storm, Golem Foundry counters, ...) ' +
        'and leaves the board as it started.',
      pieces: [
        { name: "Ashnod's Altar", zone: 'battlefield' },
        { name: 'Myr Retriever', zone: 'battlefield' },
        { name: 'Myr Retriever', zone: 'graveyard' },
      ],
      // A loop is a full cycle back to the starting board, like an endstep macro iteration.
      loop: [...retrieverHalf, ...retrieverHalf],
      // Stopped after a Retriever was returned to hand: recast it.
      recover: [{ when: { name: 'Myr Retriever', zone: 'Hand' }, steps: retrieverHalf.slice(4) }],
    },
    boulderLoop(),
  ];

  // Giant's Boulder destroys a permanent each loop; the Retrievers, Blood Fountain and Golem
  // Foundry put everything back:
  //   1. Myr loop until Golem Foundry has 3 counters, make a Golem; repeat until there are enough
  //      Golems to pay for the whole loop (each Golem sacrificed to the Altar is {C}{C};
  //      Energy Refractor turns {2} into {B}).
  //   2. Boulder: {7}, {T}, sacrifice: destroy the target.
  //   3. Sacrifice the Retriever on the battlefield: return Boulder to hand. Both Retrievers are
  //      now in the graveyard.
  //   4. Blood Fountain: {3}{B}, {T}, sacrifice: return both Retrievers to hand.
  //   5. Cast both Retrievers, sacrifice one: return Blood Fountain to hand.
  //   6. Recast Blood Fountain, then Boulder (scry 2: everything stays on top).
  // Mana per loop: 7 + 5 + 2 + 2 + 2 + 1 = 19, minus {C}{C} from each Retriever sacrifice = 15,
  // so 8 Golems; one spare for rounding.
  function boulderLoop() {
    const altar = { name: "Ashnod's Altar", zone: 'Battlefield' };
    const foundryYes = { prompt: 'YES_NO', match: 'Golem Foundry', do: 'YES' };
    const pay = { prompt: 'PAY_MANA', do: 'PAY', optional: true };
    const cast = (name, extra = []) => [
      { prompt: 'PRIORITY', do: 'PLAY_CARD', card: { name, zone: 'Hand' } },
      pay,
      { do: 'RESOLVE', answers: [foundryYes, ...extra] },
    ];
    // Sacrifice the Retriever on the battlefield, returning `target` from the graveyard.
    const sacRetriever = (target) => [
      { prompt: 'PRIORITY', do: 'PLAY_CARD', card: altar },
      { prompt: 'CHOOSE_CARDS', match: 'Sacrifice', do: 'CHOOSE_CARDS', card: { name: 'Myr Retriever', zone: 'Battlefield' }, optional: true },
      { prompt: 'CHOOSE_TARGETS', do: 'CHOOSE_TARGETS', card: { name: target, zone: 'Graveyard' }, optional: true },
      { do: 'RESOLVE', answers: [] },
    ];
    const scry = { prompt: 'ARRANGE_CARDS', do: 'ARRANGE_CARDS' };
    const fountainActivation = [
      { prompt: 'PRIORITY', do: 'PLAY_CARD', card: { name: 'Blood Fountain', zone: 'Battlefield' } },
      {
        do: 'RESOLVE',
        answers: [
          { prompt: 'CHOOSE_TARGETS', do: 'CHOOSE_TARGETS', cards: [{ name: 'Myr Retriever', zone: 'Graveyard' }, { name: 'Myr Retriever', zone: 'Graveyard' }] },
          pay,
        ],
      },
    ];
    const makeGolem = [
      { do: 'REPEAT', label: 'Charging Golem Foundry', until: { counters: { name: 'Golem Foundry', kind: 'Charge', atLeast: 3 } }, steps: retrieverHalf, max: 4 },
      { prompt: 'PRIORITY', do: 'PLAY_CARD', card: { name: 'Golem Foundry', zone: 'Battlefield' } },
      { do: 'RESOLVE', answers: [foundryYes] },
    ];
    return {
      id: 'boulder-destroy-loop',
      name: "Giant's Boulder destroy loop",
      description:
        'Each loop destroys one opponent permanent (creatures first, then other nonlands, then lands) and ' +
        'returns the board to the start. Golems from Golem Foundry pay for it. Start with one Retriever on the ' +
        'battlefield and one in the graveyard.',
      unit: 'permanents to destroy',
      macro: false, // the loop changes every time (targets, fresh Golem tokens)
      choosesTargets: true,
      mana: { altar: "Ashnod's Altar", fodder: 'Golem', anyColor: 'Energy Refractor' },
      pieces: [
        { name: "Ashnod's Altar", zone: 'battlefield' },
        { name: 'Golem Foundry', zone: 'battlefield' },
        { name: 'Energy Refractor', zone: 'battlefield' },
        { name: 'Blood Fountain', zone: 'battlefield' },
        { name: "Giant's Boulder", zone: 'battlefield' },
        { name: 'Myr Retriever', zone: 'battlefield' },
        { name: 'Myr Retriever', zone: 'graveyard' },
      ],
      loop: [
        { do: 'REPEAT', label: 'Making Golems', until: { count: { name: 'Golem', zone: 'battlefield', atLeast: 9 } }, steps: makeGolem, max: 30 },
        { prompt: 'PRIORITY', do: 'PLAY_CARD', card: { name: "Giant's Boulder", zone: 'Battlefield' } },
        {
          do: 'RESOLVE',
          answers: [
            { prompt: 'CHOOSE_ABILITY', do: 'CHOOSE_ABILITY', ability: 'Destroy' },
            { prompt: 'CHOOSE_TARGETS', do: 'CHOOSE_TARGETS', card: { owner: 'opponent', zone: 'Battlefield' }, userPick: true },
            pay,
          ],
        },
        ...sacRetriever("Giant's Boulder"),
        ...fountainActivation,
        ...cast('Myr Retriever'),
        ...cast('Myr Retriever'),
        ...sacRetriever('Blood Fountain'),
        ...cast('Blood Fountain'),
        ...cast("Giant's Boulder", [scry]),
      ],
      // Picks up a loop that broke off: each rule fixes one piece, until the pieces are assembled.
      recover: [
        { when: { name: "Giant's Boulder", zone: 'Hand' }, steps: cast("Giant's Boulder", [scry]) },
        { when: { name: 'Myr Retriever', zone: 'Hand' }, steps: cast('Myr Retriever') },
        { when: { count: { name: "Giant's Boulder", zone: 'graveyard', atLeast: 1 } }, steps: sacRetriever("Giant's Boulder") },
        { when: { count: { name: 'Myr Retriever', zone: 'graveyard', atLeast: 2 } }, steps: fountainActivation },
        { when: { count: { name: 'Blood Fountain', zone: 'graveyard', atLeast: 1 } }, steps: sacRetriever('Blood Fountain') },
        { when: { name: 'Blood Fountain', zone: 'Hand' }, steps: cast('Blood Fountain') },
      ],
    };
  }
})();
