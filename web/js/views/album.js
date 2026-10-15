import { api, img } from '../api.js';
import { addToPlaylistDialog, albumCard, bindCards, downloadAlbum, grid, heroColor, queuedState, trackTable } from '../components.js';
import { player } from '../player.js';
import { store } from '../store.js';
import { esc, fmtLong, icon, menu, toast } from '../ui.js';

// Local album page. Optionally shows tracks from the online edition you don't have.
export async function localAlbum(view, id) {
  const a = await api.get(`/api/albums/${id}`);
  const ctx = { type: 'album', id, name: a.title };
  view.innerHTML = `<div class="hero" id="hero">
      <img class="hero-art" src="${esc(a.cover)}" alt="" onerror="this.style.opacity=0">
      <div class="hero-info"><div class="hero-kind">${a.track_count > 3 ? 'Album' : 'Single / EP'} <span class="badge-sm saved">${icon('check', 10)} On this device</span></div>
        <h1>${esc(a.title)}</h1>
        <div class="hero-meta"><a href="#/artist/${esc(a.artist_id)}"><b>${esc(a.artist)}</b></a>${a.year ? `<span class="sep"></span><span>${a.year}</span>` : ''}
        <span class="sep"></span><span>${a.track_count} songs, ${fmtLong(a.duration || 0)}</span>${a.genre ? `<span class="sep"></span><span>${esc(a.genre)}</span>` : ''}</div></div></div>
    <div class="actions"><button class="play-big" id="play">${icon('play', 26)}</button>
      <button class="icon-btn" id="shuf" title="Shuffle play">${icon('shuffle', 26)}</button>
      <button class="icon-btn" id="more" title="More">${icon('more', 26)}</button></div>
    <div id="list"></div><div id="missing" style="padding:0 24px"></div><div id="more-by" style="padding:0 24px"></div>`;
  heroColor(view.querySelector('#hero'), a.cover);
  bindCards(view);
  trackTable(view.querySelector('#list'), a.tracks, { cover: false, album: false, number: 'track', col4: 'plays', context: ctx });
  view.querySelector('#play').onclick = () => player.playList(a.tracks, 0, { context: ctx, shuffle: false });
  view.querySelector('#shuf').onclick = () => player.playList(a.tracks, 0, { context: ctx, shuffle: true });
  view.querySelector('#more').onclick = (e) => menu(e, [
    { label: 'Add to queue', icon: 'queue', action: () => { player.addToQueue(a.tracks); toast('Added to queue'); } },
    { label: 'Add to playlist…', icon: 'playlist', action: () => addToPlaylistDialog(a.tracks.map((t) => t.id)) },
    { label: 'Go to artist', icon: 'mic', action: () => (location.hash = `#/artist/${a.artist_id}`) },
  ]);
  if (!store.settings.online) return;
  // compare with the full online edition: show what's missing
  api.get(`/api/albums/${id}/online`).then(({ match }) => {
    if (!match || !view.contains(view.querySelector('#missing'))) return;
    const missing = match.tracks.filter((t) => !t.saved);
    if (!missing.length) return;
    const box = view.querySelector('#missing');
    box.innerHTML = `<div class="section"><div class="section-head"><h2>Missing from this album <small>${missing.length} not saved</small></h2>
      <button class="btn sm primary" id="dlmissing">${icon('download', 16)} Download missing</button></div><div id="mlist"></div></div>`;
    trackTable(box.querySelector('#mlist'), missing, { album: false, cover: false, number: 'track', col4: 'none' });
    box.querySelector('#dlmissing').onclick = () => downloadAlbum(match.id);
  }).catch(() => {});
}

// Online album page: everything visible, unsaved tracks clearly marked.
export async function onlineAlbum(view, id) {
  view.innerHTML = `<div class="page"><div class="muted">Loading…</div></div>`;
  const a = await api.get(`/api/online/album/${id}`);
  const unsaved = a.tracks.filter((t) => !t.saved);
  const allQueued = unsaved.length && unsaved.every((t) => queuedState(t.id));
  const status = a.saved ? `<span class="badge-sm saved">${icon('check', 10)} Saved</span>`
    : a.partial ? `<span class="badge-sm" style="background:var(--warn);color:#241400">${a.saved_tracks}/${a.tracks.length} saved</span>`
      : `<span class="badge-sm cloud">${icon('cloud', 11)} Not saved</span>`;
  view.innerHTML = `<div class="hero" id="hero">
      <img class="hero-art" src="${esc(img(a.cover))}" alt="">
      <div class="hero-info"><div class="hero-kind">${esc(a.type || 'album')} ${status}</div>
        <h1>${esc(a.title)}</h1>
        <div class="hero-meta"><a href="#/online/artist/${esc(a.artist_id)}"><b>${esc(a.artist)}</b></a>${a.year ? `<span class="sep"></span><span>${a.year}</span>` : ''}
        <span class="sep"></span><span>${a.tracks.length} songs, ${fmtLong(a.duration || 0)}</span>${a.label ? `<span class="sep"></span><span>${esc(a.label)}</span>` : ''}</div></div></div>
    <div class="actions">
      ${a.saved ? `<button class="play-big" id="play">${icon('play', 26)}</button>` : allQueued ? `<a class="btn" href="#/downloads" style="height:48px;padding:0 24px;font-size:15px">${icon('download', 20)} In your download queue</a>` : `<button class="btn primary" id="dl" style="height:48px;padding:0 24px;font-size:15px">${icon('download', 20)} ${a.partial ? `Download ${a.tracks.length - a.saved_tracks} missing` : 'Download album'}</button>`}
      ${a.partial ? `<button class="btn" id="play">${icon('play', 18)} Play saved</button>` : ''}
      ${a.saved && a.local_id ? `<a class="btn" href="#/album/${esc(a.local_id)}">${icon('disc', 18)} Open in library</a>` : ''}
    </div>
    <div id="list"></div><div id="more-by" style="padding:0 24px"></div>`;
  heroColor(view.querySelector('#hero'), img(a.cover));
  bindCards(view);
  const t = trackTable(view.querySelector('#list'), a.tracks, { cover: false, album: false, number: 'track', col4: 'none', context: { type: 'album', name: a.title } });
  view.querySelector('#dl')?.addEventListener('click', () => downloadAlbum(a.id));
  view.querySelector('#play')?.addEventListener('click', () => {
    const first = a.tracks.findIndex((x) => x.saved);
    if (first >= 0) t.play(first);
  });
  if (a.artist_id) {
    api.get(`/api/online/artist/${a.artist_id}`).then((ar) => {
      const others = ar.albums.filter((x) => x.id !== a.id).slice(0, 12);
      if (others.length && view.querySelector('#more-by')) {
        view.querySelector('#more-by').innerHTML = `<div class="section"><div class="section-head"><h2>More by ${esc(a.artist)}</h2><a href="#/online/artist/${esc(a.artist_id)}">Show discography</a></div>${grid(others, albumCard, true)}</div>`;
      }
    }).catch(() => {});
  }
}
