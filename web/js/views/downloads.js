import { api, img, on } from '../api.js';
import { store } from '../store.js';
import { esc, fmtBytes, icon, toast } from '../ui.js';

let dragging = false;
let current = null; // the mounted view element

const LABEL = { queued: 'Queued', downloading: 'Downloading', processing: 'Finishing', paused: 'Paused', done: 'Saved', error: 'Failed', cancelled: 'Cancelled' };

on('queue', (d) => {
  store.queue.items = d.items;
  if (current?.isConnected && !dragging) renderList(current);
});
on('queue_state', (d) => {
  store.queue.paused = d.paused;
  if (current?.isConnected) renderHead(current);
});
on('download', (d) => {
  const it = store.queue.items.find((x) => x.id === d.id);
  if (it) Object.assign(it, d);
  if (!current?.isConnected) return;
  const el = current.querySelector(`.dl-item[data-id="${d.id}"]`);
  if (!el || !it) return;
  if (d.status && el.dataset.status !== d.status) { if (!dragging) renderList(current); return; }
  el.querySelector('.progress i').style.width = `${Math.round((it.progress || 0) * 100)}%`;
  el.querySelector('.dl-state').innerHTML = stateLine(it);
  if (it.error && it.status === 'processing') el.querySelector('.dl-sub').textContent = it.error;
});

function stateLine(it) {
  const pct = `${Math.round((it.progress || 0) * 100)}%`;
  if (it.status === 'downloading') return `<span>${pct}</span><span>${it.speed ? fmtBytes(it.speed) + '/s' : ''}${it.eta ? ` • ${Math.round(it.eta)}s left` : ''}</span>`;
  if (it.status === 'processing') return `<span>${pct}</span><span>Tagging & lyrics…</span>`;
  return `<span>${LABEL[it.status] || it.status}</span><span></span>`;
}

export async function downloads(view) {
  current = view;
  const d = await api.get('/api/downloads');
  store.queue = d;
  view.innerHTML = `<div class="page"><h1>Downloads</h1>
    <div class="dl-head">
      <form class="dl-paste" id="paste"><input class="input" id="url" placeholder="Paste a YouTube, YouTube Music, SoundCloud or Spotify link…">
        <select class="input" id="mode" style="width:120px"><option value="audio">Audio</option><option value="video">Music video</option></select>
        <button class="btn primary" type="submit">${icon('plus', 16)} Add</button></form>
      <div id="head-ctrls" class="row"></div>
    </div>
    <div class="dl-stats" id="stats"></div>
    <div id="list"></div></div>`;
  view.querySelector('#paste').onsubmit = async (e) => {
    e.preventDefault();
    const url = view.querySelector('#url').value.trim();
    if (!url) return;
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const r = await api.post('/api/downloads/url', { url, mode: view.querySelector('#mode').value });
      toast(`Added ${r.ids.length} item${r.ids.length === 1 ? '' : 's'} to the queue`);
      view.querySelector('#url').value = '';
    } catch (err) { toast(esc(err.message), 'error'); }
    btn.disabled = false;
  };
  renderHead(view);
  renderList(view);
}

function renderHead(view) {
  const paused = store.queue.paused;
  view.querySelector('#head-ctrls').innerHTML = `
    <button class="btn" data-ctl="${paused ? 'resume' : 'pause'}">${icon(paused ? 'playCircle' : 'pauseCircle', 18)} ${paused ? 'Resume queue' : 'Pause queue'}</button>
    <button class="btn ghost" data-ctl="clear-finished">${icon('check', 16)} Clear finished</button>
    <button class="btn ghost" data-ctl="clear-failed">${icon('x', 16)} Clear failed</button>`;
  view.querySelector('#head-ctrls').onclick = async (e) => {
    const b = e.target.closest('[data-ctl]');
    if (!b) return;
    const r = await api.post(`/api/downloads-control/${b.dataset.ctl}`);
    store.queue.paused = r.paused;
    renderHead(view);
  };
}

function itemHtml(it, draggable) {
  const cover = it.cover_url ? img(it.cover_url) : '';
  const active = it.status === 'downloading' || it.status === 'processing';
  const sub = it.status === 'error' ? `<div class="dl-sub err">${icon('alert', 12)} ${esc(it.error)}</div>`
    : `<div class="dl-sub">${esc([it.artist, it.album].filter(Boolean).join(' • ') || it.source_url)}${it.kind === 'video' ? ' • music video' : it.kind === 'url' ? ' • from link' : ''}</div>`;
  const acts = [];
  if (['queued', 'paused'].includes(it.status)) acts.push(['top', 'top', 'Move to top']);
  if (it.status === 'queued') acts.push(['pause', 'pauseCircle', 'Hold']);
  if (it.status === 'paused') acts.push(['resume', 'playCircle', 'Resume']);
  if (['error', 'cancelled'].includes(it.status)) acts.push(['retry', 'refresh', 'Retry']);
  if (active) acts.push(['cancel', 'x', 'Cancel']);
  else acts.push(['remove', 'trash', 'Remove']);
  return `<div class="dl-item ${active ? 'active' : ''}" data-id="${it.id}" data-status="${it.status}" ${draggable ? 'draggable="true"' : ''}>
    <span class="grip ${draggable ? '' : 'disabled'}" title="Drag to reorder">${icon('drag', 18)}</span>
    ${cover ? `<img src="${esc(cover)}" alt="" loading="lazy">` : `<div class="thumb-ph"></div>`}
    <div style="min-width:0"><div class="dl-title">${esc(it.title)}</div>${sub}</div>
    <div class="dl-prog">${it.status === 'done' ? `<span class="status-chip done">${icon('check', 12)} Saved</span>` : it.status === 'error' ? '<span class="status-chip error">Failed</span>' :
    `<div class="progress ${it.status === 'processing' ? 'indet' : ''}"><i style="width:${Math.round((it.progress || 0) * 100)}%"></i></div><div class="dl-state">${stateLine(it)}</div>`}</div>
    <div class="dl-acts">${acts.map(([a, ic, t]) => `<button class="icon-btn" data-a="${a}" title="${t}">${icon(ic, 18)}</button>`).join('')}</div></div>`;
}

function renderList(view) {
  const items = store.queue.items;
  const by = (s) => items.filter((x) => s.includes(x.status));
  const active = by(['downloading', 'processing']), waiting = by(['queued', 'paused']), failed = by(['error', 'cancelled']), done = by(['done']);
  view.querySelector('#stats').innerHTML = [['Downloading', active.length], ['In queue', waiting.length], ['Saved', done.length], ['Failed', failed.length]]
    .map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('');
  const sec = (title, list, drag, extra = '') => list.length ? `<div class="section"><div class="section-head"><h2>${title} <small>${list.length}</small></h2>${extra}</div>
    <div class="dl-list" ${drag ? 'data-drag="1"' : ''}>${list.map((x) => itemHtml(x, drag)).join('')}</div></div>` : '';
  const html = sec('Now downloading', active, false) + sec('Up next', waiting, true, '<span class="muted" style="font-size:13px">Drag to reorder</span>')
    + sec('Failed', failed, false) + sec('Recently saved', done.slice(0, 100), false);
  view.querySelector('#list').innerHTML = html || `<div class="empty">${icon('download', 48)}<h3>No downloads yet</h3>
    <p>Find an album in Search or Discover and hit Download, or paste a link above.</p>
    <div class="row" style="justify-content:center;margin-top:12px"><a class="btn primary" href="#/discover">${icon('compass', 16)} Discover music</a></div></div>`;
  bindList(view);
}

function bindList(view) {
  const list = view.querySelector('#list');
  list.onclick = async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const id = b.closest('.dl-item').dataset.id;
    await api.post(`/api/downloads/${id}/${b.dataset.a}`);
  };
  const dl = list.querySelector('[data-drag]');
  if (!dl) return;
  let src = null;
  dl.addEventListener('dragstart', (e) => {
    src = e.target.closest('.dl-item');
    if (!src) return;
    dragging = true;
    src.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', src.dataset.id);
  });
  dl.addEventListener('dragover', (e) => {
    e.preventDefault();
    const over = e.target.closest('.dl-item');
    dl.querySelectorAll('.drop-before,.drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    if (!over || over === src) return;
    const r = over.getBoundingClientRect();
    over.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  });
  dl.addEventListener('drop', async (e) => {
    e.preventDefault();
    const over = e.target.closest('.dl-item');
    if (over && src && over !== src) {
      const before = over.classList.contains('drop-before');
      over.parentNode.insertBefore(src, before ? over : over.nextSibling);
    }
    const ids = [...dl.querySelectorAll('.dl-item')].map((x) => +x.dataset.id);
    cleanup();
    await api.post('/api/downloads/reorder', { ids });
  });
  const cleanup = () => {
    dragging = false;
    dl.querySelectorAll('.dragging,.drop-before,.drop-after').forEach((x) => x.classList.remove('dragging', 'drop-before', 'drop-after'));
  };
  dl.addEventListener('dragend', cleanup);
}
