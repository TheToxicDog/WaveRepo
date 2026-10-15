import { api } from '../api.js';
import { heroColor, trackTable } from '../components.js';
import { player } from '../player.js';
import { go, refreshPlaylists } from '../store.js';
import { esc, fmtLong, icon, menu, prompt, toast } from '../ui.js';

export async function playlist(view, id) {
  const p = await api.get(`/api/playlists/${id}`);
  const covers = [...new Set(p.tracks.map((t) => t.cover))].slice(0, 4);
  const art = covers.length >= 4
    ? `<div class="hero-art" style="display:grid;grid-template-columns:1fr 1fr;overflow:hidden">${covers.map((c) => `<img src="${esc(c)}" style="width:100%;height:100%;object-fit:cover">`).join('')}</div>`
    : covers.length ? `<img class="hero-art" src="${esc(covers[0])}">` : `<div class="hero-art ph">${icon('playlist', 80)}</div>`;
  const ctx = { type: 'playlist', id, name: p.name };
  view.innerHTML = `<div class="hero" id="hero">${art}
      <div class="hero-info"><div class="hero-kind">Playlist</div><h1 id="pname" title="Click to rename" style="cursor:text">${esc(p.name)}</h1>
      <div class="hero-meta">${p.description ? `<span>${esc(p.description)}</span><span class="sep"></span>` : ''}<b>${p.tracks.length} songs</b><span class="sep"></span><span>${fmtLong(p.tracks.reduce((s, t) => s + (t.duration || 0), 0))}</span></div></div></div>
    <div class="actions"><button class="play-big" id="play">${icon('play', 26)}</button>
      <button class="icon-btn" id="shuf" title="Shuffle play">${icon('shuffle', 26)}</button>
      <button class="icon-btn" id="more">${icon('more', 26)}</button></div>
    <div id="list"></div>`;
  if (covers[0]) heroColor(view.querySelector('#hero'), covers[0]);
  const reload = () => playlist(view, id);
  if (p.tracks.length) {
    trackTable(view.querySelector('#list'), p.tracks, {
      context: ctx, playlistId: id,
      // local files have no global id, so removal is by position (index), like Spotify does
      onRemove: async (t) => { await api.patch(`/api/playlists/${id}`, { remove_index: p.tracks.indexOf(t) }); await refreshPlaylists(); reload(); },
    });
  } else {
    view.querySelector('#list').innerHTML = `<div class="empty">${icon('playlist', 48)}<h3>This playlist is empty</h3><p>Right-click any song and choose “Add to playlist”.</p></div>`;
  }
  const rename = async () => {
    const name = await prompt('Rename playlist', p.name);
    if (!name) return;
    await api.patch(`/api/playlists/${id}`, { name });
    await refreshPlaylists();
    reload();
  };
  view.querySelector('#pname').onclick = rename;
  view.querySelector('#play').onclick = () => player.playList(p.tracks, 0, { context: ctx, shuffle: false });
  view.querySelector('#shuf').onclick = () => player.playList(p.tracks, 0, { context: ctx, shuffle: true });
  view.querySelector('#more').onclick = (e) => menu(e, [
    { label: 'Rename', icon: 'lyrics', action: rename },
    { label: 'Add to queue', icon: 'queue', action: () => { player.addToQueue(p.tracks); toast('Added to queue'); } },
    { label: 'Delete playlist', icon: 'trash', action: async () => {
      if (!confirm(`Delete “${p.name}”?`)) return;
      await api.del(`/api/playlists/${id}`);
      await refreshPlaylists();
      go('/');
    } },
  ]);
}
