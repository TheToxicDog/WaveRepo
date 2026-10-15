import { api } from '../api.js';
import { EQ_PRESETS, player } from '../player.js';
import { saveSettings, store } from '../store.js';
import { esc, icon, modal, toast } from '../ui.js';
import { THEMES } from '../themes.js';

export function folderPicker(title, start = '') {
  return new Promise((resolve) => {
    modal(`<h3>${esc(title)}</h3><div class="row"><input class="input" id="fp-path" placeholder="Type a path, e.g. E:\\Music" style="flex:1"><button class="btn" id="fp-go">Go</button></div>
      <div class="browse-list" id="fp-list"></div>
      <div class="row end"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="fp-ok">Use this folder</button></div>`, (card, close) => {
      const inp = card.querySelector('#fp-path');
      const load = async (p) => {
        const r = await api.get(`/api/browse?path=${encodeURIComponent(p)}`);
        inp.value = r.path;
        card.querySelector('#fp-list').innerHTML = (r.parent !== null && r.path ? `<button data-p="${esc(r.parent)}">${icon('up', 18)} ..</button>` : '') +
          r.dirs.map((d) => `<button data-p="${esc(d)}">${icon(r.path ? 'folder' : 'drive', 18)} ${esc(r.path ? d.split(/[\\/]/).filter(Boolean).pop() : d)}</button>`).join('');
      };
      card.querySelector('#fp-list').onclick = (e) => { const b = e.target.closest('[data-p]'); if (b) load(b.dataset.p); };
      card.querySelector('#fp-go').onclick = () => load(inp.value);
      inp.onkeydown = (e) => { if (e.key === 'Enter') load(inp.value); };
      card.querySelector('#fp-ok').onclick = () => { close(); resolve(inp.value.trim() || null); };
      load(start);
    });
  });
}

const row = (label, desc, ctl) => `<div class="set-row"><div class="lbl"><b>${label}</b><span>${desc}</span></div><div class="ctl">${ctl}</div></div>`;
const toggle = (key, on) => `<button class="toggle ${on ? 'on' : ''}" data-toggle="${key}"></button>`;

export async function settingsView(view) {
  const s = store.settings = await api.get('/api/settings');
  const st = await api.get('/api/stats');
  const roots = st.roots;
  view.innerHTML = `<div class="page" style="max-width:920px"><h1>Settings</h1>
    <div class="set-group"><h3>Music folders</h3>
      <p class="muted" style="margin:4px 0 8px;font-size:13px">WaveGrab reads your songs straight from these folders. The external drive is used first; if it's unplugged, its songs stay in your library and come back when you plug it in.</p>
      ${roots.map((r, i) => `<div class="folder">${icon(i === 0 ? 'drive' : 'folder', 20)}<span class="grow" title="${esc(r.path)}">${esc(r.path)}</span>
        ${r.online ? '<span class="pill accent">Connected</span>' : '<span class="pill">Not connected</span>'}
        ${s.download_dir === r.path ? '<span class="pill">Downloads go here</span>' : `<button class="btn sm ghost" data-dlhere="${i}">Save downloads here</button>`}
        ${i > 0 ? `<button class="icon-btn" data-up="${i}" title="Make preferred">${icon('up', 16)}</button>` : ''}
        <button class="icon-btn" data-rm="${i}" title="Remove">${icon('x', 16)}</button></div>`).join('')}
      <div class="row" style="padding:10px 0 14px"><button class="btn primary" id="add-root">${icon('plus', 16)} Add folder</button>
        <button class="btn" id="rescan">${icon('refresh', 16)} Rescan now</button>
        <button class="btn ghost" id="fullscan">Full rescan</button>
        <span class="muted" style="font-size:12px">${st.tracks.toLocaleString()} songs • ${st.albums.toLocaleString()} albums • ${st.artists.toLocaleString()} artists</span></div></div>

    <div class="set-group"><h3>Appearance</h3>
      <div class="themes" id="themes">${THEMES.map((t) => `<button class="theme-sw ${s.theme === t.id ? 'active' : ''}" data-theme-id="${t.id}" style="background:${t.bg};color:${t.fg}">
        <div class="dots">${t.dots.map((c) => `<i style="background:${c}"></i>`).join('')}</div>${t.name}</button>`).join('')}</div>
      ${row('Background', 'Soft colour glow behind the app that gently pulses with the music', `<select class="input" id="effects">
        <option value="ambient">Ambient</option><option value="off">Off</option></select>`)}
      ${row('Background strength', '', `<input type="range" class="range" id="intensity" min="0.1" max="1" step="0.05" value="${s.effects_intensity}">`)}
      ${row('Match album colours', 'Tint the player and effects with the colours of the album that’s playing', toggle('adaptive_color', s.adaptive_color))}
    </div>

    <div class="set-group"><h3>Playback</h3>
      ${row('Crossfade', 'Blend the end of a song into the next one', `<input type="range" class="range" id="crossfade" min="0" max="12" step="1" value="${player.crossfade}"><span id="cf-v" style="width:34px">${player.crossfade}s</span>`)}
      ${row('Shuffle style', '<b>Fewer repeats</b> avoids songs you played recently • <b>Balanced</b> spreads artists apart • <b>Standard</b> is pure random', `<select class="input" id="shufmode">
        <option value="fewer_repeats">Fewer repeats</option><option value="balanced">Balanced artist spread</option><option value="standard">Standard</option></select>`)}
      ${row('Equalizer', 'Open the EQ tab in the right panel to adjust', `<select class="input" id="eqpreset">${Object.keys(EQ_PRESETS).map((k) => `<option value="${k}">${k[0].toUpperCase() + k.slice(1)}</option>`).join('')}</select>${toggle('eq', player.eqEnabled)}`)}
    </div>

    <div class="set-group"><h3>Downloads</h3>
      ${row('Download engine', '<b>spotDL</b> finds the right song using Spotify’s data and YouTube Music (falls back to WaveGrab’s own YouTube search if it fails)', `<select class="input" id="engine">
        <option value="spotdl">spotDL (recommended)</option><option value="ytdlp">Built-in YouTube search</option></select>`)}
      ${row('Download folder', esc(s.download_dir), `<button class="btn" id="dl-dir">${icon('folder', 16)} Change</button>`)}
      ${row('Audio format', 'M4A keeps YouTube’s audio without re-encoding (best quality). MP3 works everywhere.', `<select class="input" id="fmt">
        <option value="m4a">M4A (AAC, no re-encode)</option><option value="opus">Opus</option><option value="mp3">MP3</option><option value="flac">FLAC</option></select>`)}
      ${row('Fetch lyrics', 'Save synced lyrics (.lrc) from LRCLIB next to each download', toggle('fetch_lyrics', s.fetch_lyrics))}
      ${row('Use browser cookies', 'If YouTube asks to confirm you’re not a bot, WaveGrab can borrow your browser’s login', `<select class="input" id="cbrowser" style="width:150px">
        ${['', 'chrome', 'edge', 'firefox', 'brave', 'opera'].map((b) => `<option value="${b}" ${s.cookies_browser === b ? 'selected' : ''}>${b ? b[0].toUpperCase() + b.slice(1) : 'Off'}</option>`).join('')}</select>`)}
      ${row('YouTube Music cookies', 'Optional cookies.txt from a Premium account unlocks 256 kbps audio', `<input class="input" id="cookies" value="${esc(s.cookies_file)}" placeholder="C:\\path\\cookies.txt">`)}
      ${row('Parallel downloads', 'Takes effect after restart', `<select class="input" id="parallel" style="width:90px">${[1, 2, 3, 4].map((n) => `<option ${s.max_parallel_downloads == n ? 'selected' : ''}>${n}</option>`).join('')}</select>`)}
      ${row('Tools', 'Needed for downloading', `<span class="${s.spotdl ? 'ok-dot' : 'bad-dot'}">spotDL ${s.spotdl ? '✓' : '✗'}</span>
        <span class="${s.ytdlp ? 'ok-dot' : 'bad-dot'}">yt-dlp ${s.ytdlp ? '✓' : '✗'}</span>
        <span class="${s.ffmpeg ? 'ok-dot' : 'bad-dot'}">FFmpeg ${s.ffmpeg ? '✓' : '✗'}</span>
        ${!s.ffmpeg && s.spotdl ? `<button class="btn sm" id="get-ffmpeg">Install FFmpeg</button>` : ''}`)}
    </div>

    <div class="set-group"><h3>Organize library</h3>
      <p class="muted" style="margin:4px 0 8px;font-size:13px">Renames every album's files to <b>01 Title</b>, <b>02 Title</b>… in the official track order (looked up online when your tags don't say), writes the track numbers into the tags, and removes duplicate songs from albums. You'll see every change before anything happens. Duplicates are moved to a hidden <code>.wavegrab-duplicates</code> folder, not deleted, and the whole thing can be undone.</p>
      <div class="row" style="padding:6px 0 14px"><button class="btn primary" id="org-check">${icon('refresh', 16)} Check my albums</button><span class="muted" id="org-status" style="font-size:13px"></span></div>
      <div id="org-result"></div></div>

    <div class="set-group"><h3>Online</h3>
      ${row('Online features', 'Album search, discovery, downloads and lyric lookups. Turn off for 100% offline.', toggle('online', s.online))}
      ${row('Find missing lyrics', 'Look up lyrics for songs that don’t have any (runs in the background)', `<button class="btn" id="backfill">${icon('lyrics', 16)} Find lyrics</button>`)}
    </div>
    <p class="faint" style="font-size:12px">Data folder: ${esc(s.data_home)}</p></div>`;

  view.querySelector('#effects').value = s.effects === 'off' ? 'off' : 'ambient';
  view.querySelector('#fmt').value = s.audio_format;
  view.querySelector('#engine').value = s.download_engine || 'spotdl';
  view.querySelector('#engine').onchange = (e) => saveSettings({ download_engine: e.target.value });
  view.querySelector('#get-ffmpeg')?.addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'Installing…';
    const r = await api.post('/api/tools/ffmpeg').catch(() => ({ ok: false }));
    toast(r.ok ? 'FFmpeg installed' : 'Couldn’t install FFmpeg', r.ok ? '' : 'error');
    settingsView(view);
  });
  bindOrganizer(view);
  view.querySelector('#shufmode').value = player.shuffleMode;
  view.querySelector('#eqpreset').value = s.eq_preset || 'flat';

  const setRoots = async (r) => { await saveSettings({ library_roots: r }); settingsView(view); };
  view.querySelector('#add-root').onclick = async () => {
    const p = await folderPicker('Add music folder');
    if (p && !s.library_roots.includes(p)) { await setRoots([...s.library_roots, p]); toast('Folder added — scanning…'); }
  };
  view.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => setRoots(s.library_roots.filter((_, i) => i !== +b.dataset.rm))));
  view.querySelectorAll('[data-up]').forEach((b) => (b.onclick = () => {
    const r = s.library_roots.slice(), [x] = r.splice(+b.dataset.up, 1);
    setRoots([x, ...r]);
  }));
  view.querySelectorAll('[data-dlhere]').forEach((b) => (b.onclick = async () => {
    await saveSettings({ download_dir: s.library_roots[+b.dataset.dlhere] }); settingsView(view);
  }));
  view.querySelector('#rescan').onclick = () => { api.post('/api/scan'); toast('Scanning your music…'); };
  view.querySelector('#fullscan').onclick = () => { api.post('/api/scan?full=true'); toast('Re-reading every file…'); };
  view.querySelector('#dl-dir').onclick = async () => {
    const p = await folderPicker('Download folder', s.download_dir);
    if (!p) return;
    const patch = { download_dir: p };
    if (!s.library_roots.some((r) => p.startsWith(r))) patch.library_roots = [...s.library_roots, p];
    await saveSettings(patch);
    settingsView(view);
  };
  view.querySelector('#themes').onclick = async (e) => {
    const b = e.target.closest('[data-theme-id]');
    if (!b) return;
    await saveSettings({ theme: b.dataset.themeId });
    view.querySelectorAll('.theme-sw').forEach((x) => x.classList.toggle('active', x === b));
  };
  view.querySelector('#effects').onchange = (e) => saveSettings({ effects: e.target.value });
  view.querySelector('#intensity').oninput = (e) => saveSettings({ effects_intensity: +e.target.value });
  view.querySelector('#fmt').onchange = (e) => saveSettings({ audio_format: e.target.value });
  view.querySelector('#parallel').onchange = (e) => saveSettings({ max_parallel_downloads: +e.target.value });
  view.querySelector('#cbrowser').onchange = (e) => saveSettings({ cookies_browser: e.target.value });
  view.querySelector('#cookies').onchange =(e) => saveSettings({ cookies_file: e.target.value.trim() });
  view.querySelector('#crossfade').oninput = (e) => { player.crossfade = +e.target.value; view.querySelector('#cf-v').textContent = `${e.target.value}s`; player._save(); };
  view.querySelector('#shufmode').onchange = (e) => player.setShuffleMode(e.target.value);
  view.querySelector('#eqpreset').onchange = (e) => {
    player.setEq(EQ_PRESETS[e.target.value]);
    player.setEqEnabled(e.target.value !== 'flat');
    saveSettings({ eq_preset: e.target.value });
    settingsView(view);
  };
  view.querySelector('#backfill').onclick = () => { api.post('/api/lyrics/backfill'); toast('Looking up lyrics in the background…'); };
  view.querySelectorAll('[data-toggle]').forEach((b) => (b.onclick = async () => {
    const k = b.dataset.toggle, on = !b.classList.contains('on');
    b.classList.toggle('on', on);
    if (k === 'eq') player.setEqEnabled(on);
    else await saveSettings({ [k]: on });
  }));
}

// ------------------------------------------------------------ organizer
function bindOrganizer(view) {
  const status = view.querySelector('#org-status'), box = view.querySelector('#org-result');
  const poll = async () => {
    if (!view.isConnected) return;
    const st = await api.get('/api/organize');
    if (st.running) {
      status.innerHTML = `${icon('refresh', 14, 'spin')} Checking album ${st.done} of ${st.total}…`;
      setTimeout(poll, 700);
      return;
    }
    status.textContent = st.error ? `Error: ${st.error}` : '';
    if (st.plan) renderPlan(box, st.plan, view);
  };
  view.querySelector('#org-check').onclick = async () => {
    box.innerHTML = '';
    await api.post('/api/organize/plan');
    poll();
  };
  api.get('/api/organize').then((st) => { if (st.running || st.plan) poll(); });
}

function renderPlan(box, plan, view) {
  if (!plan.length) {
    box.innerHTML = `<div class="offline-note">${icon('check', 18)} Every album is already in order with no duplicates.</div>`;
    return;
  }
  const renames = plan.reduce((n, p) => n + p.renames.length, 0), dups = plan.reduce((n, p) => n + p.duplicates.length, 0);
  const src = { tags: 'from your tags', online: 'order looked up online', filenames: 'not found online — kept current order' };
  const base = (p) => p.split(/[\\/]/).pop();
  box.innerHTML = `<div class="row" style="margin-bottom:10px"><b>${plan.length} album${plan.length === 1 ? '' : 's'} to fix</b><span class="muted">${renames} file${renames === 1 ? '' : 's'} to rename • ${dups} duplicate${dups === 1 ? '' : 's'}</span>
      <span class="spacer"></span><button class="btn primary" id="org-apply">${icon('check', 16)} Apply all</button></div>
    <div class="org-list">${plan.map((p) => `<details class="org-album"><summary><b>${esc(p.title)}</b> <span class="muted">— ${esc(p.artist)}</span>
        <span class="pill">${p.renames.length} rename${p.renames.length === 1 ? '' : 's'}</span>${p.duplicates.length ? `<span class="pill" style="color:var(--warn)">${p.duplicates.length} duplicate${p.duplicates.length === 1 ? '' : 's'}</span>` : ''}
        <span class="faint" style="font-size:12px">${src[p.source]}</span></summary>
      ${p.renames.map((r) => `<div class="org-row"><span class="faint">${esc(base(r.old))}</span> → <b>${esc(base(r.new))}</b></div>`).join('')}
      ${p.duplicates.map((d) => `<div class="org-row" style="color:var(--warn)">${icon('trash', 13)} Duplicate: ${esc(base(d.path))} <span class="faint">(keeping ${esc(base(d.keep_path))})</span></div>`).join('')}
      </details>`).join('')}</div>`;
  box.querySelector('#org-apply').onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Renaming…';
    const r = await api.post('/api/organize/apply', {});
    box.innerHTML = `<div class="offline-note">${icon('check', 18)} Renamed ${r.renamed} files and removed ${r.duplicates_moved} duplicates.${r.errors.length ? ` ${r.errors.length} couldn't be changed (in use or read-only).` : ''}
      <span class="spacer"></span><button class="btn sm" id="org-undo">Undo</button></div>`;
    box.querySelector('#org-undo').onclick = async () => {
      await api.post('/api/organize/undo', { log: r.undo_log });
      toast('Restored the original file names');
      settingsView(view);
    };
  };
}
