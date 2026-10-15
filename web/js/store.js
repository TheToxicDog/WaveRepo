// Shared app state + navigation helper (kept separate to avoid import cycles).
import { api } from './api.js';

export const store = {
  settings: {},
  playlists: [],
  stats: {},
  queue: { items: [], paused: false },
};

export function go(path) {
  if (location.hash !== '#' + path) location.hash = path;
}

export async function refreshPlaylists() {
  store.playlists = await api.get('/api/playlists');
  document.dispatchEvent(new CustomEvent('playlists'));
}

export async function saveSettings(patch) {
  store.settings = await api.patch('/api/settings', patch);
  document.dispatchEvent(new CustomEvent('settings'));
  return store.settings;
}
