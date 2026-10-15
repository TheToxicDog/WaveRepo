// Background effects canvas: reacts to the mouse and (when playing) the music.
//   ripples   rings spread out from the cursor as it moves, bigger on click
//   particles drifting constellation that swirls away from the cursor
//   glow      soft light that follows the cursor, pulsing with the bass
//   off

import { player } from './player.js';

const cv = document.getElementById('fx');
const g = cv.getContext('2d');
const cvTop = document.getElementById('fx-top');
const gt = cvTop.getContext('2d');
let W = 0, H = 0, DPR = 1;
let mode = 'ripples', intensity = 0.7;
const mouse = { x: innerWidth / 2, y: innerHeight / 2, sx: innerWidth / 2, sy: innerHeight / 2, lastX: 0, lastY: 0, moved: 0 };
let ripples = [], particles = [], accent = [30, 215, 96], accent2 = [80, 140, 255];
let lastBassHit = 0, bassAvg = 0;

function resize() {
  DPR = Math.min(devicePixelRatio || 1, 1.5);
  W = innerWidth; H = innerHeight;
  for (const [c, x] of [[cv, g], [cvTop, gt]]) {
    c.width = W * DPR; c.height = H * DPR;
    c.style.width = W + 'px'; c.style.height = H + 'px';
    x.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  if (mode === 'particles') seedParticles();
}

function seedParticles() {
  const n = Math.round((W * H) / 16000 * (0.5 + intensity));
  particles = Array.from({ length: n }, () => ({
    x: Math.random() * W, y: Math.random() * H,
    vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3, r: Math.random() * 1.6 + 0.6,
  }));
}

export function setFx(m, inten) {
  mode = m || 'ripples';
  if (inten !== undefined) intensity = inten;
  ripples = [];
  if (mode === 'particles') seedParticles();
  cv.style.display = cvTop.style.display = mode === 'off' ? 'none' : '';
  gt.clearRect(0, 0, W, H);
}

export function setAccent(rgb, rgb2) {
  if (rgb) accent = rgb;
  if (rgb2) accent2 = rgb2;
}

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

addEventListener('resize', resize);
addEventListener('pointermove', (e) => {
  mouse.x = e.clientX; mouse.y = e.clientY;
  if (mode !== 'ripples') return;
  const dx = e.clientX - mouse.lastX, dy = e.clientY - mouse.lastY;
  mouse.moved += Math.hypot(dx, dy);
  mouse.lastX = e.clientX; mouse.lastY = e.clientY;
  if (mouse.moved > 70 && ripples.length < 40) {
    mouse.moved = 0;
    ripples.push({ x: e.clientX, y: e.clientY, r: 4, max: 70 + 60 * intensity, a: 0.22 * intensity, w: 1.2, c: accent });
  }
}, { passive: true });
addEventListener('pointerdown', (e) => {
  if (mode === 'off') return;
  for (let i = 0; i < 3; i++) {
    ripples.push({ x: e.clientX, y: e.clientY, r: 2 + i * 14, max: 220 + 120 * intensity, a: 0.35 * intensity, w: 2 - i * 0.5, c: i % 2 ? accent2 : accent });
  }
  if (mode === 'particles') {
    for (const p of particles) {
      const dx = p.x - e.clientX, dy = p.y - e.clientY, d = Math.hypot(dx, dy) || 1;
      if (d < 220) { p.vx += (dx / d) * 3 * (1 - d / 220); p.vy += (dy / d) * 3 * (1 - d / 220); }
    }
  }
}, { passive: true });

function drawAmbient(t, lv) {
  // two slow aurora blobs that lean toward the cursor
  mouse.sx += (mouse.x - mouse.sx) * 0.04;
  mouse.sy += (mouse.y - mouse.sy) * 0.04;
  const pulse = 1 + lv.bass * 0.35;
  const b1x = W * 0.3 + Math.sin(t * 0.00011) * W * 0.12 + (mouse.sx - W / 2) * 0.08;
  const b1y = H * 0.25 + Math.cos(t * 0.00013) * H * 0.1 + (mouse.sy - H / 2) * 0.08;
  const b2x = W * 0.75 + Math.cos(t * 0.00009) * W * 0.1 - (mouse.sx - W / 2) * 0.05;
  const b2y = H * 0.7 + Math.sin(t * 0.0001) * H * 0.1 - (mouse.sy - H / 2) * 0.05;
  const r1 = Math.max(W, H) * 0.45 * pulse, r2 = Math.max(W, H) * 0.4 * pulse;
  let gr = g.createRadialGradient(b1x, b1y, 0, b1x, b1y, r1);
  gr.addColorStop(0, rgba(accent, 0.13 * intensity + lv.level * 0.08));
  gr.addColorStop(1, rgba(accent, 0));
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
  gr = g.createRadialGradient(b2x, b2y, 0, b2x, b2y, r2);
  gr.addColorStop(0, rgba(accent2, 0.1 * intensity + lv.treble * 0.08));
  gr.addColorStop(1, rgba(accent2, 0));
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
}

function drawRipples() {
  gt.clearRect(0, 0, W, H);
  for (const r of ripples) {
    r.r += 1.6 + r.r * 0.025;
    const life = 1 - r.r / r.max;
    if (life <= 0) continue;
    gt.beginPath();
    gt.arc(r.x, r.y, r.r, 0, Math.PI * 2);
    gt.strokeStyle = rgba(r.c, r.a * life);
    gt.lineWidth = r.w;
    gt.stroke();
    // faint filled wave behind the ring
    gt.fillStyle = rgba(r.c, r.a * life * 0.12);
    gt.fill();
  }
  ripples = ripples.filter((r) => r.r < r.max);
}

function drawParticles(lv) {
  const R = 140;
  for (const p of particles) {
    const dx = p.x - mouse.x, dy = p.y - mouse.y, d = Math.hypot(dx, dy);
    if (d < R && d > 0) {
      // swirl: push away + a little tangential spin
      const f = (1 - d / R) * 0.35;
      p.vx += (dx / d) * f - (dy / d) * f * 0.6;
      p.vy += (dy / d) * f + (dx / d) * f * 0.6;
    }
    p.vx *= 0.96; p.vy *= 0.96;
    p.vx += (Math.random() - 0.5) * 0.02; p.vy += (Math.random() - 0.5) * 0.02;
    p.x += p.vx + p.vx * lv.bass * 2; p.y += p.vy + p.vy * lv.bass * 2;
    if (p.x < 0) p.x += W; if (p.x > W) p.x -= W; if (p.y < 0) p.y += H; if (p.y > H) p.y -= H;
  }
  g.lineWidth = 0.6;
  for (let i = 0; i < particles.length; i++) {
    const a = particles[i];
    const md = Math.hypot(a.x - mouse.x, a.y - mouse.y);
    g.beginPath();
    g.arc(a.x, a.y, a.r * (1 + lv.bass * 1.5), 0, Math.PI * 2);
    g.fillStyle = rgba(md < 200 ? accent : accent2, 0.35 * intensity + (md < 200 ? 0.3 : 0));
    g.fill();
    if (md > 260) continue;
    for (let j = i + 1; j < particles.length; j++) {
      const b = particles[j], dd = Math.hypot(a.x - b.x, a.y - b.y);
      if (dd < 90) {
        g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y);
        g.strokeStyle = rgba(accent, (1 - dd / 90) * 0.35 * intensity * (1 - md / 260));
        g.stroke();
      }
    }
  }
}

function drawGlow(lv) {
  const r = 260 + lv.bass * 160 + intensity * 80;
  const gr = g.createRadialGradient(mouse.sx, mouse.sy, 0, mouse.sx, mouse.sy, r);
  gr.addColorStop(0, rgba(accent, 0.22 * intensity + lv.level * 0.15));
  gr.addColorStop(0.5, rgba(accent2, 0.07 * intensity));
  gr.addColorStop(1, rgba(accent2, 0));
  g.fillStyle = gr;
  g.fillRect(0, 0, W, H);
}

function frame(t) {
  requestAnimationFrame(frame);
  if (mode === 'off' || document.hidden) return;
  if (!ripples.length && mode !== 'ripples') gt.clearRect(0, 0, W, H);
  const lv = player.levels();
  g.clearRect(0, 0, W, H);
  drawAmbient(t, lv);
  // a beat detector: spawn a soft ring from the centre on strong bass hits
  bassAvg = bassAvg * 0.95 + lv.bass * 0.05;
  if (lv.bass > bassAvg * 1.35 && lv.bass > 0.45 && t - lastBassHit > 280 && mode === 'ripples') {
    lastBassHit = t;
    ripples.push({ x: mouse.sx, y: mouse.sy, r: 10, max: 260 * intensity + 120, a: 0.18 * intensity, w: 1.5, c: accent2 });
  }
  if (mode === 'ripples') drawRipples();
  else if (mode === 'particles') { drawParticles(lv); drawRipples(); }
  else if (mode === 'glow') { drawGlow(lv); drawRipples(); }
}

resize();
requestAnimationFrame(frame);
