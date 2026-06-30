/**
 * WatchThemAll v2 — app.js
 * Entry point. Wires StorageManager → AppUI → DOM.
 */
document.addEventListener('DOMContentLoaded', async () => {
  const storage = new StorageManager();
  const ui = new AppUI(storage);
  await ui.init();

  // Expose for debugging
  window.__wt = { storage, ui };

  // Set data directory in status bar
  if (window.wtAPI) {
    try {
      const dir = await window.wtAPI.getDataDir();
      const el = document.getElementById('status-left');
      if (el) {
        el.textContent = dir;
        el.title = dir;
        el.style.cursor = 'default';
      }
    } catch (_) { /* non-critical */ }
  }
});
