import { api } from '../api.js';
import { player } from '../player.js';
import { esc, fmtBytes, icon } from '../ui.js';

export async function videos(view) {
  const items = await api.get('/api/videos');
  view.innerHTML = `<div class="page"><h1>Music videos</h1>
    <p class="muted" style="margin:-8px 0 18px">Videos saved from Downloads → “Music video” live in the <code>Music Videos</code> folder of your music drive.</p>
    ${items.length ? `<div class="grid videos">${items.map((v, i) => `<div class="card video-card" data-i="${i}">
        <div class="card-art wide"><img loading="lazy" src="${esc(v.thumb)}" alt="" onerror="this.style.opacity=0"><div class="ph">${icon('playCircle', 44)}</div>
          <button class="play-fab">${icon('play', 24)}</button></div>
        <div class="card-title" title="${esc(v.title)}">${esc(v.title)}</div>
        <div class="card-sub">${esc(v.artist || 'Unknown artist')} • ${fmtBytes(v.size)}</div></div>`).join('')}</div>`
      : `<div class="empty">${icon('playCircle', 48)}<h3>No music videos yet</h3><p>Paste a YouTube link in Downloads and choose “Music video”.</p>
        <div class="row" style="justify-content:center;margin-top:12px"><a class="btn primary" href="#/downloads">${icon('download', 16)} Go to Downloads</a></div></div>`}</div>`;
  view.onclick = (e) => {
    const c = e.target.closest('.video-card');
    if (c) openVideo(items, +c.dataset.i);
  };
}

function openVideo(items, i) {
  const v = items[i];
  const wasPlaying = !player.paused;
  player.pause(); // don't play the song and the video on top of each other
  const box = document.getElementById('nowplaying');
  box.innerHTML = `<div class="video-stage"><button class="round-btn np-close" id="v-close">${icon('x', 20)}</button>
    <video src="/api/videos/${v.id}/stream" controls autoplay></video>
    <div class="video-info"><div><h2>${esc(v.title)}</h2><div class="muted">${esc(v.artist)}</div></div>
      <span class="spacer"></span>
      <button class="btn" id="v-prev" ${i === 0 ? 'disabled' : ''}>${icon('prev', 16)} Previous</button>
      <button class="btn" id="v-next" ${i === items.length - 1 ? 'disabled' : ''}>Next ${icon('next', 16)}</button></div></div>`;
  box.classList.add('open', 'video-mode');
  const video = box.querySelector('video');
  const close = () => {
    video.pause();
    box.classList.remove('open', 'video-mode');
    box.innerHTML = '';
    removeEventListener('keydown', onKey, true);
    if (wasPlaying) player.play();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  addEventListener('keydown', onKey, true);
  box.querySelector('#v-close').onclick = close;
  box.querySelector('#v-prev').onclick = () => { video.pause(); removeEventListener('keydown', onKey, true); openVideo(items, i - 1); };
  box.querySelector('#v-next').onclick = () => { video.pause(); removeEventListener('keydown', onKey, true); openVideo(items, i + 1); };
  video.onended = () => { if (i < items.length - 1) box.querySelector('#v-next').click(); };
}
