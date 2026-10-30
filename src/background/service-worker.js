import { putSession, addRecords } from '../shared/db.js';

const PANEL_PATH = 'src/ui/sidepanel.html';

// Chrome has a side panel API; Opera/others don't, so fall back to a popup window.
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => console.error(err));
} else {
  let panelWindowId = null;
  chrome.action.onClicked.addListener(async () => {
    if (panelWindowId != null) {
      try {
        await chrome.windows.update(panelWindowId, { focused: true });
        return;
      } catch {
        panelWindowId = null;
      }
    }
    const win = await chrome.windows.create({ url: PANEL_PATH, type: 'popup', width: 420, height: 800 });
    panelWindowId = win.id;
  });
  chrome.windows.onRemoved.addListener((id) => {
    if (id === panelWindowId) panelWindowId = null;
  });
}

let capturing = true;
chrome.storage.local.get({ capturing: true }).then((v) => {
  capturing = v.capturing;
});
chrome.storage.local.onChanged.addListener((changes) => {
  if (changes.capturing) capturing = changes.capturing.newValue;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'bridge') return;
  const tabId = port.sender && port.sender.tab ? port.sender.tab.id : null;

  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'hello') {
      await putSession({ ...msg.session, tabId });
    } else if (msg.type === 'batch') {
      if (capturing) await addRecords(msg.sessionId, msg.records);
      // Live tail for the side panel; fails harmlessly when the panel is closed.
      chrome.runtime
        .sendMessage({ type: 'live', tabId, sessionId: msg.sessionId, records: msg.records, stored: capturing })
        .catch(() => {});
    }
  });
});
