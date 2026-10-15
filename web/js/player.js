// Audio engine: two <audio> elements (current + preloaded next) routed through
// a Web Audio graph:  element -> fade gain -> preamp -> 10 biquad EQ bands
//                     -> volume -> analyser -> speakers
// BiquadFilterNode implements the RBJ "Audio EQ Cookbook" filters natively.

import { api } from './api.js';
import { shuffle as shuffleTracks } from './shuffle.js';

export const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'bass boost': [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  'bass reducer': [-6, -5, -4, -2, 0, 0, 0, 0, 0, 0],
  'treble boost': [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  vocal: [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1],
  rock: [4, 3, 2, 0, -1, -1, 1, 3, 4, 4],
  electronic: [5, 4, 1, 0, -2, 1, 0, 2, 4, 5],
  'hip-hop': [5, 4, 1, 2, -1, -1, 1, 0, 2, 3],
  acoustic: [3, 3, 2, 1, 1, 1, 2, 3, 2, 1],
  loudness: [6, 4, 0, 0, -2, 0, -1, -2, 4, 2],
  'late night': [3, 2, 1, 0, -1, -2, -2, -1, 0, 0],
};

class Player extends EventTarget {
  constructor() {
    super();
    this.els = [new Audio(), new Audio()];
    this.els.forEach((el) => { el.preload = 'auto'; el.crossOrigin = 'anonymous'; });
    this.cur = 0;            // index of the active element
    this.context = [];       // tracks in their original order
    this.order = [];         // indices into context, in play order
    this.pos = -1;           // position in order
    this.userQueue = [];     // "Next in queue" (play next / add to queue)
    this.current = null;     // playing track
    this.fromUserQueue = false;
    this.repeat = 'off';     // off | all | one
    this.shuffleOn = false;
    this.shuffleMode = 'fewer_repeats';
    this.volume = 0.8;
    this.muted = false;
    this.crossfade = 0;
    this.eqEnabled = false;
    this.eqGains = EQ_PRESETS.flat.slice();
    this.ctxInfo = null;     // {type, id, name}
    this.ctx = null;
    this.counted = false;
    this.fading = false;
    this.preloadedId = null;
    this._bind();
    this._restore();
  }

  // ------------------------------------------------------------ audio graph
  _ensureGraph() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'playback' });
    const c = this.ctx;
    this.fades = this.els.map((el) => {
      const src = c.createMediaElementSource(el);
      const g = c.createGain();
      src.connect(g);
      return g;
    });
    this.preamp = c.createGain();
    this.fades.forEach((g) => g.connect(this.preamp));
    this.bands = EQ_FREQS.map((f, i) => {
      const b = c.createBiquadFilter();
      b.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
      b.frequency.value = f;
      b.Q.value = 1.1;
      b.gain.value = 0;
      return b;
    });
    let node = this.preamp;
    for (const b of this.bands) { node.connect(b); node = b; }
    this.master = c.createGain();
    node.connect(this.master);
    this.analyser = c.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.8;
    this.master.connect(this.analyser);
    this.analyser.connect(c.destination);
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
    this.timeData = new Uint8Array(this.analyser.fftSize);
    this._applyVolume();
    this._applyEq();
  }

  // 0..1 bass / mid / treble energy for visual effects
  levels() {
    if (!this.analyser || this.paused) return { bass: 0, mid: 0, treble: 0, level: 0 };
    this.analyser.getByteFrequencyData(this.freqData);
    const d = this.freqData, n = d.length, hz = this.ctx.sampleRate / 2 / n;
    const avg = (lo, hi) => {
      let s = 0, c = 0;
      for (let i = Math.floor(lo / hz); i < Math.min(n, Math.ceil(hi / hz)); i++) { s += d[i]; c++; }
      return c ? s / c / 255 : 0;
    };
    const bass = avg(20, 160), mid = avg(160, 2500), treble = avg(2500, 12000);
    return { bass, mid, treble, level: (bass * 2 + mid + treble) / 4 };
  }

  _applyVolume() {
    const v = this.muted ? 0 : this.volume ** 1.6; // perceptual curve
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
    else this.els.forEach((e) => (e.volume = v));
  }

  _applyEq() {
    if (!this.bands) return;
    const t = this.ctx.currentTime;
    const gains = this.eqEnabled ? this.eqGains : EQ_PRESETS.flat;
    // ramp (not jump) so dragging a slider never clicks
    this.bands.forEach((b, i) => b.gain.setTargetAtTime(gains[i], t, 0.03));
    const maxBoost = Math.max(0, ...gains);
    this.preamp.gain.setTargetAtTime(Math.pow(10, (-maxBoost * 0.6) / 20), t, 0.03);
  }

  setEq(gains) { this.eqGains = gains.slice(); this._applyEq(); this._save(); }
  setEqEnabled(on) { this.eqEnabled = on; this._applyEq(); this._save(); }

  // ------------------------------------------------------------ element events
  get el() { return this.els[this.cur]; }
  get other() { return this.els[1 - this.cur]; }
  get paused() { return this.el.paused; }
  get time() { return this.el.src ? this.el.currentTime || 0 : this._restoreTime || 0; }
  get duration() { return this.el.duration || this.current?.duration || 0; }

  _bind() {
    this.els.forEach((el, i) => {
      el.addEventListener('timeupdate', () => { if (i === this.cur) this._onTime(); });
      el.addEventListener('ended', () => { if (i === this.cur) this._onEnded(); });
      el.addEventListener('play', () => { if (i === this.cur) this._emit('state'); });
      el.addEventListener('pause', () => { if (i === this.cur) this._emit('state'); });
      el.addEventListener('error', () => {
        if (i !== this.cur || !this.current) return;
        this._emit('error', { track: this.current, message: el.error?.message || 'Playback failed' });
      });
    });
    if ('mediaSession' in navigator) {
      const ms = navigator.mediaSession;
      ms.setActionHandler('play', () => this.play());
      ms.setActionHandler('pause', () => this.pause());
      ms.setActionHandler('nexttrack', () => this.next());
      ms.setActionHandler('previoustrack', () => this.prev());
      ms.setActionHandler('seekto', (d) => this.seek(d.seekTime));
    }
    setInterval(() => this._save(), 5000);
  }

  _onTime() {
    const t = this.time, d = this.duration;
    this._emit('time');
    if (!this.counted && this.current && (t > 30 || (d && t > d * 0.5))) {
      this.counted = true;
      api.post(`/api/tracks/${this.current.id}/played`).catch(() => {});
    }
    if (d && !this.preloadedId && d - t < 30) this._preloadNext();
    if (this.crossfade > 0 && d && !this.fading && this.repeat !== 'one' && d - t <= this.crossfade && d > this.crossfade * 2) {
      const nxt = this._peekNext();
      if (nxt) this._crossfadeTo(nxt);
    }
  }

  _onEnded() {
    if (this.fading) return;
    if (this.repeat === 'one') { this.seek(0); this.play(); return; }
    const nxt = this._advance();
    if (nxt) this._start(nxt, 0, true);
    else { this._emit('state'); }
  }

  // ------------------------------------------------------------ queue logic
  _peekNext() {
    if (this.userQueue.length) return this.userQueue[0];
    if (this.pos + 1 < this.order.length) return this.context[this.order[this.pos + 1]];
    if (this.repeat === 'all' && this.order.length) return this.context[this.order[0]];
    return null;
  }

  _advance() {
    if (this.userQueue.length) { this.fromUserQueue = true; return this.userQueue.shift(); }
    this.fromUserQueue = false;
    if (this.pos + 1 < this.order.length) { this.pos++; return this.context[this.order[this.pos]]; }
    if (this.repeat === 'all' && this.order.length) {
      if (this.shuffleOn) this._reshuffle(null);
      this.pos = 0;
      return this.context[this.order[0]];
    }
    return null;
  }

  _preloadNext() {
    const n = this._peekNext();
    if (!n) return;
    this.preloadedId = n.id;
    const o = this.other;
    if (!o.src.endsWith(`/api/stream/${n.id}`)) { o.src = `/api/stream/${n.id}`; o.load(); }
  }

  async _start(track, startAt = 0, autoplay = true) {
    this._ensureGraph();
    this.fading = false;
    const reuse = this.other.src.endsWith(`/api/stream/${track.id}`);
    if (reuse) {
      // gapless-ish: the next track is already buffered in the other element
      this.el.pause();
      this.cur = 1 - this.cur;
    } else {
      this.el.pause();
      this.el.src = `/api/stream/${track.id}`;
    }
    if (this.fades) {
      const t = this.ctx.currentTime;
      this.fades[this.cur].gain.cancelScheduledValues(t);
      this.fades[this.cur].gain.setValueAtTime(1, t);
      this.fades[1 - this.cur].gain.setValueAtTime(0, t);
    }
    this.other.pause();
    this.current = track;
    this.counted = false;
    this.preloadedId = null;
    if (startAt) {
      const el = this.el;
      const seekWhenReady = () => { el.currentTime = startAt; };
      if (el.readyState >= 1) seekWhenReady(); else el.addEventListener('loadedmetadata', seekWhenReady, { once: true });
    } else if (reuse) {
      this.el.currentTime = 0;
    }
    this._updateMediaSession();
    this._emit('track');
    this._emit('queue');
    if (autoplay) {
      try { await this.el.play(); } catch (e) { if (e.name !== 'AbortError') console.warn(e); }
    }
    this._save();
  }

  _crossfadeTo(track) {
    this._ensureGraph();
    this.fading = true;
    this._advance();
    const o = this.other, t = this.ctx.currentTime, d = this.crossfade;
    if (!o.src.endsWith(`/api/stream/${track.id}`)) o.src = `/api/stream/${track.id}`;
    o.currentTime = 0;
    o.play().catch(() => {});
    const outG = this.fades[this.cur].gain, inG = this.fades[1 - this.cur].gain;
    outG.cancelScheduledValues(t); inG.cancelScheduledValues(t);
    outG.setValueAtTime(outG.value, t); outG.linearRampToValueAtTime(0, t + d);
    inG.setValueAtTime(0, t); inG.linearRampToValueAtTime(1, t + d);
    const old = this.el;
    setTimeout(() => old.pause(), d * 1000 + 100);
    this.cur = 1 - this.cur;
    this.current = track;
    this.counted = false;
    this.preloadedId = null;
    this.fading = false;
    this._updateMediaSession();
    this._emit('track');
    this._emit('queue');
  }

  _reshuffle(keepIdx) {
    const idx = this.context.map((_, i) => i).filter((i) => i !== keepIdx);
    const recency = this._recency || {};
    const shuffled = shuffleTracks(idx.map((i) => ({ ...this.context[i], _i: i })), this.shuffleMode, recency)
      .map((t) => t._i);
    this.order = keepIdx == null ? shuffled : [keepIdx, ...shuffled];
  }

  // ------------------------------------------------------------ public API
  async playList(tracks, startIndex = 0, opts = {}) {
    if (!tracks.length) return;
    this.context = tracks.slice();
    this.ctxInfo = opts.context || null;
    if (opts.shuffle !== undefined) this.shuffleOn = opts.shuffle;
    if (this.shuffleOn) {
      if (this.shuffleMode === 'fewer_repeats') {
        try { this._recency = await api.get('/api/recency'); } catch { this._recency = {}; }
      }
      const start = opts.shuffle && startIndex === 0 && !opts.keepStart ? null : startIndex;
      this._reshuffle(start);
    } else {
      this.order = tracks.map((_, i) => i);
    }
    this.pos = this.shuffleOn ? 0 : startIndex;
    this.fromUserQueue = false;
    this.preloadedId = null;
    this.other.removeAttribute('src');
    await this._start(this.context[this.order[this.pos]], (opts.startAtMs || 0) / 1000);
  }

  play() {
    this._ensureGraph();
    if (!this.current) return;
    if (!this.el.src) {
      const t = this._restoreTime || 0;
      this._restoreTime = 0;
      return this._start(this.current, t);
    }
    this.el.play().catch(() => {});
  }
  pause() { this.el.pause(); }
  toggle() { this.paused ? this.play() : this.pause(); }

  next() {
    const n = this._advance();
    if (n) this._start(n, 0, true);
  }

  prev() {
    if (this.time > 3 || this.pos <= 0) { this.seek(0); return; }
    this.pos--;
    this._start(this.context[this.order[this.pos]], 0, true);
  }

  seek(sec) {
    if (!this.el.src && this.current) { this._start(this.current, sec, false); return; }
    this.el.currentTime = Math.max(0, Math.min(sec, this.duration || sec));
    this.fading = false;
    this._emit('time');
  }

  setVolume(v) { this.volume = Math.max(0, Math.min(1, v)); this.muted = false; this._applyVolume(); this._emit('volume'); this._save(); }
  toggleMute() { this.muted = !this.muted; this._applyVolume(); this._emit('volume'); }

  async toggleShuffle() {
    this.shuffleOn = !this.shuffleOn;
    const curIdx = this.order[this.pos];
    if (this.shuffleOn) {
      if (this.shuffleMode === 'fewer_repeats') {
        try { this._recency = await api.get('/api/recency'); } catch { this._recency = {}; }
      }
      this._reshuffle(curIdx);
      this.pos = 0;
    } else {
      this.order = this.context.map((_, i) => i);
      this.pos = curIdx ?? 0;
    }
    this.preloadedId = null;
    this._emit('queue');
    this._emit('mode');
    this._save();
  }

  setShuffleMode(mode) {
    this.shuffleMode = mode;
    if (this.shuffleOn) { this.shuffleOn = false; this.toggleShuffle(); }
    this._emit('mode');
    this._save();
  }

  cycleRepeat() {
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
    this.preloadedId = null;
    this._emit('mode');
    this._save();
  }

  playNext(tracks) { this.userQueue.unshift(...tracks); this.preloadedId = null; this._emit('queue'); this._save(); }
  addToQueue(tracks) { this.userQueue.push(...tracks); this.preloadedId = null; this._emit('queue'); this._save(); }

  // upcoming = user queue, then the rest of the context
  upcoming(limit = 200) {
    const rest = [];
    for (let i = this.pos + 1; i < this.order.length && rest.length < limit; i++) rest.push(this.context[this.order[i]]);
    return { user: this.userQueue.slice(), rest };
  }

  removeUpcoming(kind, i) {
    if (kind === 'user') this.userQueue.splice(i, 1);
    else this.order.splice(this.pos + 1 + i, 1);
    this.preloadedId = null;
    this._emit('queue');
    this._save();
  }

  moveUpcoming(kind, from, to) {
    if (kind === 'user') {
      const [x] = this.userQueue.splice(from, 1);
      this.userQueue.splice(to, 0, x);
    } else {
      const base = this.pos + 1;
      const [x] = this.order.splice(base + from, 1);
      this.order.splice(base + to, 0, x);
    }
    this.preloadedId = null;
    this._emit('queue');
    this._save();
  }

  jumpTo(kind, i) {
    if (kind === 'user') {
      const [t] = this.userQueue.splice(i, 1);
      this.userQueue.splice(0, i); // skipping ahead drops the ones before it
      this._start(t, 0, true);
    } else {
      this.pos = this.pos + 1 + i;
      this._start(this.context[this.order[this.pos]], 0, true);
    }
  }

  clearQueue() { this.userQueue = []; this.order = this.order.slice(0, this.pos + 1); this._emit('queue'); this._save(); }

  // ------------------------------------------------------------ persistence
  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  _updateMediaSession() {
    if (!('mediaSession' in navigator) || !this.current) return;
    const t = this.current;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist, album: t.album,
      artwork: [{ src: t.cover, sizes: '512x512', type: 'image/jpeg' }],
    });
    document.title = `${t.title} · ${t.artist}`;
  }

  _save() {
    try {
      const slim = (t) => t && ({ id: t.id, title: t.title, artist: t.artist, album: t.album, album_id: t.album_id,
        artist_id: t.artist_id, duration: t.duration, cover: t.cover, liked_at: t.liked_at });
      localStorage.setItem('wg.player', JSON.stringify({
        context: this.context.length > 3000 ? [] : this.context.map(slim), order: this.order, pos: this.pos,
        userQueue: this.userQueue.map(slim), current: slim(this.current), time: this.time,
        repeat: this.repeat, shuffleOn: this.shuffleOn, shuffleMode: this.shuffleMode, volume: this.volume,
        crossfade: this.crossfade, eqEnabled: this.eqEnabled, eqGains: this.eqGains, ctxInfo: this.ctxInfo,
      }));
    } catch { /* storage unavailable */ }
  }

  _restore() {
    let s;
    try { s = JSON.parse(localStorage.getItem('wg.player') || 'null'); } catch { s = null; }
    if (!s) return;
    Object.assign(this, {
      context: s.context || [], order: s.order || [], pos: s.pos ?? -1, userQueue: s.userQueue || [],
      current: s.current || null, repeat: s.repeat || 'off', shuffleOn: !!s.shuffleOn,
      shuffleMode: s.shuffleMode || 'fewer_repeats', volume: s.volume ?? 0.8, crossfade: s.crossfade || 0,
      eqEnabled: !!s.eqEnabled, eqGains: s.eqGains || EQ_PRESETS.flat.slice(), ctxInfo: s.ctxInfo || null,
    });
    if (this.order.length !== this.context.length) { this.order = this.context.map((_, i) => i); }
    this._restoreTime = s.time || 0;
    this._applyVolume();
  }
}

export const player = new Player();
window.wgPlayer = player; // handy for debugging in devtools
