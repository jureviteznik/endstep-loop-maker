# endstep-loop-maker
A chrome addon that helps you with setting up and executing loops on endstep.cc

## Status
- **Traffic capture:** done.
- **Protocol decoding:** done.
- **Hardcoded combo detection and execution:**
  - Ashnod's Altar + 2× Myr Retriever: done.
  - Giant's Boulder destroy loop: written, but not yet checked against a capture. It adds Golem Foundry, Energy Refractor, Blood Fountain and Giant's Boulder to the above, and destroys one permanent per loop. Golems from the Foundry, sacrificed to the Altar, pay for everything. The loop is in `src/combos/builtin.js`.
- **User-recorded combos:** next.

The loop answers each engine prompt by choosing a card by **name and zone** from that prompt's options, never by a recorded card ID. That's what breaks endstep's own macros ("could not tell which card the recorded answer meant"): with this combo, the two Retrievers keep swapping IDs.

### Macro mode (optional, on by default)
Untick **Use endstep macros** in the panel to play every loop by hand. With it on, the runner hands repetition to endstep's server-side macro to keep the message count low:
1. It sends `RECORD_START`, then plays one loop by hand (one iteration = a full loop back to the starting board), and sends `RECORD_STOP`.
2. It sends `RUN` for the remaining loops. The server often stops a run early, so it sends `RUN` again from the same position.
3. If a macro doesn't report back within 10 s, or makes no progress, the runner:
   - stops and discards it;
   - brings the board back to the start, finishing a loop that broke off halfway (`recover` in the combo);
   - records the macro again.
4. After 2 macro failures in a row, the rest of the run is played by hand.

The server may run a macro silently and send only the result (`ARMED`, `iterationsDone`), with no `RUNNING` state in between. It also caps one `RUN` at about 3 loops ("it ran for as long as one turn of play should"), so the runner sends `RUN` again.

A step that fails during play by hand also gets one recovery and retry before the run stops.

Turn on **Always yes** for optional triggers (e.g. Golem Foundry) in the game UI. That makes both the recorded macro and the manual loop shorter. Running a combo discards any macro you had armed yourself.

## Protocol (learned from `fixtures/`)
- **Game state** comes in on `wss://endstep.cc/play/<engine>/ws`:
  - `GAME_STATE`: full snapshot
  - `GAME_DELTA`: scalar patch plus the current prompt
  - `GAME_EVENT`: log entries
  - `ATTACHED`: `audience` is your player ID
- **The current prompt** is `pendingAction`: `{type, message, cardOptions|modeOptions, promptVersion}`.
- **Actions** go out on `wss://endstep.cc/ws` as `{"type":"GAME_ACTION","payload":{type, ...fields, promptVersion, matchId, actionId}}`. Types seen so far:
  - `PLAY_CARD{cardId}`
  - `CHOOSE_CARDS{orderedCards}`
  - `CHOOSE_TARGETS{targets}`
  - `CHOOSE_ABILITY{numberValue}`
  - `TAP_MANA{cardId}`
  - `AUTO_PAY`, `PASS_PRIORITY`, `YES`, `CANCEL`, `KEEP_HAND`, `ARRANGE_CARDS`
- **Macros** go out on the same socket as `{"type":"MACRO","payload":{matchId, action, count?}}`, where `action` is one of `RECORD_START`, `RECORD_STOP`, `RUN`, `STEP`, `STOP` or `DISCARD`. Their progress shows up in `GAME_STATE.macro`: `{state: IDLE|RECORDING|ARMED|RUNNING|PROPOSED, iterationsDone, lastStop}`.
- **"Always yes" triggers** are sent by the page as `SET_AUTO_YIELDS{triggerAccept:[...]}`. Each key is a stack item's `yieldKey` with the leading `"Card (id): "` removed.

## Tests
`npm test` replays the captured game and checks that the executor sends exactly the actions played by hand. Without Node installed, VS Code's bundled Node works too: `ELECTRON_RUN_AS_NODE=1 "<VS Code>/Code.exe" tests/replay.test.js`.

## Install (unpacked)
1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder (the one containing `manifest.json`).
3. Reload any open endstep.cc tabs. The hook has to be in place before the page opens its socket.
4. Click the extension's toolbar icon to open the side panel.
   - **Opera / Opera GX** has no Chrome side panel. There the icon opens the panel in a small popup window. It's also available as an entry in Opera's sidebar (enable it under the sidebar's "..." setup menu).

## Capturing a game for protocol work
1. Start a **bot game** on endstep.cc with a deck containing a simple combo.
2. With the side panel open, play normally. Try to cover:
   - casting a spell, activating an ability, choosing a target
   - paying mana, passing priority, ordering simultaneous triggers
   - running the combo by hand for a couple of iterations
3. Under **Sessions**, click **Export**. Put the JSON in `fixtures/`.

Captures can contain session tokens. Don't commit or share exports from your main account's ranked games.

## How it works
- `src/inject/ws-hook.js` runs in the page (MAIN world) at `document_start`. It wraps `WebSocket`, `EventSource` and `fetch` (fetch: method/URL/status only), and can send frames on the live socket.
- `src/content/bridge.js` batches records to the service worker and relays side-panel commands to the page.
- `src/background/service-worker.js` stores records in IndexedDB (`src/shared/db.js`).
- `src/ui/sidepanel.*` shows live traffic, sockets, sessions and export, plus a raw frame sender for protocol testing.

Known gap: sockets opened from Web Workers aren't hooked. If the live view stays empty during a game, that's the likely cause.

## Roadmap
1. Protocol decoder: frames → normalized game state (zones, cards, prompts).
2. Hardcoded combos: matcher detects assembled pieces, executor sends the loop's actions.
3. User-defined combos: record a combo by hand, generalize it, save/share as JSON.
