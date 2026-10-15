import { api, img } from '../api.js';
import { albumCard, bindCards, grid } from '../components.js';
import { player } from '../player.js';
import { store } from '../store.js';
import { esc, icon } from '../ui.js';

export async function home(view) {
  const h = new Date().getHours();
  const greet = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  view.innerHTML = `<div class="page"><h1>${greet}</h1>
    <div id="quick" class="quick"></div>
    <div id="h-recent"></div><div id="h-added"></div><div id="h-new"></div><div id="h-charts"></div></div>`;
  bindCards(view);
  const page = view.firstElementChild;

  const [recent, albums, history] = await Promise.all([
    api.get('/api/recent-albums?limit=12'), api.get('/api/albums?sort=added'), api.get('/api/history?limit=30')]);

  if (!albums.length) {
    page.querySelector('#quick').innerHTML = `<div class="empty">${icon('folder', 48)}<h3>Your library is empty</h3>
      <p>Add your music folder (or external drive) in Settings, or find albums to download in Discover.</p>
      <div class="row" style="justify-content:center;margin-top:14px"><a class="btn primary" href="#/settings">${icon('folder', 16)} Add music folder</a>
      <a class="btn" href="#/discover">${icon('compass', 16)} Discover music</a></div></div>`;
  } else {
    // quick-pick tiles: liked songs + most recent albums (Spotify home style)
    const tiles = [{ href: '#/liked', title: 'Liked Songs', liked: true }, ...(recent.length ? recent : albums).slice(0, 7)
      .map((a) => ({ href: `#/album/${a.id}`, title: a.title, cover: a.cover, id: a.id }))];
    page.querySelector('#quick').innerHTML = `<div class="tiles">${tiles.map((t) => `
      <a class="tile" href="${t.href}">${t.liked ? `<span class="pl-thumb liked">${icon('heartFill', 22)}</span>` : `<img src="${esc(t.cover)}" alt="" onerror="this.style.visibility='hidden'">`}
      <b>${esc(t.title)}</b>${t.id ? `<button class="tile-play" data-play-album="${esc(t.id)}">${icon('play', 18)}</button>` : ''}</a>`).join('')}</div>`;
  }
  if (recent.length) {
    page.querySelector('#h-recent').innerHTML = `<div class="section"><div class="section-head"><h2>Jump back in</h2></div>${grid(recent, albumCard, true)}</div>`;
  }
  if (albums.length) {
    page.querySelector('#h-added').innerHTML = `<div class="section"><div class="section-head"><h2>Recently added</h2><a href="#/library/albums">Show all</a></div>${grid(albums.slice(0, 14), albumCard, true)}</div>`;
  }
  if (!store.settings.online) return;
  // online sections load after the local ones so home is instant offline
  api.get('/api/online/new-for-you').then((items) => {
    if (!items.length || !view.contains(page)) return;
    page.querySelector('#h-new').innerHTML = `<div class="section"><div class="section-head"><h2>New from artists you have <small>${icon('cloud', 13)} online</small></h2></div>${grid(items, albumCard, true)}</div>`;
  }).catch(() => {});
  api.get('/api/online/charts').then((c) => {
    if (!view.contains(page)) return;
    page.querySelector('#h-charts').innerHTML = `<div class="section"><div class="section-head"><h2>Trending albums <small>${icon('cloud', 13)} online</small></h2><a href="#/discover">Discover more</a></div>${grid(c.albums, albumCard, true)}</div>`;
  }).catch(() => {});
}
