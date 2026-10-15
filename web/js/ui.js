// Small UI helpers: escaping, formatting, icons, toasts, menus, modals.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// allow only <b> and <mark> from server-side FTS highlighting
export const safeHl = (s) => esc(s).replace(/&lt;(\/?)(b|mark)&gt;/g, '<$1$2>');

export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtLong(sec) {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h} hr ${m} min` : `${m} min`;
}

export function fmtBytes(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

const P = {
  home: 'M12 3 3 10v11h6v-6h6v6h6V10z',
  search: 'M10.5 3a7.5 7.5 0 0 1 5.9 12.1l4.3 4.3-1.4 1.4-4.3-4.3A7.5 7.5 0 1 1 10.5 3zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z',
  compass: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm4.5 3.5-2.8 6.2-6.2 2.8 2.8-6.2zM12 10.8a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z',
  download: 'M11 3h2v9.6l3.3-3.3 1.4 1.4L12 16.4l-5.7-5.7 1.4-1.4L11 12.6zM4 18h16v2H4z',
  disc: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm0 5a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm0 2a1 1 0 1 0 0 2 1 1 0 0 0 0-2z',
  mic: 'M12 2a4 4 0 0 1 4 4v6a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4zm-7 9h2a5 5 0 0 0 10 0h2a7 7 0 0 1-6 6.9V21h-2v-3.1A7 7 0 0 1 5 11z',
  music: 'M9 4l11-2v14.5a3.5 3.5 0 1 1-2-3.2V6.4l-7 1.3v10.8A3.5 3.5 0 1 1 9 15.3z',
  heart: 'M12 20.5 10.6 19.2C5.4 14.5 2 11.4 2 7.6 2 4.5 4.4 2 7.5 2c1.7 0 3.4.8 4.5 2.1C13.1 2.8 14.8 2 16.5 2 19.6 2 22 4.5 22 7.6c0 3.8-3.4 6.9-8.6 11.6zm0-2.7c4.8-4.3 8-7.2 8-10.2C20 5.6 18.5 4 16.5 4c-1.5 0-3 1-3.6 2.4h-1.8C10.5 5 9 4 7.5 4 5.5 4 4 5.6 4 7.6c0 3 3.2 5.9 8 10.2z',
  heartFill: 'M12 20.5 10.6 19.2C5.4 14.5 2 11.4 2 7.6 2 4.5 4.4 2 7.5 2c1.7 0 3.4.8 4.5 2.1C13.1 2.8 14.8 2 16.5 2 19.6 2 22 4.5 22 7.6c0 3.8-3.4 6.9-8.6 11.6z',
  plus: 'M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z',
  play: 'M8 5v14l11-7z',
  pause: 'M6 5h4v14H6zm8 0h4v14h-4z',
  next: 'M6 6l8.5 6L6 18zm10 0h2v12h-2z',
  prev: 'M18 6v12l-8.5-6zM6 6h2v12H6z',
  shuffle: 'M14.8 4H20v5.2l-1.9-1.9-3.4 3.4-1.4-1.4 3.4-3.4zM4 5.4 5.4 4 20 18.6 18.6 20zM20 14.8V20h-5.2l1.9-1.9-2.6-2.6 1.4-1.4 2.6 2.6zM8.5 10 4 5.4',
  repeat: 'M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z',
  volume: 'M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z',
  volumeLow: 'M5 9v6h4l5 5V4L9 9zm13.5 3A4.5 4.5 0 0 0 16 8v8a4.5 4.5 0 0 0 2.5-4z',
  mute: 'M3 9v6h4l5 5V4L7 9zm13.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4z',
  queue: 'M3 6h12v2H3zm0 5h12v2H3zm0 5h8v2H3zm14-5v6.2a2.5 2.5 0 1 0 2 2.4V13h2v-2z',
  lyrics: 'M4 4h16v12H7l-3 3zm2 3v2h12V7zm0 4v2h8v-2z',
  eq: 'M6 3h2v6h2v2H4V9h2zm0 10h2v8H6zm5-10h2v10h2v2H9v-2h2zm0 14h2v4h-2zm5-14h2v2h2v2h-6V5h2zm0 6h2v12h-2z',
  settings: 'M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.4 2.9a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.4 7.4 0 0 0 1.7 1L11 21h4l.4-2.9a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z',
  cloud: 'M19.4 10A7 7 0 0 0 6.3 8.1 5 5 0 0 0 7 18h12a4 4 0 0 0 .4-8zM12 17l-4-4h3V9h2v4h3z',
  check: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z',
  checkCircle: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm-1.5 13.6 6.8-6.8-1.4-1.4-5.4 5.4-2.6-2.6-1.4 1.4z',
  more: 'M6 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
  left: 'M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z',
  right: 'M8.6 7.4 10 6l6 6-6 6-1.4-1.4 4.6-4.6z',
  x: 'M18.3 7.1 16.9 5.7 12 10.6 7.1 5.7 5.7 7.1l4.9 4.9-4.9 4.9 1.4 1.4 4.9-4.9 4.9 4.9 1.4-1.4-4.9-4.9z',
  drag: 'M9 5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM9 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM9 16a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
  up: 'M12 4l7 7-1.4 1.4L13 7.8V20h-2V7.8l-4.6 4.6L5 11z',
  top: 'M5 4h14v2H5zm7 3 6 6-1.4 1.4-3.6-3.6V21h-2V10.8l-3.6 3.6L6 13z',
  folder: 'M3 5h7l2 2h9v12H3z',
  refresh: 'M17.7 6.3A8 8 0 1 0 19.9 13h-2.1a6 6 0 1 1-1.5-5.3L13 11h7V4z',
  link: 'M10.6 13.4a1 1 0 0 1 0-1.4l3.5-3.5a1 1 0 1 1 1.4 1.4L12 13.4a1 1 0 0 1-1.4 0zM8.5 19a4.5 4.5 0 0 1-3.2-7.7l2.1-2.1 1.4 1.4-2.1 2.1a2.5 2.5 0 0 0 3.5 3.5l2.1-2.1 1.4 1.4-2.1 2.1A4.5 4.5 0 0 1 8.5 19zm7.6-4.8-1.4-1.4 2.1-2.1a2.5 2.5 0 0 0-3.5-3.5l-2.1 2.1-1.4-1.4 2.1-2.1a4.5 4.5 0 0 1 6.4 6.4z',
  grid: 'M4 4h7v7H4zm9 0h7v7h-7zM4 13h7v7H4zm9 0h7v7h-7z',
  list: 'M4 5h16v2H4zm0 6h16v2H4zm0 6h16v2H4z',
  clock: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm1 3v5.4l3.7 2.2-1 1.7L11 13.5V7z',
  expand: 'M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z',
  playlist: 'M3 5h13v2H3zm0 4h13v2H3zm0 4h9v2H3zm13 0 6 3.5-6 3.5z',
  sparkle: 'M12 2l2.1 6.2L20 10l-5.9 1.8L12 18l-2.1-6.2L4 10l5.9-1.8zM19 15l.9 2.6L22 18l-2.1.6L19 21l-.9-2.4L16 18l2.1-.4z',
  palette: 'M12 2a10 10 0 0 0 0 20c1 0 1.6-.8 1.6-1.6 0-.4-.2-.8-.4-1.1-.3-.3-.4-.6-.4-1.1 0-.9.7-1.6 1.6-1.6h2A5.6 5.6 0 0 0 22 11c0-5-4.5-9-10-9zM6.5 12a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3 4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z',
  trash: 'M9 3h6l1 1h4v2H4V4h4zm-3 4h12l-1 14H7z',
  pauseCircle: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zM9 8v8h2V8zm4 0v8h2V8z',
  playCircle: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm-2 5.5v9l7-4.5z',
  alert: 'M12 2 1 21h22zm-1 7h2v6h-2zm0 8h2v2h-2z',
  drive: 'M4 5h16l2 9v5H2v-5zm1.6 2-1.4 7h15.6l-1.4-7zM17 16a1 1 0 1 0 0 2 1 1 0 0 0 0-2z',
};

export const icon = (name, size = 20, cls = '') =>
  `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path d="${P[name] || P.music}"/></svg>`;

// ---------------------------------------------------------------- toast
let toastTimer;
export function toast(msg, kind = '') {
  const el = document.getElementById('toast');
  el.className = `show ${kind}`;
  el.innerHTML = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 3200);
}

// ---------------------------------------------------------------- context menu
export function menu(ev, items) {
  ev.preventDefault();
  ev.stopPropagation();
  const m = document.getElementById('ctxmenu');
  m.innerHTML = items.filter(Boolean).map((it, i) => it === '-' ? '<div class="sep"></div>' :
    `<button data-i="${i}">${it.icon ? icon(it.icon, 16) : ''}<span>${esc(it.label)}</span></button>`).join('');
  m.classList.add('open');
  const r = m.getBoundingClientRect();
  const x = Math.min(ev.clientX, innerWidth - r.width - 8), y = Math.min(ev.clientY, innerHeight - r.height - 8);
  m.style.left = x + 'px';
  m.style.top = y + 'px';
  const list = items.filter(Boolean);
  m.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    closeMenu();
    list[+b.dataset.i]?.action?.();
  };
}
export function closeMenu() { document.getElementById('ctxmenu').classList.remove('open'); }
addEventListener('click', closeMenu);
addEventListener('blur', closeMenu);

// ---------------------------------------------------------------- modal
export function modal(html, onMount) {
  const m = document.getElementById('modal');
  m.innerHTML = `<div class="modal-card">${html}</div>`;
  m.classList.add('open');
  const close = () => m.classList.remove('open');
  m.onclick = (e) => { if (e.target === m || e.target.closest('[data-close]')) close(); };
  onMount?.(m.querySelector('.modal-card'), close);
  return close;
}

export function prompt(title, value = '', placeholder = '') {
  return new Promise((resolve) => {
    modal(`<h3>${esc(title)}</h3><input class="input" id="pm" value="${esc(value)}" placeholder="${esc(placeholder)}">
      <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="pmok">OK</button></div>`,
    (card, close) => {
      const inp = card.querySelector('#pm');
      inp.focus(); inp.select();
      const ok = () => { close(); resolve(inp.value.trim()); };
      card.querySelector('#pmok').onclick = ok;
      inp.onkeydown = (e) => { if (e.key === 'Enter') ok(); if (e.key === 'Escape') { close(); resolve(null); } };
    });
  });
}

// ---------------------------------------------------------------- dominant colour
const colorCache = new Map();
export function dominantColor(src) {
  if (!src) return Promise.resolve(null);
  if (colorCache.has(src)) return Promise.resolve(colorCache.get(src));
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 24;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(img, 0, 0, 24, 24);
        const d = x.getImageData(0, 0, 24, 24).data;
        let best = null, bestScore = -1, r = 0, g = 0, b = 0, n = 0;
        // bucket colours; favour saturated, mid-bright buckets
        const buckets = new Map();
        for (let i = 0; i < d.length; i += 4) {
          const R = d[i], G = d[i + 1], B = d[i + 2];
          r += R; g += G; b += B; n++;
          const k = ((R >> 5) << 6) | ((G >> 5) << 3) | (B >> 5);
          const e = buckets.get(k) || [0, 0, 0, 0];
          e[0] += R; e[1] += G; e[2] += B; e[3]++;
          buckets.set(k, e);
        }
        for (const e of buckets.values()) {
          const R = e[0] / e[3], G = e[1] / e[3], B = e[2] / e[3];
          const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
          const sat = mx ? (mx - mn) / mx : 0, lum = mx / 255;
          const score = e[3] * (0.3 + sat) * (lum > 0.15 && lum < 0.95 ? 1 : 0.2);
          if (score > bestScore) { bestScore = score; best = [R, G, B]; }
        }
        const col = (best || [r / n, g / n, b / n]).map(Math.round);
        colorCache.set(src, col);
        resolve(col);
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
