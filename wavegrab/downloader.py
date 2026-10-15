"""Download queue + worker (the WaveGrab engine).

Queue items live in the `downloads` table so the queue survives restarts.
The worker:
  1. finds the best YouTube match for "artist - title" (duration-scored,
     prefers YouTube Music "- Topic" uploads and official audio)
  2. downloads it with yt-dlp and converts to the chosen format
  3. tags it (title/artist/album/track/disc/year/genre/cover) with mutagen
  4. fetches lyrics from LRCLIB and writes a .lrc sidecar
  5. moves it into  <download_dir>/<Album Artist>/<Album>/<NN Title>.ext
     and adds it to the library index immediately
"""
import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path

import httpx

from . import catalog, db, events, lyrics, scanner
from .config import settings

try:
    import yt_dlp
    from yt_dlp.utils import DownloadCancelled
except ImportError:  # pragma: no cover
    yt_dlp = None

    class DownloadCancelled(Exception):
        pass

ACTIVE = ("downloading", "processing")
_claim_lock = threading.Lock()
_cancel = set()
_workers = []
_wake = threading.Event()
_stop = threading.Event()

BAD_WORDS = ("live", "cover", "remix", "karaoke", "instrumental", "sped up", "slowed", "8d", "reaction",
             "nightcore", "reverb", "lyrics video", "1 hour", "loop", "tutorial", "bass boosted", "acapella")


# ------------------------------------------------------------------ queue API

def _now():
    return int(time.time())


def _next_pos():
    return (db.scalar("SELECT MAX(position) FROM downloads") or 0) + 1


def _publish_queue():
    events.publish("queue", {"items": queue_list()})


def queue_list(include_done=True):
    sql = "SELECT * FROM downloads"
    if not include_done:
        sql += " WHERE status NOT IN ('done')"
    sql += " ORDER BY CASE status WHEN 'done' THEN 2 WHEN 'error' THEN 1 ELSE 0 END, " \
           "CASE WHEN status='done' THEN -finished_at ELSE position END"
    return db.rows(sql)


def is_paused():
    return db.scalar("SELECT v FROM kv WHERE k='queue_paused'") == "1"


def set_paused(paused: bool):
    with db.tx() as c:
        c.execute("INSERT OR REPLACE INTO kv(k, v) VALUES ('queue_paused', ?)", ("1" if paused else "0",))
    if not paused:
        _wake.set()
    events.publish("queue_state", {"paused": paused})


def enqueue(items: list[dict], group_title="") -> list[int]:
    """items: dicts with title, artist, album, album_artist, track_no, disc_no,
    year, genre, duration, cover_url, catalog_id, source_url, kind."""
    gid = uuid.uuid4().hex[:10] if len(items) > 1 else ""
    ids = []
    with db.tx() as c:
        pos = (c.execute("SELECT MAX(position) FROM downloads").fetchone()[0] or 0) + 1
        for it in items:
            # skip duplicates already waiting in the queue
            if it.get("catalog_id"):
                dup = c.execute("SELECT id FROM downloads WHERE catalog_id=? AND status IN "
                                "('queued','downloading','processing','paused')", (it["catalog_id"],)).fetchone()
                if dup:
                    continue
            cur = c.execute(
                """INSERT INTO downloads(position, status, kind, title, artist, album, album_artist, track_no,
                   disc_no, year, genre, duration, cover_url, catalog_id, source_url, group_id, group_title,
                   created_at) VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (pos, it.get("kind", "track"), it.get("title") or it.get("source_url") or "Unknown",
                 it.get("artist", ""), it.get("album", ""), it.get("album_artist") or it.get("artist", ""),
                 it.get("track_no"), it.get("disc_no"), _int(it.get("year")), it.get("genre", ""),
                 it.get("duration"), it.get("cover_url", ""), str(it.get("catalog_id") or ""),
                 it.get("source_url", ""), gid, group_title, _now()))
            ids.append(cur.lastrowid)
            pos += 1
    _wake.set()
    _publish_queue()
    return ids


def _int(v):
    try:
        return int(str(v)[:4])
    except (TypeError, ValueError):
        return None


def enqueue_album(album_id: str, only_missing=True):
    a = catalog.album(album_id)
    items = []
    for t in a["tracks"]:
        if only_missing and t["saved"]:
            continue
        items.append(dict(title=t["title"], artist=t["artist"], album=a["title"], album_artist=a["artist"],
                          track_no=t["track_no"], disc_no=t["disc_no"], year=a["year"], genre=a.get("genre", ""),
                          duration=t["duration"], cover_url=a["cover"], catalog_id=t["id"]))
    return enqueue(items, group_title=f"{a['artist']} — {a['title']}")


def enqueue_track(track_id: str):
    t = catalog._get(f"/track/{track_id}", ttl=7 * 86400)
    alb = t.get("album", {})
    try:
        full = catalog.album(alb["id"]) if alb.get("id") else {}
    except catalog.Offline:
        full = {}
    return enqueue([dict(title=t["title"], artist=t["artist"]["name"], album=alb.get("title", ""),
                         album_artist=full.get("artist") or t["artist"]["name"],
                         track_no=t.get("track_position"), disc_no=t.get("disk_number"),
                         year=(t.get("release_date") or "")[:4], genre=full.get("genre", ""),
                         duration=t.get("duration"), cover_url=alb.get("cover_xl") or alb.get("cover_big", ""),
                         catalog_id=str(t["id"]))])


def enqueue_url(url: str, mode="audio"):
    """Paste-a-link downloads (WaveGrab classic): YouTube / YouTube Music /
    SoundCloud / Bandcamp... Playlists are expanded into separate items.
    Spotify links are handed to spotDL when it's installed."""
    url = url.strip()
    if "open.spotify.com" in url or url.startswith("spotify:"):
        return enqueue([dict(kind="spotdl", title=url, source_url=url)])
    kind = "video" if mode == "video" else "url"
    if yt_dlp is None:
        raise RuntimeError("yt-dlp is not installed")
    with yt_dlp.YoutubeDL({"quiet": True, "extract_flat": "in_playlist", "skip_download": True,
                           **_net_opts()}) as ydl:
        info = ydl.extract_info(url, download=False)
    entries = info.get("entries")
    if entries:
        items = []
        for e in entries:
            if not e:
                continue
            u = e.get("url") or e.get("webpage_url")
            if u and not u.startswith("http"):
                u = f"https://www.youtube.com/watch?v={e.get('id')}"
            items.append(dict(kind=kind, title=e.get("track") or e.get("title") or u,
                              artist=e.get("artist") or e.get("uploader") or "", source_url=u,
                              duration=e.get("duration")))
        return enqueue(items, group_title=info.get("title") or "Playlist")
    return enqueue([dict(kind=kind, title=info.get("track") or info.get("title") or url,
                         artist=info.get("artist") or info.get("uploader") or "",
                         album=info.get("album") or "", duration=info.get("duration"), source_url=url,
                         cover_url=info.get("thumbnail") or "")])


def reorder(ids: list[int]):
    with db.tx() as c:
        for i, did in enumerate(ids):
            c.execute("UPDATE downloads SET position=? WHERE id=?", (i + 1, did))
    _publish_queue()


def move(did: int, where: str):
    with db.tx() as c:
        if where == "top":
            p = (c.execute("SELECT MIN(position) FROM downloads WHERE status IN ('queued','paused')").fetchone()[0] or 1) - 1
        else:
            p = (c.execute("SELECT MAX(position) FROM downloads").fetchone()[0] or 0) + 1
        c.execute("UPDATE downloads SET position=? WHERE id=?", (p, did))
    _publish_queue()


def set_status(did: int, action: str):
    item = db.row("SELECT * FROM downloads WHERE id=?", (did,))
    if not item:
        return
    with db.tx() as c:
        if action == "pause" and item["status"] == "queued":
            c.execute("UPDATE downloads SET status='paused' WHERE id=?", (did,))
        elif action == "resume" and item["status"] == "paused":
            c.execute("UPDATE downloads SET status='queued' WHERE id=?", (did,))
        elif action == "retry" and item["status"] in ("error", "cancelled", "done"):
            c.execute("UPDATE downloads SET status='queued', error='', progress=0, position=? WHERE id=?",
                      (_next_pos(), did))
        elif action == "cancel":
            if item["status"] in ACTIVE:
                _cancel.add(did)
            c.execute("UPDATE downloads SET status='cancelled' WHERE id=? AND status NOT IN ('done')", (did,))
        elif action == "remove":
            if item["status"] in ACTIVE:
                _cancel.add(did)
            c.execute("DELETE FROM downloads WHERE id=?", (did,))
    _wake.set()
    _publish_queue()


def clear(which="finished"):
    with db.tx() as c:
        if which == "finished":
            c.execute("DELETE FROM downloads WHERE status IN ('done','cancelled')")
        elif which == "failed":
            c.execute("DELETE FROM downloads WHERE status='error'")
        elif which == "all":
            for r in c.execute("SELECT id FROM downloads WHERE status IN ('downloading','processing')"):
                _cancel.add(r[0])
            c.execute("DELETE FROM downloads")
    _publish_queue()


def stats():
    r = db.rows("SELECT status, COUNT(*) n FROM downloads GROUP BY status")
    return {x["status"]: x["n"] for x in r}


# ------------------------------------------------------------------ worker

def _net_opts():
    opts = {"socket_timeout": 20, "retries": 5, "fragment_retries": 5}
    cookies = settings.get("cookies_file")
    if cookies and Path(cookies).exists():
        opts["cookiefile"] = cookies
    elif settings.get("cookies_browser"):
        opts["cookiesfrombrowser"] = (settings["cookies_browser"],)
    return opts


def _claim():
    with _claim_lock:
        if is_paused():
            return None
        item = db.row("SELECT * FROM downloads WHERE status='queued' ORDER BY position LIMIT 1")
        if not item:
            return None
        with db.tx() as c:
            c.execute("UPDATE downloads SET status='downloading', progress=0, error='' WHERE id=?", (item["id"],))
        item["status"] = "downloading"
        return item


def _update(did, **kw):
    sets = ", ".join(f"{k}=?" for k in kw)
    with db.tx() as c:
        c.execute(f"UPDATE downloads SET {sets} WHERE id=?", (*kw.values(), did))
    events.publish("download", {"id": did, **kw})


def _score(entry, want_title, want_artist, want_dur):
    title = (entry.get("title") or "").lower()
    channel = (entry.get("channel") or entry.get("uploader") or "").lower()
    s = 0.0
    nt = catalog.norm_title(want_title)
    na = scanner.norm(scanner.primary_artist(want_artist))
    ntitle = scanner.norm(title)
    if nt and nt in ntitle:
        s += 30
    else:
        words = [w for w in nt.split() if len(w) > 2]
        if words:
            s += 20 * sum(w in ntitle for w in words) / len(words)
    if na and (na in ntitle or na in scanner.norm(channel)):
        s += 20
    if channel.endswith("- topic"):
        s += 25
    if "official audio" in title or "audio" in title:
        s += 8
    if "official video" in title or "music video" in title:
        s -= 4
    wl = want_title.lower()
    for w in BAD_WORDS:
        if w in title and w not in wl:
            s -= 25
    d = entry.get("duration")
    if want_dur and d:
        diff = abs(d - want_dur)
        s -= min(diff, 120) * 0.8
        if diff <= 2:
            s += 15
    return s


def find_match(title, artist, duration):
    q = f"{artist} - {title}" if artist else title
    with yt_dlp.YoutubeDL({"quiet": True, "extract_flat": True, "skip_download": True, **_net_opts()}) as ydl:
        res = ydl.extract_info(f"ytsearch8:{q} audio", download=False)
    entries = [e for e in (res.get("entries") or []) if e and e.get("id")]
    if not entries:
        raise RuntimeError("No matches found on YouTube")
    best = max(entries, key=lambda e: _score(e, title, artist, duration))
    return f"https://www.youtube.com/watch?v={best['id']}", best


def _format_opts(kind):
    fmt = settings.get("audio_format", "m4a")
    if kind == "video":
        return {"format": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
                "merge_output_format": "mp4"}, "mp4"
    if fmt == "mp3":
        return {"format": "bestaudio/best", "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3",
                "preferredquality": settings.get("mp3_quality", "320")}]}, "mp3"
    if fmt == "opus":
        return {"format": "bestaudio[acodec=opus]/bestaudio/best", "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "opus"}]}, "opus"
    if fmt == "flac":
        return {"format": "bestaudio/best", "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "flac"}]}, "flac"
    return {"format": "bestaudio[ext=m4a]/bestaudio/best", "postprocessors": [
        {"key": "FFmpegExtractAudio", "preferredcodec": "m4a"}]}, "m4a"


_WIN_BAD = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def safe(name, fallback="Unknown"):
    name = _WIN_BAD.sub("_", (name or "").strip()).strip(". ")
    return name[:120] or fallback


def target_path(meta, ext):
    base = Path(settings["download_dir"])
    if meta.get("kind") == "video":
        return base / "Music Videos" / f"{safe(meta.get('artist'))} - {safe(meta['title'])}.{ext}"
    no = meta.get("track_no")
    disc = meta.get("disc_no") or 1
    name = f"{no:02d} {safe(meta['title'])}" if no else safe(meta["title"])
    if no and disc > 1:
        name = f"{disc}-{name}"
    return base / safe(meta.get("album_artist") or meta.get("artist"), "Unknown Artist") / \
        safe(meta.get("album") or "Singles", "Singles") / f"{name}.{ext}"


def _download_cover(url):
    if not url:
        return None
    try:
        r = catalog.client().get(url)
        if r.status_code == 200 and r.content:
            return r.content
    except httpx.HTTPError:
        pass
    return None


def tag_file(path: Path, meta: dict, cover: bytes | None):
    """Write tags + cover with mutagen for mp3 / m4a / flac / opus / ogg."""
    import mutagen
    from mutagen.flac import FLAC, Picture
    from mutagen.id3 import APIC, ID3, TALB, TCON, TDRC, TIT2, TPE1, TPE2, TPOS, TRCK, ID3NoHeaderError
    from mutagen.mp4 import MP4, MP4Cover

    ext = path.suffix.lower()
    tn, dn = meta.get("track_no"), meta.get("disc_no")
    year = str(meta.get("year") or "")
    if ext == ".mp3":
        try:
            tags = ID3(path)
        except ID3NoHeaderError:
            tags = ID3()
        tags.delall("APIC")
        tags.add(TIT2(encoding=3, text=meta["title"]))
        tags.add(TPE1(encoding=3, text=meta.get("artist", "")))
        tags.add(TALB(encoding=3, text=meta.get("album", "")))
        tags.add(TPE2(encoding=3, text=meta.get("album_artist", "")))
        if meta.get("genre"):
            tags.add(TCON(encoding=3, text=meta["genre"]))
        if year:
            tags.add(TDRC(encoding=3, text=year))
        if tn:
            tags.add(TRCK(encoding=3, text=str(tn)))
        if dn:
            tags.add(TPOS(encoding=3, text=str(dn)))
        if cover:
            tags.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="Cover", data=cover))
        tags.save(path)
    elif ext in (".m4a", ".mp4"):
        f = MP4(path)
        f["\xa9nam"] = meta["title"]
        f["\xa9ART"] = meta.get("artist", "")
        f["\xa9alb"] = meta.get("album", "")
        f["aART"] = meta.get("album_artist", "")
        if meta.get("genre"):
            f["\xa9gen"] = meta["genre"]
        if year:
            f["\xa9day"] = year
        if tn:
            f["trkn"] = [(int(tn), 0)]
        if dn:
            f["disk"] = [(int(dn), 0)]
        if cover:
            fmt = MP4Cover.FORMAT_PNG if cover[:4] == b"\x89PNG" else MP4Cover.FORMAT_JPEG
            f["covr"] = [MP4Cover(cover, imageformat=fmt)]
        f.save()
    else:
        f = mutagen.File(path)
        if f is None:
            return
        if f.tags is None:
            f.add_tags()
        f["title"] = meta["title"]
        f["artist"] = meta.get("artist", "")
        f["album"] = meta.get("album", "")
        f["albumartist"] = meta.get("album_artist", "")
        if meta.get("genre"):
            f["genre"] = meta["genre"]
        if year:
            f["date"] = year
        if tn:
            f["tracknumber"] = str(tn)
        if dn:
            f["discnumber"] = str(dn)
        if cover:
            pic = Picture()
            pic.type, pic.mime, pic.data = 3, "image/jpeg", cover
            if isinstance(f, FLAC):
                f.clear_pictures()
                f.add_picture(pic)
            else:
                import base64
                f["metadata_block_picture"] = [base64.b64encode(pic.write()).decode()]
        f.save()


def _enrich_from_catalog(meta):
    """For pasted links: look the song up in the catalog to get album/cover/track no."""
    title, artist = meta["title"], meta.get("artist", "")
    if not artist and " - " in title:
        artist, _, title = title.partition(" - ")
    title = re.sub(r"\s*[\(\[](official|lyric|audio|video|visuali[sz]er|hd|hq|4k)[^)\]]*[\)\]]", "", title,
                   flags=re.I).strip()
    artist = re.sub(r"\s*-\s*topic$", "", artist, flags=re.I).strip()
    meta.update(title=title, artist=artist)
    try:
        res = catalog._get("/search/track", {"q": f"{artist} {title}", "limit": 5}, ttl=86400).get("data", [])
    except catalog.Offline:
        return meta
    for t in res:
        if catalog.norm_title(t["title"]) == catalog.norm_title(title) and \
                (not artist or scanner.norm(t["artist"]["name"]) in scanner.norm(artist) or
                 scanner.norm(artist) in scanner.norm(t["artist"]["name"])):
            alb = t.get("album", {})
            meta.update(title=t["title"], artist=t["artist"]["name"], album=alb.get("title", meta.get("album")),
                        album_artist=t["artist"]["name"], track_no=t.get("track_position"),
                        disc_no=t.get("disk_number"), cover_url=alb.get("cover_xl") or meta.get("cover_url"),
                        catalog_id=str(t["id"]))
            try:
                full = catalog.album(alb["id"])
                meta.update(album_artist=full["artist"], year=_int(full.get("year")), genre=full.get("genre", ""))
            except Exception:
                pass
            break
    return meta


def _run_spotdl(item):
    exe = shutil.which("spotdl")
    if not exe:
        raise RuntimeError("Spotify links need spotDL: run  pip install spotdl")
    out = str(Path(settings["download_dir"]) / "{album-artist}" / "{album}" / "{track-number} {title}.{output-ext}")
    fmt = settings.get("audio_format", "m4a")
    proc = subprocess.Popen([exe, "download", item["source_url"], "--output", out, "--format", fmt],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace")
    done = 0
    for line in proc.stdout:
        if item["id"] in _cancel:
            proc.kill()
            raise DownloadCancelled()
        if "Downloaded" in line:
            done += 1
            _update(item["id"], progress=min(0.95, done / max(done + 1, 2)), error=line.strip()[:200])
    proc.wait()
    if proc.returncode:
        raise RuntimeError("spotDL failed (see console)")
    scanner.scan_async()


def process(item):
    did = item["id"]
    meta = dict(item)
    tmp = Path(settings["download_dir"]) / ".wavegrab-tmp" / str(did)
    tmp.mkdir(parents=True, exist_ok=True)
    last = [0.0]

    def hook(d):
        if did in _cancel:
            raise DownloadCancelled()
        if d["status"] == "downloading" and time.time() - last[0] > 0.4:
            last[0] = time.time()
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            prog = (d.get("downloaded_bytes", 0) / total) if total else 0
            _update(did, progress=round(prog * 0.9, 3), speed=d.get("speed") or 0, eta=d.get("eta"))
        elif d["status"] == "finished":
            _update(did, status="processing", progress=0.9)

    try:
        if item["kind"] == "spotdl":
            _run_spotdl(item)
            _update(did, status="done", progress=1, finished_at=_now(), error="")
            return
        if yt_dlp is None:
            raise RuntimeError("yt-dlp is not installed (pip install yt-dlp)")
        if not shutil.which("ffmpeg"):
            raise RuntimeError("FFmpeg not found. Install it and add it to PATH (winget install ffmpeg)")
        if item["kind"] == "url":
            meta = _enrich_from_catalog(meta)
        url = item.get("source_url")
        if not url:
            url, entry = find_match(item["title"], item["artist"], item.get("duration"))
            _update(did, matched_url=url)
        opts, ext = _format_opts(item["kind"])
        opts.update({"outtmpl": str(tmp / "audio.%(ext)s"), "quiet": True, "noprogress": True,
                     "progress_hooks": [hook], "noplaylist": True, **_net_opts()})
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
        files = sorted(tmp.glob("audio.*"), key=lambda p: p.stat().st_size, reverse=True)
        files = [f for f in files if f.suffix.lower() not in (".part", ".ytdl", ".jpg", ".webp", ".png")]
        if not files:
            raise RuntimeError("Download produced no file")
        src = files[0]
        ext = src.suffix.lstrip(".")
        if not meta.get("duration"):
            meta["duration"] = info.get("duration")
        dest = target_path(meta, ext)
        if item["kind"] != "video":
            cover = _download_cover(meta.get("cover_url"))
            tag_file(src, meta, cover)
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            dest.unlink()
        shutil.move(str(src), dest)
        if item["kind"] != "video":
            if settings.get("fetch_lyrics", True):
                _update(did, status="processing", progress=0.95, error="Fetching lyrics…")
                text = lyrics.fetch(meta["title"], meta.get("artist", ""), meta.get("album", ""),
                                    meta.get("duration") or 0)
                if text:
                    dest.with_suffix(".lrc").write_text(text, "utf-8")
            scanner.index_single(dest)
        _update(did, status="done", progress=1, finished_at=_now(), file_path=str(dest), error="")
    except DownloadCancelled:
        if db.row("SELECT id FROM downloads WHERE id=?", (did,)):
            _update(did, status="cancelled", progress=0)
    except Exception as e:  # noqa: BLE001 - surface every failure in the UI
        msg = re.sub(r"\x1b\[[0-9;]*m", "", str(e)).replace("ERROR: ", "")
        if "not a bot" in msg or "Sign in to confirm" in msg:
            msg = ("YouTube wants to check you're not a bot. In Settings > Downloads, pick your browser under "
                   "'Use browser cookies' (or set a cookies.txt), then hit Retry.")
        _update(did, status="error", error=msg[:400])
    finally:
        _cancel.discard(did)
        shutil.rmtree(tmp, ignore_errors=True)
        _publish_queue()


def _worker_loop():
    while not _stop.is_set():
        item = _claim()
        if item is None:
            _wake.wait(timeout=5)
            _wake.clear()
            continue
        _publish_queue()
        process(item)


def start():
    # anything left "downloading" from a crash goes back in the queue
    with db.tx() as c:
        c.execute("UPDATE downloads SET status='queued', progress=0 WHERE status IN ('downloading','processing')")
    n = max(1, int(settings.get("max_parallel_downloads", 1)))
    for _ in range(n):
        t = threading.Thread(target=_worker_loop, daemon=True)
        t.start()
        _workers.append(t)
