/**
 * WatchThemAll — popup.js
 * Entry point. Wires StorageManager → PopupUI → DOM.
 * Handles desktop-specific IPC events (menu shortcuts,
 * notification tab navigation) and keyboard shortcuts.
 */
document.addEventListener('DOMContentLoaded', async () => {
  const storage = new StorageManager();
  const ui = new PopupUI(storage);
  await ui.init();

  // ── Desktop IPC events (Electron-only) ──────────────────────
  if (window.wtAPI) {
    // Menu → "New Bookmark" (Ctrl+N)
    window.wtAPI.onMenuAction((action) => {
      if (action === 'new-bookmark') {
        ui._switchTab('bookmarks');
        const toggle = document.getElementById('bm-toggle-btn');
        const form = document.getElementById('bm-form-wrap');
        if (toggle && form && form.style.display === 'none') toggle.click();
        setTimeout(() => document.getElementById('bm-search')?.focus(), 100);
      } else if (action === 'new-watchlist') {
        ui._switchTab('watchlist');
        const toggle = document.getElementById('wl-toggle-btn');
        const form = document.getElementById('wl-form-wrap');
        if (toggle && form && form.style.display === 'none') toggle.click();
        setTimeout(() => document.getElementById('wl-search')?.focus(), 100);
      }
    });

    // Menu → View tabs (Ctrl+1/2/3/4)
    window.wtAPI.onNavigateTab((tab) => {
      ui._switchTab(tab);
    });
  }

  // ── Keyboard shortcuts ──────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;

    // Ctrl+F / Cmd+F: focus search field for active tab
    if (mod && e.key === 'f') {
      e.preventDefault();
      const searchMap = {
        schemas: '#schema-search',
        bookmarks: '#bm-filter-search',
        watchlist: '#wl-filter-search',
        history: '#hist-search',
      };
      const sel = searchMap[ui.activeTab];
      if (sel) document.querySelector(sel)?.focus();
    }

    // Escape: close any open form/panel
    if (e.key === 'Escape') {
      const bmForm = document.getElementById('bm-form-wrap');
      if (bmForm && bmForm.style.display !== 'none') {
        document.getElementById('bm-cancel-btn')?.click();
      }
      const wlForm = document.getElementById('wl-form-wrap');
      if (wlForm && wlForm.style.display !== 'none') {
        document.getElementById('wl-cancel-btn')?.click();
      }
    }
  });

  // Expose for debugging
  window.__wt = { storage, ui };

  // Set data directory in footer
  if (window.wtAPI) {
    try {
      const dir = await window.wtAPI.getDataDir();
      const el = document.getElementById('footer-data-dir');
      if (el) {
        el.textContent = dir;
        el.title = dir;
        el.style.cursor = 'default';
      }
    } catch (_) { /* non-critical */ }
  }
});
