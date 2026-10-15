"""LRCLIB lyric lookup (https://lrclib.net), two-stage as the report recommends:

1. /api/get   exact match on artist + track + album + duration
2. /api/search fallback without the strict album filter, scored by
   synced-lyrics availability and closeness of duration

LRCLIB can take 7-10 s per query, so the timeout is 20 s. Rate-limit
responses aren't guaranteed to be JSON, so status codes are checked first.
"""
import os
import threading
import time
from pathlib import Path

import httpx

from . import db, events

BASE = "https://lrclib.net/api"
_lock = threading.Lock()
_retry_after = 0.0


def _client():
    verify = os.environ.get("SSL_CERT_FILE") or True
    return httpx.Client(timeout=20, verify=verify,
                        headers={"User-Agent": "WaveGrab/1.0 (https://github.com/TheToxicDog/WaveRepo)"})


def _call(c, path, params):
    global _retry_after
    wait = _retry_after - time.time()
    if wait > 0:
        time.sleep(min(wait, 30))
    r = c.get(BASE + path, params=params)
    if r.status_code == 429:
        try:
            _retry_after = time.time() + float(r.headers.get("Retry-After", "10"))
        except ValueError:
            _retry_after = time.time() + 10
        return None
    if r.status_code != 200:
        return None
    try:
        return r.json()
    except ValueError:
        return None


def fetch(title, artist, album="", duration=0):
    """Return LRC/plain lyric text or None."""
    with _client() as c:
        try:
            params = {"track_name": title, "artist_name": artist}
            if album:
                params["album_name"] = album
            if duration:
                params["duration"] = int(round(duration))
            exact = _call(c, "/get", params)
            if exact and (exact.get("syncedLyrics") or exact.get("plainLyrics")):
                if exact.get("syncedLyrics"):
                    return exact["syncedLyrics"]
                plain_fallback = exact.get("plainLyrics")
            else:
                plain_fallback = None
            cands = _call(c, "/search", {"track_name": title, "artist_name": artist}) or []
            cands = [x for x in cands if x.get("syncedLyrics") or x.get("plainLyrics")]
            if cands:
                def score(x):
                    d = abs((x.get("duration") or duration or 0) - (duration or 0)) if duration else 0
                    return (0 if x.get("syncedLyrics") else 1, d)
                best = min(cands, key=score)
                if not duration or abs((best.get("duration") or duration) - duration) < 8:
                    return best.get("syncedLyrics") or best.get("plainLyrics")
            return plain_fallback
        except httpx.HTTPError:
            return None


def fetch_for_track(track_id: int) -> bool:
    """Look up lyrics for a library track and write a .lrc sidecar next to it."""
    t = db.row("SELECT * FROM tracks WHERE id=?", (track_id,))
    if not t:
        return False
    text = fetch(t["title"], t["artist"], t["album"], t["duration"])
    if not text:
        return False
    path = Path(t["path"])
    lrc = path.with_suffix(".lrc")
    try:
        lrc.write_text(text, "utf-8")
    except OSError:
        return False
    from .scanner import index_single
    index_single(path)
    events.publish("lyrics", {"track_id": track_id})
    return True


def backfill(limit=200):
    """Fetch lyrics for tracks that have none (runs in the background)."""
    def run():
        with _lock:
            todo = db.rows("SELECT id FROM tracks WHERE lyrics_plain='' ORDER BY play_count DESC, added_at DESC "
                           "LIMIT ?", (limit,))
            for i, t in enumerate(todo):
                fetch_for_track(t["id"])
                events.publish("lyrics_backfill", {"done": i + 1, "total": len(todo)})
    threading.Thread(target=run, daemon=True).start()
