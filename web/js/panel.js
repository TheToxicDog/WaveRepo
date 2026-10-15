// Right panel: Queue / Lyrics / Equalizer, plus the full-screen lyrics view.
import { api, on } from './api.js';
import { EQ_FREQS, EQ_PRESETS, player } from './player.js';
import { saveSettings } from './store.js';
import { esc, fmtTime, icon, toast } from './ui.js';

const body = document.getElementById('panel-body');
const tabsEl = document.getElementById('panel-tabs');
let tab = localStorage.getItem('wg.panelTab') || 'queue';
let lyr = { id: null, data: null };

export function initPanel() {
  renderTabs();
  render();
  player.addEventListener('track', () => { if (tab === 'lyrics' || npOpen()) loadLyrics(); if (tab === 'queue') render(); });
  player.addEventListener('queue', () => { if (tab === 'queue') render(); });
  player.addEventListener('time', syncLyrics);
  on('lyrics', (d) => { if (d.track_id === player.current?.id) { lyr.id = null; loadLyrics(); } });
}

export function showTab(t) {
  tab = t;
  try { localStorage.setItem('wg.panelTab', t); } catch { /* ignore */ }
  document.getElementById('app').classList.remove('panel-closed');
  renderTabs();
  render();
}

function renderTabs() {
  tabsEl.innerHTML = [['queue', 'queue', 'Queue'], ['lyrics', 'lyrics', 'Lyrics'], ['eq', 'eq', 'EQ']]
    .map(([id, ic, label]) => `<button class="${tab === id ? 'active' : ''}" data-t="${id}">${icon(ic, 16)} ${label}</button>`).join('');
  tabsEl.onclick = (e) => { const b = e.target.closest('[data-t]'); if (b) showTab(b.dataset.t); };
}

function render() {
  if (tab === 'queue') renderQueue();
  else if (tab === 'lyrics') { body.innerHTML = '<div class="lyrics" id="lyr"></div>'; lyr.id = null; loadLyrics(); }
  else renderEq();
}

// ------------------------------------------------------------ queue
function qItem(t, kind, i, current = false) {
  return `<div class="q-item ${current ? 'current' : ''}" ${kind ? `draggable="true" data-kind="${kind}" data-i="${i}"` : ''}>
    <img src="${esc(t.cover)}" alt="" onerror="this.style.visibility='hidden'">
    <div class="tt"><span class="t-title">${esc(t.title)}</span><span class="t-sub muted">${esc(t.artist)}</span></div>
    ${kind ? `<button class="icon-btn" data-rm title="Remove">${icon('x', 16)}</button>` : ''}</div>`;
}

function renderQueue() {
  const t = player.current;
  if (!t) {
    body.innerHTML = `<div class="lyrics-empty">${icon('queue', 40)}<p>Nothing playing yet.<br>Double-click any song to start.</p></div>`;
    return;
  }
  const { user, rest } = player.upcoming(100);
  const ctxName = player.ctxInfo?.name ? esc(player.ctxInfo.name) : 'your music';
  body.innerHTML = `<div class="np-card"><img src="${esc(t.cover)}" alt="" onerror="this.style.display='none'">
      <div class="np-info"><div class="np-title">${esc(t.title)}</div><div class="muted"><a href="#/artist/${esc(t.artist_id)}">${esc(t.artist)}</a></div></div></div>
    ${user.length ? `<div class="q-label"><span>Next in queue</span><button class="link" id="q-clear">Clear</button></div>${user.map((x, i) => qItem(x, 'user', i)).join('')}` : ''}
    ${rest.length ? `<div class="q-label"><span>Next from: ${ctxName}${player.shuffleOn ? ` <span class="badge-sm q">${{ fewer_repeats: 'Fewer repeats', balanced: 'Balanced', standard: 'Shuffle' }[player.shuffleMode]}</span>` : ''}</span></div>${rest.map((x, i) => qItem(x, 'rest', i)).join('')}` : ''}
    ${!user.length && !rest.length ? `<div class="muted" style="padding:12px 4px">${player.repeat === 'all' ? 'Repeating from the start' : 'End of the queue'}</div>` : ''}`;
  body.querySelector('#q-clear')?.addEventListener('click', () => { player.userQueue = []; player._emit('queue'); });
  body.onclick = (e) => {
    const it = e.target.closest('.q-item[data-kind]');
    if (!it) return;
    if (e.target.closest('[data-rm]')) player.removeUpcoming(it.dataset.kind, +it.dataset.i);
    else player.jumpTo(it.dataset.kind, +it.dataset.i);
  };
  let src = null;
  body.ondragstart = (e) => { src = e.target.closest('.q-item'); src?.classList.add('dragging'); };
  body.ondragover = (e) => {
    e.preventDefault();
    body.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before'));
    const o = e.target.closest('.q-item[data-kind]');
    if (o && src && o.dataset.kind === src.dataset.kind) o.classList.add('drop-before');
  };
  body.ondrop = (e) => {
    e.preventDefault();
    const o = e.target.closest('.q-item[data-kind]');
    if (o && src && o !== src && o.dataset.kind === src.dataset.kind) {
      const from = +src.dataset.i; let to = +o.dataset.i;
      if (from < to) to -= 1;
      player.moveUpcoming(src.dataset.kind, from, to);
    }
    src = null;
  };
  body.ondragend = () => body.querySelectorAll('.dragging,.drop-before').forEach((x) => x.classList.remove('dragging', 'drop-before'));
}

// ------------------------------------------------------------ lyrics
const npOpen = () => document.getElementById('nowplaying').classList.contains('open');
function lyrTargets() { return [...document.querySelectorAll('#lyr, #np-lyr')]; }

async function loadLyrics() {
  const t = player.current;
  const targets = lyrTargets();
  if (!targets.length) return;
  if (!t) { targets.forEach((el) => (el.innerHTML = `<div class="lyrics-empty">Play something to see lyrics</div>`)); return; }
  if (lyr.id !== t.id) {
    lyr = { id: t.id, data: null, active: -1 };
    targets.forEach((el) => (el.innerHTML = `<div class="lyrics-empty">Loading lyrics…</div>`));
    try { lyr.data = await api.get(`/api/tracks/${t.id}/lyrics`); } catch { lyr.data = { lines: [] }; }
    if (lyr.id !== t.id) return;
  }
  const d = lyr.data;
  lyrTargets().forEach((el) => {
    if (!d.lines.length) {
      el.className = 'lyrics';
      el.innerHTML = `<div class="lyrics-empty">${icon('lyrics', 40)}<p>No lyrics for this song yet.</p>
        <button class="btn primary" data-fetch>${icon('search', 16)} Find lyrics online</button></div>`;
      el.querySelector('[data-fetch]').onclick = async (e) => {
        e.target.disabled = true;
        e.target.textContent = 'Searching LRCLIB…';
        const r = await api.post(`/api/tracks/${t.id}/lyrics/fetch`).catch(() => ({ ok: false }));
        if (!r.ok) { toast('No lyrics found', 'error'); e.target.textContent = 'Not found'; }
      };
      return;
    }
    el.className = `lyrics ${d.synced ? '' : 'unsynced'}`;
    el.innerHTML = d.lines.map((l, i) => `<p class="ln future" data-i="${i}">${esc(l.text) || '♪'}</p>`).join('')
      + (d.synced ? '' : '<p class="faint" style="font-size:12px;margin-top:20px">Lyrics aren’t time-synced for this song.</p>');
    el.onclick = (e) => {
      const ln = e.target.closest('.ln');
      if (ln && d.synced) { player.seek(d.lines[+ln.dataset.i].t / 1000); if (player.paused) player.play(); }
    };
    el.parentElement.onwheel = () => (lyr.userScroll = Date.now());
  });
  lyr.active = -1;
  syncLyrics();
}

function syncLyrics() {
  const d = lyr.data;
  if (!d || !d.synced || lyr.id !== player.current?.id) return;
  const ms = player.time * 1000 + 150;
  // binary search for the last line that has started
  let lo = 0, hi = d.lines.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (d.lines[mid].t <= ms) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (idx === lyr.active) return;
  lyr.active = idx;
  lyrTargets().forEach((el) => {
    const lines = el.querySelectorAll('.ln');
    lines.forEach((ln, i) => { ln.className = `ln ${i < idx ? 'past' : i === idx ? 'active' : 'future'}`; });
    const act = lines[idx];
    if (act && Date.now() - (lyr.userScroll || 0) > 3000) {
      const sc = el.parentElement;
      sc.scrollTo({ top: act.offsetTop - sc.clientHeight * 0.38, behavior: 'smooth' });
    }
  });
}

export function refreshLyricsTargets() { lyr.id = null; loadLyrics(); }

// ------------------------------------------------------------ equalizer
function renderEq() {
  const g = player.eqGains;
  body.innerHTML = `<div class="eq-wrap">
    <div class="row" style="margin-bottom:12px"><b style="flex:1">Equalizer</b><button class="toggle ${player.eqEnabled ? 'on' : ''}" id="eq-on"></button></div>
    <select class="input" id="eq-preset" style="margin-bottom:12px">${Object.keys(EQ_PRESETS).map((k) => `<option value="${k}">${k[0].toUpperCase() + k.slice(1)}</option>`).join('')}<option value="custom">Custom</option></select>
    <canvas class="eq-curve" id="eq-curve"></canvas>
    <div class="eq-bands">${EQ_FREQS.map((f, i) => `<div class="eq-band"><b id="eqv${i}">${g[i] > 0 ? '+' : ''}${g[i]}</b>
      <input type="range" min="-12" max="12" step="0.5" value="${g[i]}" data-band="${i}"><span>${f >= 1000 ? f / 1000 + 'k' : f}</span></div>`).join('')}</div>
    <p class="faint" style="font-size:12px;margin-top:14px">10-band graphic EQ built from biquad filters (low shelf, 8 peaking bells, high shelf). The preamp drops automatically when you boost, so it never clips.</p></div>`;
  const preset = Object.entries(EQ_PRESETS).find(([, v]) => v.every((x, i) => x === g[i]));
  body.querySelector('#eq-preset').value = preset ? preset[0] : 'custom';
  body.querySelector('#eq-on').onclick = (e) => { e.target.classList.toggle('on'); player.setEqEnabled(e.target.classList.contains('on')); drawCurve(); };
  body.querySelector('#eq-preset').onchange = (e) => {
    if (e.target.value === 'custom') return;
    player.setEq(EQ_PRESETS[e.target.value]);
    player.setEqEnabled(true);
    saveSettings({ eq_preset: e.target.value });
    renderEq();
  };
  body.querySelectorAll('[data-band]').forEach((inp) => (inp.oninput = () => {
    const gains = player.eqGains.slice();
    gains[+inp.dataset.band] = +inp.value;
    if (!player.eqEnabled) { player.setEqEnabled(true); body.querySelector('#eq-on').classList.add('on'); }
    player.setEq(gains);
    body.querySelector(`#eqv${inp.dataset.band}`).textContent = `${+inp.value > 0 ? '+' : ''}${inp.value}`;
    body.querySelector('#eq-preset').value = 'custom';
    drawCurve();
  }));
  drawCurve();
}

let offline;
function drawCurve() {
  const cv = document.getElementById('eq-curve');
  if (!cv) return;
  const W = cv.clientWidth, H = cv.clientHeight, dpr = devicePixelRatio || 1;
  cv.width = W * dpr; cv.height = H * dpr;
  const x = cv.getContext('2d');
  x.scale(dpr, dpr);
  offline ||= new OfflineAudioContext(1, 1, 44100);
  const N = 200;
  const freqs = new Float32Array(N).map((_, i) => 20 * Math.pow(1000, i / (N - 1)));
  const total = new Float32Array(N).fill(1);
  const gains = player.eqEnabled ? player.eqGains : EQ_PRESETS.flat;
  EQ_FREQS.forEach((f, i) => {
    const b = offline.createBiquadFilter();
    b.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
    b.frequency.value = f; b.Q.value = 1.1; b.gain.value = gains[i];
    const mag = new Float32Array(N), ph = new Float32Array(N);
    b.getFrequencyResponse(freqs, mag, ph);
    for (let k = 0; k < N; k++) total[k] *= mag[k];
  });
  const css = getComputedStyle(document.body);
  const acc = css.getPropertyValue('--accent-rgb').trim();
  x.strokeStyle = css.getPropertyValue('--border'); x.lineWidth = 1;
  for (const db of [-12, -6, 0, 6, 12]) {
    const y = H / 2 - (db / 15) * (H / 2);
    x.beginPath(); x.moveTo(0, y); x.lineTo(W, y); x.stroke();
  }
  x.beginPath();
  for (let k = 0; k < N; k++) {
    const db = 20 * Math.log10(total[k]);
    const px = (k / (N - 1)) * W, py = H / 2 - (db / 15) * (H / 2);
    k ? x.lineTo(px, py) : x.moveTo(px, py);
  }
  x.strokeStyle = `rgb(${acc})`; x.lineWidth = 2.5; x.stroke();
  x.lineTo(W, H); x.lineTo(0, H); x.closePath();
  const gr = x.createLinearGradient(0, 0, 0, H);
  gr.addColorStop(0, `rgba(${acc},.35)`); gr.addColorStop(1, `rgba(${acc},0)`);
  x.fillStyle = gr; x.fill();
}

export { fmtTime };
