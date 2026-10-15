// Shared renderers: cards, track tables (virtualised), menus, download actions.
import { api, img } from './api.js';
import { player } from './player.js';
import { go, refreshPlaylists, store } from './store.js';
import { dominantColor, esc, fmtTime, icon, menu, modal, prompt, safeHl, toast } from './ui.js';

// ------------------------------------------------------------ cards
const ph = (name) => `<div class="ph">${icon(name, 44)}</div>`;

export function albumCard(a) {
  const remote = a.source === 'deezer';
  const href = remote ? (a.saved && a.local_id ? `#/album/${a.local_id}` : `#/online/album/${a.id}`) : `#/album/${a.id}`;
  const cover = remote ? img(a.cover_small || a.cover) : a.cover;
  const tag = remote ? (a.saved ? `<span class="tag-saved">${icon('check', 12)}Saved</span>`
    : `<span class="tag-cloud">${icon('cloud', 13)}Not saved</span>`) : '';
  const sub = remote ? `${a.year ? esc(a.year) + ' • ' : ''}${esc(a.artist)}` : `${a.year ? esc(a.year) + ' • ' : ''}${esc(a.artist)}`;
  const fab = remote && !a.saved
    ? `<button class="play-fab" data-dl-album="${esc(a.id)}" title="Download album">${icon('download', 22)}</button>`
    : `<button class="play-fab" data-play-album="${esc(remote ? a.local_id : a.id)}" title="Play">${icon('play', 24)}</button>`;
  return `<div class="card ${remote && !a.saved ? 'remote' : ''}" data-href="${href}">
    <div class="card-art">${cover ? `<img loading="lazy" src="${esc(cover)}" alt="" onerror="this.remove()">` : ''}${ph('disc')}${tag}${fab}</div>
    <div class="card-title" title="${esc(a.title)}">${esc(a.title)}</div>
    <div class="card-sub">${remote && a.type && a.type !== 'album' ? `<span style="text-transform:capitalize">${esc(a.type)}</span> • ` : ''}${sub}</div></div>`;
}

export function artistCard(a) {
  const remote = a.source === 'deezer';
  const href = remote ? (a.saved && a.local_id ? `#/artist/${a.local_id}` : `#/online/artist/${a.id}`) : `#/artist/${a.id}`;
  const cover = remote ? img(a.image_small || a.image) : (a.cover?.startsWith('http') ? img(a.cover) : a.cover);
  const sub = remote ? (a.saved ? 'In your library' : 'Artist') : `${a.album_count} album${a.album_count === 1 ? '' : 's'} • ${a.track_count} songs`;
  return `<div class="card ${remote && !a.saved ? 'remote' : ''}" data-href="${href}">
    <div class="card-art round">${cover ? `<img loading="lazy" src="${esc(cover)}" alt="" onerror="this.remove()">` : ''}${ph('mic')}</div>
    <div class="card-title">${esc(a.name)}</div><div class="card-sub">${esc(sub)}</div></div>`;
}

export function grid(items, card, scroller = false) {
  return `<div class="grid ${scroller ? 'scroller' : ''}">${items.map(card).join('')}</div>`;
}

// delegated handlers for cards anywhere in a view
export function bindCards(root) {
  root.addEventListener('click', async (e) => {
    const dl = e.target.closest('[data-dl-album]');
    if (dl) { e.preventDefault(); e.stopPropagation(); downloadAlbum(dl.dataset.dlAlbum); return; }
    const pa = e.target.closest('[data-play-album]');
    if (pa) {
      e.preventDefault();
      e.stopPropagation();
      const a = await api.get(`/api/albums/${pa.dataset.playAlbum}`);
      player.playList(a.tracks, 0, { context: { type: 'album', id: a.id, name: a.title } });
      return;
    }
    const c = e.target.closest('[data-href]');
    if (c && !e.target.closest('a,button')) location.hash = c.dataset.href;
  });
}

// ------------------------------------------------------------ downloads
export async function downloadAlbum(id, all = false) {
  try {
    const r = await api.post(`/api/downloads/album/${id}${all ? '?all_tracks=true' : ''}`);
    toast(r.ids.length ? `${icon('download', 16)} Queued ${r.ids.length} track${r.ids.length === 1 ? '' : 's'}` : 'Already saved or queued');
  } catch (e) { toast(esc(e.message), 'error'); }
}

export async function downloadTrack(id) {
  try {
    const r = await api.post(`/api/downloads/track/${id}`);
    toast(r.ids.length ? 'Added to download queue' : 'Already in the queue');
  } catch (e) { toast(esc(e.message), 'error'); }
}

// ------------------------------------------------------------ track table
// is this catalog track already waiting in the download queue?
export function queuedState(catalogId) {
  const it = (store.queue.items || []).find((x) => x.catalog_id === String(catalogId) && x.status !== 'cancelled');
  if (!it) return null;
  return { queued: 'Queued', paused: 'On hold', downloading: 'Downloading', processing: 'Downloading', done: 'Saved', error: 'Failed' }[it.status];
}

function ago(ts) {
  if (!ts) return '';
  const d = (Date.now() / 1000 - ts) / 86400;
  if (d < 1) return 'Today';
  if (d < 2) return 'Yesterday';
  if (d < 30) return `${Math.floor(d)} days ago`;
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function trackTable(el, tracks, opts = {}) {
  const o = { cover: true, album: true, number: 'index', col4: 'added', context: null, sortable: false, ...opts };
  const remote = (t) => t.source === 'deezer';
  const nowId = () => player.current?.id;
  const isPlaying = (t) => (remote(t) ? t.local_id : t.id) === nowId();
  el.classList.add('tracks');
  el.classList.toggle('no-album', !o.album);
  const col4Label = { added: 'Date added', plays: 'Plays', status: '', year: 'Year' }[o.col4] ?? '';
  const sortBtn = (key, label) => o.sortable ? `<button data-sort="${key}">${label}</button>` : label;

  const row = (t, i) => {
    const r = remote(t);
    const playing = isPlaying(t);
    const num = playing && !player.paused ? `<span class="eq-anim"><i></i><i></i><i></i></span>`
      : (o.number === 'track' ? (t.track_no || i + 1) : i + 1);
    const q = r && !t.saved && queuedState(t.id);
    const badges = (r ? (t.saved ? `<span class="badge-sm saved">${icon('check', 10)}Saved</span>`
      : q ? `<span class="badge-sm queued">${icon('download', 11)}${q}</span>` : `<span class="badge-sm cloud">${icon('cloud', 11)}Not saved</span>`) : '')
      + (t.explicit ? '<span class="badge-sm e">E</span>' : '')
      + (!r && t.lyrics_synced ? '<span class="badge-sm lyr" title="Synced lyrics">LRC</span>' : '');
    const artistLink = r ? `<a href="#/online/artist/${esc(t.artist_id)}">${esc(t.artist)}</a>` : `<a href="#/artist/${esc(t.artist_id)}">${esc(t.artist)}</a>`;
    const albumLink = r ? `<a href="#/online/album/${esc(t.album_id)}">${esc(t.album)}</a>` : `<a href="#/album/${esc(t.album_id)}">${esc(t.album)}</a>`;
    const cover = r ? img(t.cover_small || t.cover) : t.cover;
    let col4 = '';
    if (o.col4 === 'added') col4 = ago(t.added_at);
    else if (o.col4 === 'plays') col4 = t.play_count ? `${t.play_count} plays` : '';
    else if (o.col4 === 'year') col4 = t.year || '';
    const liked = !r && t.liked_at > 0;
    const act = r && !t.saved
      ? `<button class="icon-btn show" data-act="dl" title="Download">${icon('download', 18)}</button>`
      : `<button class="icon-btn" data-act="more" title="More">${icon('more', 18)}</button>`;
    const title = t.hl_title ? safeHl(t.hl_title) : esc(t.title);
    return `<div class="trow ${playing ? 'playing' : ''} ${r && !t.saved ? 'remote' : ''}" data-i="${i}">
      <div class="c-num"><span class="n">${num}</span><span class="pb" data-act="play">${icon('play', 16)}</span></div>
      <div class="c-main">${o.cover ? (cover ? `<img loading="lazy" src="${esc(cover)}" alt="">` : '<div class="thumb-ph"></div>') : ''}
        <div class="tt"><span class="t-title">${title}${badges}</span><span class="t-sub">${artistLink}</span></div></div>
      <div class="c-album">${albumLink}</div>
      <div class="c-added">${esc(col4)}</div>
      <div class="c-dur">${r ? '' : `<button class="like ${liked ? 'liked' : ''}" data-act="like" title="${liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}">${icon(liked ? 'heartFill' : 'heart', 16)}</button>`}${fmtTime(t.duration)}</div>
      <div class="c-act">${act}</div></div>`;
  };

  el.innerHTML = `<div class="thead"><div style="text-align:right">#</div><div>${sortBtn('title', 'Title')}</div>
    <div class="c-album">${o.album ? sortBtn('album', 'Album') : ''}</div><div>${sortBtn(o.col4, col4Label)}</div>
    <div style="text-align:right">${sortBtn('duration', icon('clock', 16))}</div><div></div></div><div class="tbody"></div>`;
  const body = el.querySelector('.tbody');
  let v = null;
  const render = () => {
    if (tracks.length > 150) {
      body.className = 'tbody vlist';
      v = virtualRows(body, tracks, row);
    } else {
      body.innerHTML = tracks.map(row).join('');
    }
  };
  render();

  const local = () => tracks.filter((t) => !remote(t));
  async function play(i) {
    const t = tracks[i];
    if (remote(t)) {
      if (!t.saved) { downloadTrack(t.id); return; }
      // play the saved local copies of everything in this list
      const saved = tracks.filter((x) => x.saved && x.local_id);
      const full = await Promise.all(saved.map((x) => api.get(`/api/tracks/${x.local_id}`)));
      player.playList(full, saved.indexOf(t), { context: o.context });
      return;
    }
    const l = local();
    if (o.onPlay) return o.onPlay(t, i);
    player.playList(l, l.indexOf(t), { context: o.context });
  }

  el.addEventListener('click', (e) => {
    const sb = e.target.closest('[data-sort]');
    if (sb) { o.onSort?.(sb.dataset.sort); return; }
    const r = e.target.closest('.trow');
    if (!r) return;
    const i = +r.dataset.i, t = tracks[i];
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'play') return play(i);
    if (act === 'dl') return downloadTrack(t.id);
    if (act === 'like') return toggleLike(t, () => (v ? v.refresh() : render()));
    if (act === 'more') return trackMenu(e, t, o);
    if (e.target.closest('a')) return;
    el.querySelectorAll('.trow.selected').forEach((x) => x.classList.remove('selected'));
    r.classList.add('selected');
  });
  el.addEventListener('dblclick', (e) => {
    const r = e.target.closest('.trow');
    if (r && !e.target.closest('a,button')) play(+r.dataset.i);
  });
  el.addEventListener('contextmenu', (e) => {
    const r = e.target.closest('.trow');
    if (r) trackMenu(e, tracks[+r.dataset.i], o);
  });
  const onTrack = () => (v ? v.refresh() : render());
  player.addEventListener('track', onTrack);
  player.addEventListener('state', onTrack);
  // detach when the view is replaced
  const mo = new MutationObserver(() => {
    if (!el.isConnected) { player.removeEventListener('track', onTrack); player.removeEventListener('state', onTrack); mo.disconnect(); }
  });
  mo.observe(document.getElementById('view'), { childList: true });
  return { play };
}

function virtualRows(listEl, items, renderRow, rowH = 56) {
  const scroller = document.getElementById('view');
  listEl.style.height = items.length * rowH + 'px';
  let ls = -1, le = -1;
  function update() {
    if (!listEl.isConnected) { scroller.removeEventListener('scroll', update); return; }
    const top = listEl.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const h = scroller.clientHeight;
    const s = Math.max(0, Math.floor(-top / rowH) - 12);
    const e = Math.min(items.length, Math.ceil((h - top) / rowH) + 12);
    if (s === ls && e === le) return;
    ls = s; le = e;
    let html = '';
    for (let i = s; i < e; i++) html += renderRow(items[i], i).replace('<div class="trow', `<div style="top:${i * rowH}px" class="trow`);
    listEl.innerHTML = html;
  }
  scroller.addEventListener('scroll', update, { passive: true });
  requestAnimationFrame(update);
  update();
  return { refresh() { ls = -1; update(); } };
}

export async function toggleLike(t, after) {
  const liked = !(t.liked_at > 0);
  await api.post(`/api/tracks/${t.id}/like`, { liked });
  t.liked_at = liked ? Date.now() / 1000 : 0;
  if (player.current?.id === t.id) { player.current.liked_at = t.liked_at; player._emit('track'); }
  toast(liked ? `${icon('heartFill', 16)} Added to Liked Songs` : 'Removed from Liked Songs');
  after?.();
}

export function trackMenu(e, t, o = {}) {
  if (t.source === 'deezer') {
    return menu(e, [
      !t.saved && { label: 'Download', icon: 'download', action: () => downloadTrack(t.id) },
      t.saved && t.local_id && { label: 'Play', icon: 'play', action: async () => player.playList([await api.get(`/api/tracks/${t.local_id}`)]) },
      { label: 'Go to album', icon: 'disc', action: () => go(`/online/album/${t.album_id}`) },
      { label: 'Go to artist', icon: 'mic', action: () => go(`/online/artist/${t.artist_id}`) },
      { label: 'Download whole album', icon: 'download', action: () => downloadAlbum(t.album_id) },
    ]);
  }
  menu(e, [
    { label: 'Play next', icon: 'queue', action: () => { player.playNext([t]); toast('Playing next'); } },
    { label: 'Add to queue', icon: 'queue', action: () => { player.addToQueue([t]); toast('Added to queue'); } },
    '-',
    { label: t.liked_at > 0 ? 'Remove from Liked Songs' : 'Save to Liked Songs', icon: 'heart', action: () => toggleLike(t) },
    { label: 'Add to playlist…', icon: 'playlist', action: () => addToPlaylistDialog([t.id]) },
    o.playlistId && { label: 'Remove from this playlist', icon: 'trash', action: () => o.onRemove?.(t) },
    '-',
    { label: 'Go to album', icon: 'disc', action: () => go(`/album/${t.album_id}`) },
    { label: 'Go to artist', icon: 'mic', action: () => go(`/artist/${t.artist_id}`) },
    { label: t.has_lyrics ? 'Re-fetch lyrics' : 'Find lyrics online', icon: 'lyrics', action: async () => {
      toast('Looking for lyrics…');
      const r = await api.post(`/api/tracks/${t.id}/lyrics/fetch`).catch(() => ({ ok: false }));
      toast(r.ok ? 'Lyrics saved' : 'No lyrics found', r.ok ? '' : 'error');
    } },
    { label: 'Song info', icon: 'music', action: () => songInfo(t.id) },
  ]);
}

async function songInfo(id) {
  const t = await api.get(`/api/tracks/${id}`);
  const rows = [['Title', t.title], ['Artist', t.artist], ['Album', t.album], ['Album artist', t.album_artist], ['Genre', t.genre],
    ['Year', t.year], ['Track', t.track_no], ['Disc', t.disc_no], ['Duration', fmtTime(t.duration)],
    ['Format', `${(t.format || '').toUpperCase()}${t.bitrate ? ` • ${Math.round(t.bitrate / 1000)} kbps` : ''}${t.sample_rate ? ` • ${(t.sample_rate / 1000).toFixed(1)} kHz` : ''}`],
    ['Plays', t.play_count], ['File', t.path]];
  modal(`<h3>Song info</h3><div>${rows.filter((r) => r[1]).map(([k, v]) =>
    `<div class="set-row" style="padding:8px 0"><div class="lbl"><span>${k}</span></div><div style="max-width:70%;text-align:right;overflow-wrap:anywhere">${esc(v)}</div></div>`).join('')}</div>
    <div class="row end"><button class="btn primary" data-close>Close</button></div>`);
}

export function addToPlaylistDialog(trackIds) {
  const list = store.playlists;
  modal(`<h3>Add to playlist</h3>
    <button class="btn primary" id="np-new" style="margin-bottom:10px">${icon('plus', 16)} New playlist</button>
    <div class="browse-list">${list.map((p) => `<button data-pid="${p.id}">${icon('playlist', 18)} ${esc(p.name)} <span class="faint">· ${p.track_count}</span></button>`).join('') || '<div class="muted">No playlists yet</div>'}</div>
    <div class="row end"><button class="btn ghost" data-close>Cancel</button></div>`, (card, close) => {
    card.querySelector('#np-new').onclick = async () => {
      close();
      const name = await prompt('New playlist', 'My playlist');
      if (!name) return;
      await api.post('/api/playlists', { name, track_ids: trackIds });
      await refreshPlaylists();
      toast(`Created “${esc(name)}”`);
    };
    card.querySelectorAll('[data-pid]').forEach((b) => (b.onclick = async () => {
      close();
      await api.patch(`/api/playlists/${b.dataset.pid}`, { add: trackIds });
      await refreshPlaylists();
      toast('Added to playlist');
    }));
  });
}

export function heroColor(el, src) {
  dominantColor(src).then((c) => { if (c) el.style.setProperty('--hero-rgb', c.join(',')); });
}
