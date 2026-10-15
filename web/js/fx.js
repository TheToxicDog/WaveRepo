// Ambient background: two slow colour blobs behind the panels that drift on
// their own and swell gently with the music. No mouse interaction.

import { player } from './player.js';

const cv = document.getElementById('fx');
const g = cv.getContext('2d');
let W = 0, H = 0, DPR = 1;
let mode = 'ambient', intensity = 0.7;
let accent = [30, 215, 96], accent2 = [80, 140, 255];

function resize() {
  DPR = Math.min(devicePixelRatio || 1, 1.5);
  W = innerWidth; H = innerHeight;
  cv.width = W * DPR; cv.height = H * DPR;
  cv.style.width = W + 'px'; cv.style.height = H + 'px';
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
}

export function setFx(m, inten) {
  // older settings used ripples / particles / glow: they all map to ambient now
  mode = m === 'off' ? 'off' : 'ambient';
  if (inten !== undefined) intensity = inten;
  cv.style.display = mode === 'off' ? 'none' : '';
}

export function setAccent(rgb, rgb2) {
  if (rgb) accent = rgb;
  if (rgb2) accent2 = rgb2;
}

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
let smooth = { bass: 0, level: 0, treble: 0 };

function blob(x, y, r, c, a) {
  const gr = g.createRadialGradient(x, y, 0, x, y, r);
  gr.addColorStop(0, rgba(c, a));
  gr.addColorStop(1, rgba(c, 0));
  g.fillStyle = gr;
  g.fillRect(0, 0, W, H);
}

function frame(t) {
  requestAnimationFrame(frame);
  if (mode === 'off' || document.hidden) return;
  const lv = player.levels();
  for (const k of Object.keys(smooth)) smooth[k] += ((lv[k] || 0) - smooth[k]) * 0.08;
  g.clearRect(0, 0, W, H);
  const pulse = 1 + smooth.bass * 0.3;
  const R = Math.max(W, H);
  blob(W * 0.3 + Math.sin(t * 0.00011) * W * 0.12, H * 0.25 + Math.cos(t * 0.00013) * H * 0.1,
    R * 0.45 * pulse, accent, 0.13 * intensity + smooth.level * 0.08);
  blob(W * 0.75 + Math.cos(t * 0.00009) * W * 0.1, H * 0.7 + Math.sin(t * 0.0001) * H * 0.1,
    R * 0.4 * pulse, accent2, 0.1 * intensity + smooth.treble * 0.08);
}

addEventListener('resize', resize);
resize();
requestAnimationFrame(frame);
