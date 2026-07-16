let focusedOnce = false;

async function focusSenderTab(sender) {
  if (focusedOnce) return { ok: true, skipped: true };

  const tabId = sender?.tab?.id;
  const windowId = sender?.tab?.windowId;
  if (tabId == null && windowId == null) {
    return { ok: false, error: 'No sender tab or window to focus' };
  }

  focusedOnce = true;
  if (tabId != null) {
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  }
  if (windowId != null) {
    await chrome.windows.update(windowId, { focused: true }).catch(() => {});
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'CUECAST_RUNNER_FOCUS') return false;
  focusSenderTab(sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
