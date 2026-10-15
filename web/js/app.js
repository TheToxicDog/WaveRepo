// App shell: sidebar, router, top bar, player bar, live events.
import { api, connectEvents, img, on } from './api.js';
import { addToPlaylistDialog, toggleLike } from './components.js';
import { setAccent, setFx } from './fx.js';
import { initPanel, refreshLyricsTargets, showTab } from './panel.js';
import { player } from './player.js';
import { go, refreshPlaylists, store } from './store.js';
import { cssRgb } from './themes.js';
import { debounce, dominantColor, esc, fmtTime, icon, prompt, toast } from './ui.js';
import { localAlbum, onlineAlbum } from './views/album.js';
import { localArtist, onlineArtist } from './views/artist.js';
import { discover } from './views/discover.js';
import { downloads } from './views/downloads.js';
import { home } from './views/home.js';
import { albums, artists, liked, songs } from './views/library.js';
import { playlist } from './views/playlist.js';
import { search } from './views/search.js';
import { settingsView } from './views/settings.js';
import { videos } from './views/videos.js';

const $ = (s) => document.querySelector(s);
const view = $('#view');

// ------------------------------------------------------------ sidebar
function renderNav() {
  const r = currentRoute();
  const dl = (store.queue.items || []).filter((x) => ['queued', 'downloading', 'processing'].includes(x.status)).length;
  const link = (route, ic, label, extra = '') =>
    `<a href="#/${route}" class="${r === route || (route && r.startsWith(route + '/')) ? 'active' : ''}">${icon(ic, 22)}<span>${label}</span>${extra}</a>`;
  $('#nav-main').innerHTML = link('', 'home', 'Home') + link('search', 'search', 'Search') + link('discover', 'compass', 'Discover')
    + link('downloads', 'download', 'Downloads', dl ? `<span class="badge">${dl}</span>` : '');
  $('#nav-lib').innerHTML = link('library/albums', 'disc', 'Albums') + link('library/singles', 'disc', 'Singles & EPs') + link('library/artists', 'mic', 'Artists') + link('library/songs', 'music', 'Songs')
    + link('videos', 'playCircle', 'Music videos');
  $('#nav-settings').innerHTML = `${icon('settings', 22)}<span>Settings</span>`;
  $('#nav-settings').classList.toggle('active', r === 'settings');
  $('#new-playlist').innerHTML = icon('plus', 18);
  renderPlaylists();
}

function renderPlaylists() {
  const r = currentRoute();
  const likedCount = store.stats.liked || 0;
  $('#playlists').innerHTML = `<a class="pl-item ${r === 'liked' ? 'active' : ''}" href="#/liked"><span class="pl-thumb liked">${icon('heartFill', 16)}</span>
    <span class="pl-meta"><b>Liked Songs</b><span>Playlist • ${likedCount} songs</span></span></a>` +
    store.playlists.map((p) => `<a class="pl-item ${r === `playlist/${p.id}` ? 'active' : ''}" href="#/playlist/${p.id}">
      <span class="pl-thumb ${p.covers.length < 4 ? 'single' : ''}">${p.covers.length ? (p.covers.length >= 4 ? p.covers : p.covers.slice(0, 1)).map((c) => `<img src="${esc(c)}" alt="">`).join('') : icon('playlist', 18)}</span>
      <span class="pl-meta"><b>${esc(p.name)}</b><span>Playlist • ${p.track_count} songs</span></span></a>`).join('');
}

function renderDrives() {
  const roots = store.stats.roots || [];
  const s = store.stats.scan || {};
  $('#drives').innerHTML = roots.slice(0, 3).map((r) => `<div class="drive" title="${esc(r.path)}"><i class="dot ${r.online ? 'on' : ''}"></i><span>${esc(r.path)}</span></div>`).join('')
    + (s.running ? `<div class="drive">${icon('refresh', 14, 'spin')}<span>Scanning ${s.done}/${s.total}</span></div>` : '');
  $('#top-status').innerHTML = s.running ? `<span class="pill">${icon('refresh', 14, 'spin')} Scanning library ${s.total ? Math.round((s.done / s.total) * 100) : 0}%</span>` : '';
}

async function refreshStats() {
  store.stats = await api.get('/api/stats');
  renderDrives();
  renderPlaylists();
}

// ------------------------------------------------------------ router
function currentRoute() { return location.hash.replace(/^#\/?/, '').split('?')[0]; }

const history = { stack: [], idx: -1 };
let navigating = false;

async function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [path, qs] = hash.split('?');
  const params = new URLSearchParams(qs || '');
  const parts = path.split('/');
  if (!navigating) { history.stack = history.stack.slice(0, history.idx + 1); history.stack.push(hash); history.idx = history.stack.length - 1; }
  navigating = false;
  $('#back').disabled = history.idx <= 0;
  $('#fwd').disabled = history.idx >= history.stack.length - 1;
  renderNav();
  if (parts[0] !== 'search') { view.scrollTop = 0; $('#q').value = ''; }
  try {
    switch (parts[0]) {
      case '': await home(view); break;
      case 'search': await search(view, params); break;
      case 'discover': await discover(view, params); break;
      case 'downloads': await downloads(view); break;
      case 'library':
        if (parts[1] === 'artists') await artists(view);
        else if (parts[1] === 'singles') await albums(view, 'singles');
        else if (parts[1] === 'songs') await songs(view);
        else await albums(view);
        break;
      case 'liked': await liked(view); break;
      case 'album': await localAlbum(view, parts[1]); break;
      case 'artist': await localArtist(view, parts[1]); break;
      case 'online': parts[1] === 'artist' ? await onlineArtist(view, parts[2]) : await onlineAlbum(view, parts[2]); break;
      case 'playlist': await playlist(view, parts[1]); break;
      case 'settings': await settingsView(view); break;
      case 'videos': await videos(view); break;
      default: await home(view);
    }
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="page"><div class="empty">${icon(e.offline ? 'cloud' : 'alert', 48)}<h3>${e.offline ? 'You’re offline' : 'Something went wrong'}</h3><p>${esc(e.message)}</p></div></div>`;
  }
}

$('#back').innerHTML = icon('left', 22);
$('#fwd').innerHTML = icon('right', 22);
$('#back').onclick = () => { if (history.idx > 0) { navigating = true; history.idx--; location.hash = '#/' + history.stack[history.idx]; } };
$('#fwd').onclick = () => { if (history.idx < history.stack.length - 1) { navigating = true; history.idx++; location.hash = '#/' + history.stack[history.idx]; } };
view.addEventListener('scroll', () => $('#topbar').classList.toggle('solid', view.scrollTop > 40), { passive: true });

// search box: live results as you type
$('#search-ic').innerHTML = icon('search', 18);
const doSearch = debounce((q) => {
  const target = `#/search?q=${encodeURIComponent(q)}`;
  if (currentRoute() === 'search') { history.stack[history.idx] = target.slice(2); navigating = true; location.replace(target); }
  else location.hash = target;
}, 220);
$('#q').addEventListener('input', (e) => doSearch(e.target.value));
$('#q').addEventListener('focus', () => { if (currentRoute() !== 'search' && $('#q').value) doSearch($('#q').value); });

$('#new-playlist').onclick = async () => {
  const name = await prompt('New playlist', `My Playlist #${store.playlists.length + 1}`);
  if (!name) return;
  const r = await api.post('/api/playlists', { name });
  await refreshPlaylists();
  go(`/playlist/${r.id}`);
};

// ------------------------------------------------------------ player bar
const seekEl = $('#p-seek');
let seeking = false;

function renderNow() {
  const t = player.current;
  const liked = t && t.liked_at > 0;
  $('#p-now').innerHTML = t ? `<img src="${esc(t.cover)}" alt="" id="p-cover" title="Full-screen lyrics" onerror="this.style.visibility='hidden'">
    <div class="tt"><a class="t-title" href="#/album/${esc(t.album_id)}">${esc(t.title)}</a><a class="t-sub muted" href="#/artist/${esc(t.artist_id)}">${esc(t.artist)}</a></div>
    <button class="icon-btn ${liked ? 'liked' : ''}" id="p-like" title="${liked ? 'Remove from' : 'Save to'} Liked Songs">${icon(liked ? 'heartFill' : 'heart', 18)}</button>` : '';
  $('#p-like')?.addEventListener('click', () => toggleLike(player.current, () => { renderNow(); refreshStats(); }));
  $('#p-cover')?.addEventListener('click', openNowPlaying);
  if (t && store.settings.adaptive_color !== false) {
    dominantColor(t.cover).then((c) => {
      if (!c) return;
      document.body.style.setProperty('--album-rgb', c.join(','));
      setAccent(c, cssRgb('--accent2-rgb'));
    });
  }
}

function renderCtrls() {
  const rep = player.repeat;
  $('#p-ctrls').innerHTML = `
    <button class="icon-btn ${player.shuffleOn ? 'on' : ''}" id="c-shuf" title="Shuffle (${{ fewer_repeats: 'Fewer repeats', balanced: 'Balanced', standard: 'Standard' }[player.shuffleMode]}) — right-click to change">${icon('shuffle', 18)}</button>
    <button class="icon-btn" id="c-prev" title="Previous">${icon('prev', 20)}</button>
    <button class="p-play" id="c-play" title="Play / pause (Space)">${icon(player.paused ? 'play' : 'pause', 22)}</button>
    <button class="icon-btn" id="c-next" title="Next">${icon('next', 20)}</button>
    <button class="icon-btn ${rep !== 'off' ? 'on' : ''}" id="c-rep" title="Repeat: ${rep}">${icon('repeat', 18)}${rep === 'one' ? '<span class="repeat-one">1</span>' : ''}</button>`;
  $('#c-shuf').onclick = () => player.toggleShuffle();
  $('#c-shuf').oncontextmenu = (e) => import('./ui.js').then(({ menu }) => menu(e, [
    ['fewer_repeats', 'Fewer repeats (default)'], ['balanced', 'Balanced artist spread'], ['standard', 'Standard random']]
    .map(([m, l]) => ({ label: (player.shuffleMode === m ? '✓ ' : '   ') + l, action: () => { player.setShuffleMode(m); toast(`Shuffle: ${l}`); } }))));
  $('#c-prev').onclick = () => player.prev();
  $('#c-play').onclick = () => player.toggle();
  $('#c-next').onclick = () => player.next();
  $('#c-rep').onclick = () => player.cycleRepeat();
}

function renderRight() {
  const v = player.muted ? 0 : player.volume;
  $('#p-right').innerHTML = `
    <button class="icon-btn" id="r-lyr" title="Lyrics">${icon('lyrics', 18)}</button>
    <button class="icon-btn" id="r-queue" title="Queue">${icon('queue', 18)}</button>
    <button class="icon-btn" id="r-eq" title="Equalizer">${icon('eq', 18)}</button>
    <button class="icon-btn" id="r-mute" title="Mute">${icon(v === 0 ? 'mute' : v < 0.5 ? 'volumeLow' : 'volume', 18)}</button>
    <div class="slider" id="vol" style="--v:${v * 100}%"><i></i><b></b></div>
    <button class="icon-btn" id="r-full" title="Full-screen lyrics">${icon('expand', 18)}</button>`;
  const panelToggle = (t) => () => {
    const app = $('#app');
    if (!app.classList.contains('panel-closed') && localStorage.getItem('wg.panelTab') === t) app.classList.add('panel-closed');
    else showTab(t);
  };
  $('#r-lyr').onclick = panelToggle('lyrics');
  $('#r-queue').onclick = panelToggle('queue');
  $('#r-eq').onclick = panelToggle('eq');
  $('#r-mute').onclick = () => player.toggleMute();
  $('#r-full').onclick = openNowPlaying;
  slider($('#vol'), (f) => player.setVolume(f));
}

function slider(el, onChange, onEnd) {
  const set = (e) => {
    const r = el.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    el.style.setProperty('--v', f * 100 + '%');
    onChange(f, false);
    return f;
  };
  el.onpointerdown = (e) => {
    el.setPointerCapture(e.pointerId);
    el.classList.add('drag');
    set(e);
    el.onpointermove = set;
    el.onpointerup = (ev) => { const f = set(ev); el.classList.remove('drag'); el.onpointermove = null; onEnd?.(f); };
  };
}

slider(seekEl, (f) => { seeking = true; $('#p-cur').textContent = fmtTime(f * player.duration); },
  (f) => { seeking = false; player.seek(f * player.duration); });

function renderTime() {
  if (seeking) return;
  const d = player.duration, t = player.time;
  $('#p-cur').textContent = fmtTime(t);
  $('#p-dur').textContent = fmtTime(d);
  seekEl.style.setProperty('--v', d ? `${(t / d) * 100}%` : '0%');
  const ns = document.getElementById('np-seek');
  if (ns) {
    ns.style.setProperty('--v', d ? `${(t / d) * 100}%` : '0%');
    $('#np-cur').textContent = fmtTime(t);
    $('#np-dur').textContent = fmtTime(d);
  }
}

player.addEventListener('track', () => { renderNow(); renderTime(); });
player.addEventListener('state', () => {
  renderCtrls();
  const b = document.getElementById('np-play');
  if (b) b.innerHTML = icon(player.paused ? 'play' : 'pause', 28);
});
player.addEventListener('mode', renderCtrls);
player.addEventListener('time', renderTime);
player.addEventListener('volume', renderRight);
player.addEventListener('error', (e) => toast(`Can't play “${esc(e.detail.track.title)}”: ${esc(e.detail.message)}`, 'error'));

// ------------------------------------------------------------ full-screen now playing
function openNowPlaying() {
  const t = player.current;
  if (!t) return;
  const np = $('#nowplaying');
  np.innerHTML = `<div class="np-bg" style="background-image:url('${esc(t.cover)}')"></div>
    <button class="round-btn np-close" id="np-close">${icon('x', 20)}</button>
    <div class="np-left"><img src="${esc(t.cover)}" alt=""><div><h2>${esc(t.title)}</h2><div class="muted" style="text-align:center;font-size:17px">${esc(t.artist)} • ${esc(t.album)}</div></div>
      <div class="np-ctrls"><div class="p-seek"><span id="np-cur">0:00</span><div class="slider" id="np-seek"><i></i><b></b></div><span id="np-dur">0:00</span></div>
        <div class="p-ctrls"><button class="icon-btn" id="np-prev">${icon('prev', 24)}</button><button class="p-play" id="np-play">${icon(player.paused ? 'play' : 'pause', 28)}</button><button class="icon-btn" id="np-next">${icon('next', 24)}</button></div></div></div>
    <div class="np-right lyrics-big"><div class="lyrics" id="np-lyr"></div></div>`;
  np.classList.add('open');
  $('#np-close').onclick = () => np.classList.remove('open');
  $('#np-prev').onclick = () => player.prev();
  $('#np-next').onclick = () => player.next();
  $('#np-play').onclick = () => player.toggle();
  slider($('#np-seek'), (f) => { seeking = true; $('#np-cur').textContent = fmtTime(f * player.duration); },
    (f) => { seeking = false; player.seek(f * player.duration); });
  renderTime();
  refreshLyricsTargets();
}
player.addEventListener('track', () => { if ($('#nowplaying').classList.contains('open')) openNowPlaying(); });

// ------------------------------------------------------------ keyboard
addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.code === 'Space') { e.preventDefault(); player.toggle(); }
  else if (e.key === 'ArrowRight' && e.shiftKey) player.next();
  else if (e.key === 'ArrowLeft' && e.shiftKey) player.prev();
  else if (e.key === 'ArrowRight') player.seek(player.time + 5);
  else if (e.key === 'ArrowLeft') player.seek(player.time - 5);
  else if (e.key === 'ArrowUp') { e.preventDefault(); player.setVolume(player.volume + 0.05); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); player.setVolume(player.volume - 0.05); }
  else if (e.key === '/' || (e.key === 'k' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); $('#q').focus(); }
  else if (e.key === 'l') showTab('lyrics');
  else if (e.key === 'Escape') $('#nowplaying').classList.remove('open');
});

// ------------------------------------------------------------ settings application
function applySettings() {
  const s = store.settings;
  document.body.dataset.theme = s.theme || 'midnight';
  if (!s.adaptive_color) document.body.style.removeProperty('--album-rgb');
  requestAnimationFrame(() => {
    setAccent(cssRgb('--accent-rgb'), cssRgb('--accent2-rgb'));
    if (s.adaptive_color && player.current) renderNow();
  });
  setFx(s.effects, s.effects_intensity);
}
document.addEventListener('settings', applySettings);
document.addEventListener('playlists', renderPlaylists);

// ------------------------------------------------------------ live server events
on('library', debounce(() => {
  refreshStats();
  const r = currentRoute();
  if (['', 'library/albums', 'library/artists', 'library/songs'].includes(r)) route();
}, 800));
on('scan', (s) => { store.stats.scan = s; renderDrives(); });
on('queue', (d) => { store.queue.items = d.items; renderNav(); });
on('liked', debounce(refreshStats, 300));

// ------------------------------------------------------------ boot
(async function boot() {
  store.settings = await api.get('/api/settings');
  applySettings();
  if (store.settings.eq_gains && !localStorage.getItem('wg.player')) player.setEq(store.settings.eq_gains);
  store.queue = await api.get('/api/downloads').catch(() => ({ items: [], paused: false }));
  await Promise.all([refreshStats(), refreshPlaylists()]);
  renderCtrls(); renderRight(); renderNow(); renderTime();
  initPanel();
  connectEvents();
  addEventListener('hashchange', route);
  route();
})();

