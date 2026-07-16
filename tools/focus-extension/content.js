(function () {
  function requestFocus() {
    try {
      chrome.runtime.sendMessage({ type: 'CUECAST_RUNNER_FOCUS' });
    } catch {
      // The helper is best-effort only.
    }
  }

  requestFocus();
  window.addEventListener('load', requestFocus, { once: true });
  setTimeout(requestFocus, 300);
  setTimeout(requestFocus, 1200);
})();
