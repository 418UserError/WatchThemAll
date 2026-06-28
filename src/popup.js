/**
 * ReelVault — popup.js
 * Entry point. Wires StorageManager → PopupUI → DOM.
 */
document.addEventListener('DOMContentLoaded', async () => {
  const storage = new StorageManager();
  const ui = new PopupUI(storage);
  await ui.init();
});
