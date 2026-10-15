import { api } from '../api.js';
import { albumCard, artistCard, bindCards, grid, trackTable } from '../components.js';
import { player } from '../player.js';
import { debounce, fmtLong, icon } from '../ui.js';

const tabs = (active) => `<div class="chips">
  <a class="chip ${active === 'albums' ? 'active' : ''}" href="#/library/albums" style="display:inline-flex;align-items:center">Albums</a>
  <a class="chip ${active === 'singles' ? 'active' : ''}" href="#/library/singles" style="display:inline-flex;align-items:center">Singles & EPs</a>
  <a class="chip ${active === 'artists' ? 'active' : ''}" href="#/library/artists" style="display:inline-flex;align-items:center">Artists</a>
  <a class="chip ${active === 'songs' ? 'active' : ''}" href="#/library/songs" style="display:inline-flex;align-items:center">Songs</a>
  <a class="chip ${active === 'liked' ? 'active' : ''}" href="#/liked" style="display:inline-flex;align-items:center">Liked Songs</a></div>`;

function pref(key, def) { try { return localStorage.getItem(key) || def; } catch { return def; } }
function setPref(key, v) { try { localStorage.setItem(key, v); } catch { /* ignore */ } }

// kind: 'album' (full albums only) or 'singles' (EPs and singles)
export async function albums(view, kind = 'album') {
  let sort = pref('wg.albumSort', 'added');
  const label = kind === 'singles' ? 'Singles & EPs' : 'Albums';
  view.innerHTML = `<div class="page"><h1>${label}</h1>${tabs(kind === 'singles' ? 'singles' : 'albums')}
    <div class="row" style="margin-bottom:18px"><input class="input" id="flt" placeholder="Filter ${label.toLowerCase()}" style="max-width:280px">
    <span class="spacer"></span><span class="muted">Sort</span>
    <select class="input" id="sort" style="width:170px">
      <option value="added">Recently added</option><option value="title">Title</option><option value="artist">Artist</option><option value="year">Release year</option>
    </select></div><div id="list"></div></div>`;
  bindCards(view);
  const sel = view.querySelector('#sort');
  sel.value = sort;
  const load = async () => {
    const q = view.querySelector('#flt').value.trim();
    const items = await api.get(`/api/albums?sort=${sort}&kind=${kind}&q=${encodeURIComponent(q)}`);
    view.querySelector('#list').innerHTML = items.length ? grid(items, albumCard)
      : `<div class="empty">${icon('disc', 48)}<h3>No ${label.toLowerCase()}</h3><p>${kind === 'singles' ? 'Singles and EPs you save will show up here.' : 'Add a music folder in Settings or download some from Discover.'}</p></div>`;
  };
  sel.onchange = () => { sort = sel.value; setPref('wg.albumSort', sort); load(); };
  view.querySelector('#flt').oninput = debounce(load, 200);
  await load();
}

export async function artists(view) {
  view.innerHTML = `<div class="page"><h1>Artists</h1>${tabs('artists')}
    <div class="row" style="margin-bottom:18px"><input class="input" id="flt" placeholder="Filter artists" style="max-width:280px"></div><div id="list"></div></div>`;
  bindCards(view);
  const load = async () => {
    const items = await api.get(`/api/artists?q=${encodeURIComponent(view.querySelector('#flt').value.trim())}`);
    view.querySelector('#list').innerHTML = items.length ? grid(items, artistCard)
      : `<div class="empty">${icon('mic', 48)}<h3>No artists</h3></div>`;
  };
  view.querySelector('#flt').oninput = debounce(load, 200);
  await load();
}

export async function songs(view) {
  let sort = pref('wg.songSort', 'artist');
  view.innerHTML = `<div class="page" style="padding-left:8px;padding-right:8px"><div style="padding:0 16px"><h1>Songs</h1>${tabs('songs')}
    <div class="row" style="margin-bottom:8px"><button class="play-big" id="playall" title="Play">${icon('play', 26)}</button>
    <button class="icon-btn" id="shuf" title="Shuffle play">${icon('shuffle', 24)}</button><span class="muted" id="count"></span></div></div>
    <div id="list"></div></div>`;
  let tracks = [];
  const load = async () => {
    tracks = await api.get(`/api/tracks?sort=${sort}`);
    view.querySelector('#count').textContent = `${tracks.length.toLocaleString()} songs • ${fmtLong(tracks.reduce((s, t) => s + (t.duration || 0), 0))}`;
    trackTable(view.querySelector('#list'), tracks, { sortable: true, context: { type: 'songs', name: 'Songs' },
      onSort: (k) => { sort = k === 'added' ? 'added' : k; setPref('wg.songSort', sort); load(); } });
  };
  await load();
  view.querySelector('#playall').onclick = () => player.playList(tracks, 0, { context: { type: 'songs', name: 'Songs' }, shuffle: false });
  view.querySelector('#shuf').onclick = () => player.playList(tracks, 0, { context: { type: 'songs', name: 'Songs' }, shuffle: true });
}

export async function liked(view) {
  const tracks = await api.get('/api/tracks?liked=true&sort=added');
  view.innerHTML = `<div class="hero" style="--hero-rgb: 80, 56, 220">
      <div class="hero-art ph" style="background:linear-gradient(135deg,#4b2bd6,#8ab4f8);color:#fff;display:grid;place-items:center">${icon('heartFill', 90)}</div>
      <div class="hero-info"><div class="hero-kind">Playlist</div><h1>Liked Songs</h1>
      <div class="hero-meta"><b>${tracks.length} songs</b><span class="sep"></span><span>${fmtLong(tracks.reduce((s, t) => s + (t.duration || 0), 0))}</span></div></div></div>
    <div class="actions"><button class="play-big" id="playall">${icon('play', 26)}</button>
      <button class="icon-btn" id="shuf" title="Shuffle play">${icon('shuffle', 26)}</button></div>
    <div id="list"></div>`;
  const ctx = { type: 'liked', name: 'Liked Songs' };
  if (!tracks.length) {
    view.querySelector('#list').innerHTML = `<div class="empty">${icon('heart', 48)}<h3>Songs you like will appear here</h3><p>Save songs by tapping the heart.</p></div>`;
  } else trackTable(view.querySelector('#list'), tracks, { context: ctx });
  view.querySelector('#playall').onclick = () => player.playList(tracks, 0, { context: ctx, shuffle: false });
  view.querySelector('#shuf').onclick = () => player.playList(tracks, 0, { context: ctx, shuffle: true });
}

