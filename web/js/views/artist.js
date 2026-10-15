import { api, img } from '../api.js';
import { albumCard, artistCard, bindCards, downloadAlbum, grid, heroColor, trackTable } from '../components.js';
import { player } from '../player.js';
import { store } from '../store.js';
import { esc, icon, toast } from '../ui.js';

// Local artist: your albums first, then their full discography from the
// catalog with unsaved releases marked.
export async function localArtist(view, id) {
  const a = await api.get(`/api/artists/${id}`);
  const cover = a.cover?.startsWith('http') ? img(a.cover) : a.cover;
  view.innerHTML = `<div class="hero" id="hero">
      ${cover ? `<img class="hero-art round" src="${esc(cover)}" alt="">` : `<div class="hero-art round ph">${icon('mic', 80)}</div>`}
      <div class="hero-info"><div class="hero-kind">Artist <span class="badge-sm saved">${icon('check', 10)} In your library</span></div>
        <h1>${esc(a.name)}</h1>
        <div class="hero-meta"><span>${a.album_count} album${a.album_count === 1 ? '' : 's'}</span><span class="sep"></span><span>${a.track_count} songs saved</span></div></div></div>
    <div class="actions"><button class="play-big" id="play">${icon('play', 26)}</button>
      <button class="icon-btn" id="shuf" title="Shuffle play">${icon('shuffle', 26)}</button></div>
    <div style="padding:0 24px"><div class="section-head"><h2>Popular in your library</h2></div></div>
    <div id="top"></div>
    <div style="padding:0 24px">
      ${a.albums.length ? `<div class="section"><div class="section-head"><h2>Your albums</h2></div>${grid(a.albums, albumCard)}</div>` : ''}
      ${a.eps.length ? `<div class="section"><div class="section-head"><h2>Your singles & EPs</h2></div>${grid(a.eps, albumCard)}</div>` : ''}
      ${a.singles.length ? `<div class="section"><div class="section-head"><h2>Singles & loose songs</h2></div><div id="singles"></div></div>` : ''}
      ${a.appears_on.length ? `<div class="section"><div class="section-head"><h2>Appears on</h2></div><div id="appears"></div></div>` : ''}
      <div id="disco"></div><div id="related"></div></div>`;
  heroColor(view.querySelector('#hero'), cover);
  bindCards(view);
  const ctx = { type: 'artist', id, name: a.name };
  trackTable(view.querySelector('#top'), a.top_tracks.slice(0, 5), { col4: 'plays', context: ctx });
  if (a.singles.length) trackTable(view.querySelector('#singles'), a.singles, { col4: 'year', context: ctx });
  if (a.appears_on.length) trackTable(view.querySelector('#appears'), a.appears_on, { col4: 'none' });
  const allTracks = async () => (await Promise.all(a.albums.concat(a.eps).map((al) => api.get(`/api/albums/${al.id}`)))).flatMap((x) => x.tracks).concat(a.singles);
  view.querySelector('#play').onclick = async () => player.playList(await allTracks(), 0, { context: ctx, shuffle: false });
  view.querySelector('#shuf').onclick = async () => player.playList(await allTracks(), 0, { context: ctx, shuffle: true });
  if (!store.settings.online) return;
  api.get(`/api/artists/${id}/online`).then(({ match }) => {
    if (!match || !view.querySelector('#disco')) return;
    if (match.image && !cover) {
      const ph = view.querySelector('.hero-art.ph');
      if (ph) ph.outerHTML = `<img class="hero-art round" src="${esc(img(match.image))}" alt="">`;
    }
    const missing = match.albums.filter((x) => !x.saved);
    view.querySelector('#disco').innerHTML = `<div class="section"><div class="section-head">
      <h2>Discography <small>${icon('cloud', 13)} ${missing.length} not saved</small></h2>
      <a href="#/online/artist/${esc(match.id)}">See online page</a></div>${grid(match.albums, albumCard)}</div>`;
    if (match.related?.length) {
      view.querySelector('#related').innerHTML = `<div class="section"><div class="section-head"><h2>Fans also like</h2></div>${grid(match.related, artistCard, true)}</div>`;
    }
  }).catch(() => {});
}

export async function onlineArtist(view, id) {
  view.innerHTML = `<div class="page"><div class="muted">Loading…</div></div>`;
  const a = await api.get(`/api/online/artist/${id}`);
  const missing = a.albums.filter((x) => !x.saved);
  const albums = a.albums.filter((x) => x.type === 'album'), singles = a.albums.filter((x) => x.type !== 'album');
  view.innerHTML = `<div class="hero" id="hero">
      <img class="hero-art round" src="${esc(img(a.image))}" alt="">
      <div class="hero-info"><div class="hero-kind">Artist ${a.saved ? `<span class="badge-sm saved">${icon('check', 10)} In your library</span>` : `<span class="badge-sm cloud">${icon('cloud', 11)} Not in your library</span>`}</div>
        <h1>${esc(a.name)}</h1>
        <div class="hero-meta">${a.fans ? `<span>${a.fans.toLocaleString()} fans</span><span class="sep"></span>` : ''}<span>${a.albums.length} releases • ${a.albums.length - missing.length} saved</span></div></div></div>
    <div class="actions">${a.saved && a.local_id ? `<a class="btn" href="#/artist/${esc(a.local_id)}">${icon('mic', 18)} Open in library</a>` : ''}
      ${missing.length ? `<button class="btn primary" id="dlall">${icon('download', 18)} Download all ${missing.filter((x) => x.type === 'album').length} albums</button>` : ''}</div>
    <div style="padding:0 24px"><div class="section-head"><h2>Popular</h2></div></div><div id="top"></div>
    <div style="padding:0 24px">
      ${albums.length ? `<div class="section"><div class="section-head"><h2>Albums</h2></div>${grid(albums, albumCard)}</div>` : ''}
      ${singles.length ? `<div class="section"><div class="section-head"><h2>Singles & EPs</h2></div>${grid(singles, albumCard)}</div>` : ''}
      ${a.related.length ? `<div class="section"><div class="section-head"><h2>Fans also like</h2></div>${grid(a.related, artistCard, true)}</div>` : ''}</div>`;
  heroColor(view.querySelector('#hero'), img(a.image));
  bindCards(view);
  trackTable(view.querySelector('#top'), a.top_tracks, { col4: 'none' });
  view.querySelector('#dlall')?.addEventListener('click', async () => {
    const todo = missing.filter((x) => x.type === 'album');
    for (const al of todo) await downloadAlbum(al.id);
    toast(`Queued ${todo.length} albums`);
  });
}
