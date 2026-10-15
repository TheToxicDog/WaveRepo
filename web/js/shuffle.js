// Shuffle algorithms (see docs/ARCHITECTURE.md, "Shuffle").
//  standard       Fisher-Yates: every order equally likely
//  balanced       Spotify-2014 style spread: each artist's songs spaced ~1/k apart
//                 with a random offset + jitter, songs from one album separated
//  fewer_repeats  many random Fisher-Yates candidates, keep the one whose opening
//                 has the fewest recently played songs (freshness score)

export function fisherYates(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function groupBy(arr, key) {
  const m = new Map();
  for (const x of arr) {
    const k = key(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

// spread items of one group over [0,1)
function spread(items, posOut, inner) {
  const k = items.length;
  const ordered = inner ? inner(items) : fisherYates(items);
  const offset = Math.random() / k;
  ordered.forEach((it, i) => {
    const jitter = (Math.random() - 0.5) * (0.2 / k);
    posOut.push([offset + i / k + jitter, it]);
  });
}

export function balanced(tracks) {
  const byArtist = groupBy(tracks, (t) => (t.artist || '').toLowerCase());
  const pos = [];
  for (const items of byArtist.values()) {
    // within an artist, spread albums too, so two songs from one album aren't adjacent
    spread(items, pos, (list) => {
      const byAlbum = groupBy(list, (t) => t.album_id || t.album);
      const inner = [];
      for (const al of byAlbum.values()) spread(al, inner);
      return inner.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    });
  }
  return pos.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
}

// F(S) = 1 - 1/N * sum( w_pos(i) * w_rec(t_i) )
// w_pos(i) = exp(-l1 (i-1))   penalise the start of the queue most
// w_rec(t) = exp(-l2 * hours since played)
export function freshness(seq, recency, now = Date.now() / 1000, l1 = 0.08, l2 = 1 / 48) {
  let pen = 0;
  const n = Math.min(seq.length, 60); // only the opening matters in practice
  for (let i = 0; i < n; i++) {
    const last = recency[seq[i].id];
    if (!last) continue;
    const hours = Math.max(0, (now - last) / 3600);
    pen += Math.exp(-l1 * i) * Math.exp(-l2 * hours);
  }
  return 1 - pen / Math.max(1, n);
}

export function fewerRepeats(tracks, recency, candidates = 24) {
  let best = null, bestScore = -Infinity;
  for (let c = 0; c < candidates; c++) {
    const s = fisherYates(tracks);
    const f = freshness(s, recency);
    if (f > bestScore) { bestScore = f; best = s; }
  }
  return best;
}

export function shuffle(tracks, mode, recency = {}) {
  if (mode === 'balanced') return balanced(tracks);
  if (mode === 'fewer_repeats') return fewerRepeats(tracks, recency);
  return fisherYates(tracks);
}
