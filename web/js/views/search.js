import { api, img } from '../api.js';
import { albumCard, artistCard, bindCards, grid, trackTable } from '../components.js';
import { player } from '../player.js';
import { store } from '../store.js';
import { esc, fmtTime, icon, safeHl } from '../ui.js';

let tab = 'all';
let seq = 0;

function recent() { try { return JSON.parse(localStorage.getItem('wg.recentSearches') || '[]'); } catch { return []; } }
function remember(q) {
  try { localStorage.setItem('wg.recentSearches', JSON.stringify([q, ...recent().filter((x) => x !== q)].slice(0, 8))); } catch { /* ignore */ }
}

export async function search(view, params) {
  const q = (params.get('q') || '').trim();
  const input = document.getElementById('q');
  if (document.activeElement !== input) input.value = q;
  if (!q) return browse(view);
  const my = ++seq;
  view.innerHTML = `<div class="page"><div class="chips search-tabs">${['all', 'songs', 'lyrics', 'albums', 'artists', 'online'].map((t) =>
    `<button class="chip ${tab === t ? 'active' : ''}" data-tab="${t}">${t === 'online' ? `${icon('cloud', 14)} Internet` : t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
    <div id="local"><div class="muted">Searching…</div></div><div id="online"></div></div>`;
  bindCards(view);
  view.querySelector('.search-tabs').onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) { tab = b.dataset.tab; search(view, params); }
  };
  const loc = await api.get(`/api/search?q=${encodeURIComponent(q)}`);
  if (my !== seq) return;
  setTimeout(() => remember(q), 1500);
  renderLocal(view.querySelector('#local'), loc, q);
  if ((tab === 'all' || tab === 'online') && store.settings.online) {
    const box = view.querySelector('#online');
    box.innerHTML = `<div class="section"><div class="section-head"><h2>${icon('cloud', 18)} From the internet</h2></div><div class="muted">Searching online…</div></div>`;
    try {
      const on = await api.get(`/api/online/search?q=${encodeURIComponent(q)}`);
      if (my !== seq) return;
      renderOnline(box, on);
    } catch (e) {
      box.innerHTML = `<div class="offline-note">${icon('cloud', 18)} ${esc(e.message)} — showing your downloaded music only.</div>`;
    }
  }
}

function renderLocal(box, r, q) {
  const total = r.tracks.length + r.albums.length + r.artists.length + r.lyrics.length;
  if (tab === 'online') { box.innerHTML = ''; return; }
  if (!total) {
    box.innerHTML = `<div class="section"><div class="offline-note">${icon('search', 18)} Nothing in your library matches “${esc(q)}”.${store.settings.online ? ' Check the internet results below to download it.' : ''}</div></div>`;
    return;
  }
  let html = '';
  const show = (t) => tab === 'all' || tab === t;
  if (tab === 'all' && (r.tracks.length || r.artists.length || r.albums.length)) {
    const top = r.artists[0] && r.artists[0].name.toLowerCase().startsWith(q.toLowerCase()) ? { kind: 'artist', x: r.artists[0] }
      : r.albums[0] && r.albums[0].title.toLowerCase().startsWith(q.toLowerCase()) ? { kind: 'album', x: r.albums[0] }
        : r.tracks[0] ? { kind: 'song', x: r.tracks[0] } : r.artists[0] ? { kind: 'artist', x: r.artists[0] } : { kind: 'album', x: r.albums[0] };
    const t = top.x;
    const href = top.kind === 'artist' ? `#/artist/${t.id}` : top.kind === 'album' ? `#/album/${t.id}` : `#/album/${t.album_id}`;
    const cover = top.kind === 'artist' && t.cover?.startsWith('http') ? img(t.cover) : t.cover;
    html += `<div class="top-result"><div><div class="section-head"><h2>Top result</h2></div>
      <div class="top-card" data-href="${href}" data-top="${top.kind}">
        <img src="${esc(cover)}" alt="" style="${top.kind === 'artist' ? 'border-radius:50%' : ''}" onerror="this.style.visibility='hidden'">
        <h3>${esc(t.name || t.title)}</h3>
        <div class="muted"><span class="pill">${top.kind[0].toUpperCase() + top.kind.slice(1)}</span> ${esc(top.kind === 'artist' ? '' : t.artist)}</div>
        <button class="play-fab" id="top-play">${icon('play', 24)}</button></div></div>
      <div><div class="section-head"><h2>Songs</h2></div><div id="top-songs"></div></div></div>`;
    box._top = top;
  }
  if (show('lyrics') && r.lyrics.length) {
    html += `<div class="section"><div class="section-head"><h2>${icon('lyrics', 18)} In the lyrics <small>click a line to jump straight to it</small></h2></div>
      ${r.lyrics.map((t, i) => `<div class="lyric-hit" data-lyr="${i}"><img src="${esc(t.cover)}" alt="" onerror="this.style.visibility='hidden'">
        <div style="min-width:0"><div class="line">“${safeHl(t.line)}”</div><div class="muted" style="font-size:13px">${esc(t.title)} • ${esc(t.artist)}</div></div>
        <span class="ts">${t.timestamp_ms != null ? `${icon('play', 14)} ${fmtTime(t.timestamp_ms / 1000)}` : 'unsynced'}</span></div>`).join('')}</div>`;
  }
  if (tab === 'songs' && r.tracks.length) html += `<div class="section"><div class="section-head"><h2>Songs</h2></div><div id="songs"></div></div>`;
  if (show('artists') && r.artists.length) html += `<div class="section"><div class="section-head"><h2>Artists</h2></div>${grid(r.artists, artistCard, tab === 'all')}</div>`;
  if (show('albums') && r.albums.length) html += `<div class="section"><div class="section-head"><h2>Albums</h2></div>${grid(r.albums, albumCard, tab === 'all')}</div>`;
  box.innerHTML = html || `<div class="offline-note">No ${tab} matches in your library.</div>`;
  const ts = box.querySelector('#top-songs');
  if (ts) trackTable(ts, r.tracks.slice(0, 4), { album: false, col4: 'none', context: { type: 'search', name: q } });
  const sl = box.querySelector('#songs');
  if (sl) trackTable(sl, r.tracks, { context: { type: 'search', name: q } });
  box.querySelector('#top-play')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const top = box._top;
    if (top.kind === 'song') return player.playList(r.tracks, 0, { context: { type: 'search', name: q } });
    if (top.kind === 'album') { const a = await api.get(`/api/albums/${top.x.id}`); return player.playList(a.tracks, 0); }
    const a = await api.get(`/api/artists/${top.x.id}`);
    player.playList(a.top_tracks, 0);
  });
  box.querySelectorAll('[data-lyr]').forEach((el) => el.addEventListener('click', () => {
    const t = r.lyrics[+el.dataset.lyr];
    player.playList([t], 0, { startAtMs: Math.max(0, (t.timestamp_ms || 0) - 400), context: { type: 'search', name: q } });
  }));
}

function renderOnline(box, on) {
  const show = (t) => tab === 'all' || tab === 'online';
  if (!show()) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="section"><div class="section-head"><h2>${icon('cloud', 18)} Albums on the internet <small>download anything marked “Not saved”</small></h2></div>${grid(on.albums, albumCard, tab === 'all')}</div>
    <div class="section"><div class="section-head"><h2>${icon('cloud', 18)} Songs on the internet</h2></div><div id="on-tracks"></div></div>
    ${on.artists.length ? `<div class="section"><div class="section-head"><h2>${icon('cloud', 18)} Artists</h2></div>${grid(on.artists, artistCard, true)}</div>` : ''}`;
  trackTable(box.querySelector('#on-tracks'), on.tracks.slice(0, tab === 'online' ? 40 : 8), { col4: 'none' });
}

async function browse(view) {
  const rec = recent();
  view.innerHTML = `<div class="page"><h1>Search</h1>
    ${rec.length ? `<div class="section"><div class="section-head"><h2>Recent searches</h2><a href="#" id="clear-rec">Clear</a></div>
      <div class="chips">${rec.map((q) => `<a class="chip" style="display:inline-flex;align-items:center" href="#/search?q=${encodeURIComponent(q)}">${esc(q)}</a>`).join('')}</div></div>` : ''}
    <div class="section"><div class="section-head"><h2>Tips</h2></div><div class="muted">Search matches song titles, artists, albums, genres and <b>lyrics</b> — try a line you remember. Results from the internet show up below your own music.</div></div>
    <div id="genres"></div></div>`;
  view.querySelector('#clear-rec')?.addEventListener('click', (e) => { e.preventDefault(); localStorage.removeItem('wg.recentSearches'); browse(view); });
  document.getElementById('q').focus();
  if (!store.settings.online) return;
  try {
    const g = await api.get('/api/online/genres');
    view.querySelector('#genres').innerHTML = `<div class="section"><div class="section-head"><h2>Browse genres</h2></div>
      <div class="genres">${g.map((x, i) => `<a class="genre" href="#/discover?genre=${x.id}&name=${encodeURIComponent(x.name)}" style="--h:${(i * 47) % 360}">
        <b>${esc(x.name)}</b><img src="${esc(img(x.picture))}" alt="" loading="lazy"></a>`).join('')}</div></div>`;
  } catch { /* offline */ }
}
