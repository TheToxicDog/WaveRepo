import { api } from '../api.js';
import { albumCard, artistCard, bindCards, grid, trackTable } from '../components.js';
import { store } from '../store.js';
import { esc, icon } from '../ui.js';

export async function discover(view, params) {
  const genre = params.get('genre');
  view.innerHTML = `<div class="page"><h1>Discover</h1>
    <p class="muted" style="margin:-8px 0 18px">Browse music from the internet. Anything marked ${icon('cloud', 13).replace('class="ic', 'style="display:inline;vertical-align:-2px" class="ic')} <b>Not saved</b> can be downloaded straight into your library.</p>
    <div class="chips" id="gchips"></div><div id="body"><div class="muted">Loading…</div></div></div>`;
  bindCards(view);
  if (!store.settings.online) {
    view.querySelector('#body').innerHTML = `<div class="offline-note">${icon('cloud', 18)} Online features are off. Turn them on in Settings to discover new music.</div>`;
    return;
  }
  api.get('/api/online/genres').then((gs) => {
    view.querySelector('#gchips').innerHTML = `<a class="chip ${!genre ? 'active' : ''}" href="#/discover" style="display:inline-flex;align-items:center">For you</a>` +
      gs.map((g) => `<a class="chip ${genre == g.id ? 'active' : ''}" style="display:inline-flex;align-items:center" href="#/discover?genre=${g.id}&name=${encodeURIComponent(g.name)}">${esc(g.name)}</a>`).join('');
  }).catch(() => {});
  const body = view.querySelector('#body');
  try {
    if (genre) {
      const albums = await api.get(`/api/online/genre/${genre}`);
      body.innerHTML = `<div class="section"><div class="section-head"><h2>Top ${esc(params.get('name') || '')} albums</h2></div>${grid(albums, albumCard)}</div>`;
      return;
    }
    const [charts, fresh] = await Promise.all([api.get('/api/online/charts'), api.get('/api/online/new-for-you').catch(() => [])]);
    body.innerHTML = `
      ${fresh.length ? `<div class="section"><div class="section-head"><h2>New releases from your artists</h2></div>${grid(fresh, albumCard, true)}</div>` : ''}
      <div class="section"><div class="section-head"><h2>Trending albums</h2></div>${grid(charts.albums, albumCard)}</div>
      <div class="section"><div class="section-head"><h2>Trending songs</h2></div><div id="ct"></div></div>
      <div class="section"><div class="section-head"><h2>Popular artists</h2></div>${grid(charts.artists, artistCard, true)}</div>`;
    trackTable(body.querySelector('#ct'), charts.tracks, { col4: 'none' });
  } catch (e) {
    body.innerHTML = `<div class="offline-note">${icon('cloud', 18)} ${esc(e.message)}</div>`;
  }
}
