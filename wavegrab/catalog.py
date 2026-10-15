"""Online music catalog (Deezer public API: keyless, rich covers and tracklists).

Everything returned is annotated with whether it's already in the local
library, so the UI can mark items that aren't saved yet.
Responses are cached on disk; if you're offline the cached copy is served.
"""
import hashlib
import json
import os
import re
import threading
import time

import httpx

from . import db
from .config import settings
from .scanner import norm, primary_artist

API = "https://api.deezer.com"
_client = None
_client_lock = threading.Lock()


def client():
    global _client
    with _client_lock:
        if _client is None:
            verify = os.environ.get("SSL_CERT_FILE") or os.environ.get("REQUESTS_CA_BUNDLE") or True
            _client = httpx.Client(timeout=15, verify=verify, follow_redirects=True,
                                   headers={"User-Agent": "WaveGrab/1.0 (local music player)"})
        return _client


class Offline(Exception):
    pass


def _get(path, params=None, ttl=3600):
    key = hashlib.sha1((path + json.dumps(params or {}, sort_keys=True)).encode()).hexdigest()
    cache = settings.catalog_cache / f"{key}.json"
    if cache.exists() and time.time() - cache.stat().st_mtime < ttl:
        return json.loads(cache.read_text("utf-8"))
    if not settings.get("online", True):
        if cache.exists():
            return json.loads(cache.read_text("utf-8"))
        raise Offline("Online features are turned off")
    try:
        r = client().get(API + path, params=params)
        r.raise_for_status()
        data = r.json()
        if isinstance(data, dict) and data.get("error"):
            raise Offline(str(data["error"].get("message", "catalog error")))
        cache.write_text(json.dumps(data), "utf-8")
        return data
    except (httpx.HTTPError, ValueError) as e:
        if cache.exists():
            return json.loads(cache.read_text("utf-8"))
        raise Offline(f"Can't reach the online catalog ({e.__class__.__name__})")


# ---------------------------------------------------------------- local index

def norm_title(t: str) -> str:
    t = re.sub(r"\s*[\(\[](feat|ft|with|prod)[^)\]]*[\)\]]", "", t or "", flags=re.I)
    t = re.sub(r"\s+-\s+.*(remaster|version|edit|mix|live|mono|stereo).*$", "", t, flags=re.I)
    t = re.sub(r"\s*[\(\[][^)\]]*(remaster|version|edit|mono|stereo)[^)\]]*[\)\]]", "", t, flags=re.I)
    return norm(t)


_idx = {"sig": None, "tracks": {}, "titles": {}, "albums": {}, "artists": {}}
_idx_lock = threading.Lock()


def local_index():
    sig = db.row("SELECT COUNT(*) c, MAX(id) m, (SELECT v FROM kv WHERE k='last_scan') s FROM tracks")
    sig = (sig["c"], sig["m"], sig["s"])
    with _idx_lock:
        if _idx["sig"] != sig:
            tracks, titles = {}, {}
            for r in db.rows("SELECT id, title, artist, album_artist FROM tracks"):
                nt = norm_title(r["title"])
                for a in {primary_artist(r["artist"]), r["album_artist"]}:
                    tracks[norm(a) + "|" + nt] = r["id"]
                titles.setdefault(nt, r["id"])
            _idx.update(sig=sig, tracks=tracks, titles=titles,
                        albums={a["norm"]: a["id"] for a in db.rows("SELECT id, norm FROM albums")},
                        artists={a["norm"]: a["id"] for a in db.rows("SELECT id, norm FROM artists")})
        return _idx


def match_track(artist, title):
    idx = local_index()
    return idx["tracks"].get(norm(primary_artist(artist)) + "|" + norm_title(title))


def match_album(artist, title):
    idx = local_index()
    return idx["albums"].get(norm(artist) + "|" + norm(title))


def match_artist(name):
    return local_index()["artists"].get(norm(name))


# ---------------------------------------------------------------- shaping

def _album(a, artist=None):
    art = a.get("artist") or artist or {}
    name = art.get("name", "")
    local_id = match_album(name, a.get("title", ""))
    return {
        "source": "deezer", "id": str(a["id"]), "title": a.get("title", ""),
        "artist": name, "artist_id": str(art.get("id", "")),
        "cover": a.get("cover_xl") or a.get("cover_big") or a.get("cover_medium") or "",
        "cover_small": a.get("cover_medium") or a.get("cover_small") or "",
        "year": (a.get("release_date") or "")[:4] or None,
        "release_date": a.get("release_date"),
        "type": a.get("record_type", "album"),
        "track_count": a.get("nb_tracks"),
        "explicit": a.get("explicit_lyrics", False),
        "local_id": local_id, "saved": bool(local_id),
    }


def _track(t, album=None):
    alb = t.get("album") or album or {}
    art = t.get("artist") or {}
    local_id = match_track(art.get("name", ""), t.get("title", ""))
    return {
        "source": "deezer", "id": str(t["id"]), "title": t.get("title", ""),
        "artist": art.get("name", ""), "artist_id": str(art.get("id", "")),
        "album": alb.get("title", ""), "album_id": str(alb.get("id", "")),
        "cover": alb.get("cover_xl") or alb.get("cover_big") or alb.get("cover_medium") or "",
        "cover_small": alb.get("cover_medium") or alb.get("cover_small") or "",
        "duration": t.get("duration"), "track_no": t.get("track_position"), "disc_no": t.get("disk_number"),
        "explicit": t.get("explicit_lyrics", False), "preview": t.get("preview"),
        "local_id": local_id, "saved": bool(local_id),
    }


def _artist(a):
    local_id = match_artist(a.get("name", ""))
    return {"source": "deezer", "id": str(a["id"]), "name": a.get("name", ""),
            "image": a.get("picture_xl") or a.get("picture_big") or a.get("picture_medium") or "",
            "image_small": a.get("picture_medium") or "",
            "fans": a.get("nb_fan"), "album_count": a.get("nb_album"),
            "local_id": local_id, "saved": bool(local_id)}


# ---------------------------------------------------------------- endpoints

def search(q, limit=12):
    albums = _get("/search/album", {"q": q, "limit": limit}, ttl=86400)
    artists = _get("/search/artist", {"q": q, "limit": 8}, ttl=86400)
    tracks = _get("/search/track", {"q": q, "limit": limit + 8}, ttl=86400)
    return {"albums": [_album(a) for a in albums.get("data", [])],
            "artists": [_artist(a) for a in artists.get("data", [])],
            "tracks": [_track(t) for t in tracks.get("data", [])]}


def album(album_id):
    a = _get(f"/album/{album_id}", ttl=7 * 86400)
    tracks = a.get("tracks", {}).get("data", [])
    # the embedded list caps at 25; fetch the full tracklist when needed
    if a.get("nb_tracks", 0) > len(tracks):
        tracks = _get(f"/album/{album_id}/tracks", {"limit": 500}, ttl=7 * 86400).get("data", [])
    out = _album(a)
    out["genre"] = ", ".join(g["name"] for g in a.get("genres", {}).get("data", []))
    out["label"] = a.get("label")
    out["duration"] = a.get("duration")
    out["contributors"] = [c.get("name") for c in a.get("contributors", [])]
    shaped = []
    for i, t in enumerate(tracks):
        t.setdefault("album", {"id": a["id"], "title": a["title"], "cover_xl": a.get("cover_xl"),
                               "cover_medium": a.get("cover_medium")})
        st = _track(t)
        st["track_no"] = st["track_no"] or i + 1
        st["disc_no"] = st["disc_no"] or 1
        st["album_artist"] = out["artist"]
        shaped.append(st)
    out["tracks"] = shaped
    saved = sum(1 for t in shaped if t["saved"])
    out["saved_tracks"] = saved
    out["saved"] = bool(shaped) and saved == len(shaped)
    out["partial"] = 0 < saved < len(shaped)
    return out


def artist(artist_id):
    a = _get(f"/artist/{artist_id}", ttl=7 * 86400)
    top = _get(f"/artist/{artist_id}/top", {"limit": 10}, ttl=86400)
    albums = _get(f"/artist/{artist_id}/albums", {"limit": 100}, ttl=86400)
    related = _get(f"/artist/{artist_id}/related", {"limit": 12}, ttl=7 * 86400)
    out = _artist(a)
    out["top_tracks"] = [_track(t) for t in top.get("data", [])]
    alb = [_album(x, a) for x in albums.get("data", [])]
    alb.sort(key=lambda x: x.get("release_date") or "", reverse=True)
    out["albums"] = alb
    out["related"] = [_artist(x) for x in related.get("data", [])]
    if out["local_id"] and out["image"]:
        with db.tx() as c:
            c.execute("INSERT OR REPLACE INTO kv(k, v) VALUES (?, ?)", (f"artist_img:{out['local_id']}", out["image"]))
            c.execute("UPDATE artists SET image_url=? WHERE id=?", (out["image"], out["local_id"]))
    return out


def find_artist(name):
    """Best Deezer artist for a local artist name."""
    res = _get("/search/artist", {"q": name, "limit": 5}, ttl=7 * 86400).get("data", [])
    for a in res:
        if norm(a["name"]) == norm(name):
            return a
    return res[0] if res else None


def find_album(artist_name, title):
    """Best catalog album for a local album; None rather than a wrong guess."""
    data = []
    for q in (f'artist:"{artist_name}" album:"{title}"', f"{artist_name} {title}"):
        data = _get("/search/album", {"q": q, "limit": 10}, ttl=7 * 86400).get("data", [])
        if data:
            break
    na, nt = norm(artist_name), norm(title)
    same_artist = [a for a in data if norm(a["artist"]["name"]) == na]
    for a in same_artist:
        if norm(a["title"]) == nt:
            return a
    for a in same_artist:
        if nt in norm(a["title"]) or norm(a["title"]) in nt:
            return a
    return None


def charts():
    data = _get("/chart/0", ttl=6 * 3600)
    return {"albums": [_album(a) for a in data.get("albums", {}).get("data", [])],
            "tracks": [_track(t) for t in data.get("tracks", {}).get("data", [])],
            "artists": [_artist(a) for a in data.get("artists", {}).get("data", [])]}


def genres():
    return [{"id": g["id"], "name": g["name"], "picture": g.get("picture_big")}
            for g in _get("/genre", ttl=7 * 86400).get("data", []) if g["id"]]


def genre_albums(genre_id):
    data = _get(f"/chart/{genre_id}/albums", {"limit": 30}, ttl=6 * 3600)
    return [_album(a) for a in data.get("data", [])]


def new_from_your_artists(limit_artists=12, max_age_days=365):
    """Recent releases by artists in the local library."""
    top = db.rows("SELECT name, id FROM artists ORDER BY track_count DESC LIMIT ?", (limit_artists,))
    cutoff = time.strftime("%Y-%m-%d", time.localtime(time.time() - max_age_days * 86400))
    out = []
    for a in top:
        try:
            dz = find_artist(a["name"])
            if not dz:
                continue
            albums = _get(f"/artist/{dz['id']}/albums", {"limit": 10}, ttl=86400).get("data", [])
        except Offline:
            break
        for x in albums:
            if (x.get("release_date") or "") >= cutoff:
                out.append(_album(x, dz))
    out.sort(key=lambda x: x.get("release_date") or "", reverse=True)
    seen, uniq = set(), []
    for x in out:
        if x["id"] not in seen:
            seen.add(x["id"])
            uniq.append(x)
    return uniq[:24]


def remember_release(local_album_id, catalog_album):
    """Store the catalog's release type and track count for a local album."""
    rtype = catalog_album.get("type") or catalog_album.get("record_type") or ""
    total = catalog_album.get("track_count") or catalog_album.get("nb_tracks") or len(catalog_album.get("tracks") or [])
    with db.tx() as c:
        c.execute("INSERT OR REPLACE INTO kv(k, v) VALUES (?, ?)", (f"release:{local_album_id}", f"{rtype}|{total or ''}"))


def learn_release_types(limit=300):
    """After a scan: look up albums whose files don't say album / EP / single,
    so a partly-downloaded album (3 of 12 songs) isn't mistaken for a single,
    and so we know how many songs it's missing. Each album is looked up once."""
    if not settings.get("online", True):
        return
    from .scanner import rebuild_aggregates
    todo = db.rows("""SELECT a.id, a.title, a.artist FROM albums a
                      WHERE a.track_count > 1
                        AND NOT EXISTS (SELECT 1 FROM kv WHERE kv.k = 'release:' || a.id)
                      LIMIT ?""", (limit,))
    changed = 0
    for a in todo:
        try:
            found = find_album(a["artist"], a["title"])
        except Offline:
            return
        except Exception:  # noqa: BLE001 - one bad lookup shouldn't stop the rest
            found = None
        if found:
            remember_release(a["id"], found)
        else:
            with db.tx() as c:  # not in the catalog: don't ask again
                c.execute("INSERT OR REPLACE INTO kv(k, v) VALUES (?, '|')", (f"release:{a['id']}",))
        changed += 1
    if changed:
        with db.tx() as c:
            rebuild_aggregates(c)
        from . import events
        events.publish("library", {"reason": "release-types"})
