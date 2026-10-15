"""Download queue + worker (the WaveGrab engine).

Queue items live in the `downloads` table so the queue survives restarts.
The worker:
  1. downloads the song with spotDL (Spotify metadata + YouTube Music audio
     matching). If spotDL can't find it, falls back to WaveGrab's own
     duration-scored YouTube search + yt-dlp
  2. converts to the chosen format
  3. tags it (title/artist/album/track/disc/year/genre/cover) with mutagen
  4. fetches lyrics from LRCLIB and writes a .lrc sidecar
  5. moves it into  <download_dir>/<Album Artist>/<Album>/<NN Title>.ext
     and adds it to the library index immediately
"""
import json
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path

import httpx

from . import catalog, db, events, lyrics, scanner, tools
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
                   created_at, multi_disc) VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (pos, it.get("kind", "track"), it.get("title") or it.get("source_url") or "Unknown",
                 it.get("artist", ""), it.get("album", ""), it.get("album_artist") or it.get("artist", ""),
                 it.get("track_no"), it.get("disc_no"), _int(it.get("year")), it.get("genre", ""),
                 it.get("duration"), it.get("cover_url", ""), str(it.get("catalog_id") or ""),
                 it.get("source_url", ""), gid, group_title, _now(), 1 if it.get("multi_disc") else 0))
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
    multi = any((t.get("disc_no") or 1) > 1 for t in a["tracks"])
    items, seen = [], set()
    for t in a["tracks"]:
        # never queue the same song twice for one album
        key = (catalog.norm_title(t["title"]), t.get("disc_no") or 1)
        if key in seen:
            continue
        seen.add(key)
        if only_missing and t["saved"]:
            continue
        items.append(dict(title=t["title"], artist=t["artist"], album=a["title"], album_artist=a["artist"],
                          track_no=t["track_no"], disc_no=t["disc_no"], year=a["year"], genre=a.get("genre", ""),
                          duration=t["duration"], cover_url=a["cover"], catalog_id=t["id"], multi_disc=multi))
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
        return enqueue_spotify(url)
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


def enqueue_spotify(url: str):
    """Spotify track / album / playlist link -> one queue item per song,
    using `spotdl save` to read the metadata (no Spotify login needed)."""
    if not tools.has_spotdl():
        raise RuntimeError("spotDL is missing: pip install spotdl")
    with tempfile.TemporaryDirectory() as td:
        save = Path(td) / "list.spotdl"
        r = subprocess.run(tools.spotdl_cmd() + ["save", url, "--save-file", str(save), "--log-level", "ERROR"],
                           capture_output=True, text=True, errors="replace", timeout=900)
        if not save.exists():
            raise RuntimeError((r.stdout + r.stderr).strip().splitlines()[-1:] or "spotDL couldn't read that link")
        songs = json.loads(save.read_text("utf-8"))
    # a single album: queue in track order (playlists keep their own order)
    if songs and len({(sg.get("album_name"), sg.get("album_artist")) for sg in songs}) == 1:
        songs.sort(key=lambda sg: (sg.get("disc_number") or 1, sg.get("track_number") or 0))
    multi = any((sg.get("disc_number") or 1) > 1 for sg in songs)
    items = []
    for sg in songs:
        items.append(dict(kind="track", title=sg.get("name", ""), artist=sg.get("artist", ""),
                          album=sg.get("album_name", ""), album_artist=sg.get("album_artist") or sg.get("artist", ""),
                          track_no=sg.get("track_number"), disc_no=sg.get("disc_number"), year=sg.get("year"),
                          genre=(sg.get("genres") or [""])[0].title() if sg.get("genres") else "",
                          duration=sg.get("duration"), cover_url=sg.get("cover_url", ""),
                          catalog_id="spotify:" + str(sg.get("song_id", "")), source_url=sg.get("url", ""),
                          multi_disc=multi))
    # songs that are already in the library aren't queued at all
    items = [it for it in items if not existing_copy(_align_with_library(dict(it)))]
    title = songs[0].get("list_name") if songs and songs[0].get("list_name") else (
        f"{songs[0].get('album_artist')} — {songs[0].get('album_name')}" if len(songs) > 1 else "")
    return enqueue(items, group_title=title or "Spotify")


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
    ff = tools.ffmpeg_exe()
    if ff:
        opts["ffmpeg_location"] = ff
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


def track_filename(title, track_no, disc_no=None, multi_disc=False):
    """'01 Title' — the number prefix makes the files sort in album order.
    Multi-disc albums get the disc first: '2-01 Title'."""
    name = safe(title)
    if track_no:
        name = f"{int(track_no):02d} {name}"
        if multi_disc or (disc_no and int(disc_no) > 1):
            name = f"{int(disc_no or 1)}-{name}"
    return name


def target_path(meta, ext):
    base = Path(settings["download_dir"])
    if meta.get("kind") == "video":
        return base / "Music Videos" / f"{safe(meta.get('artist'))} - {safe(meta['title'])}.{ext}"
    name = track_filename(meta["title"], meta.get("track_no"), meta.get("disc_no"), meta.get("multi_disc"))
    if meta.get("_folder"):
        return Path(meta["_folder"]) / f"{name}.{ext}"
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


def _align_with_library(meta):
    """If this song belongs to an album that's already in the library, save it
    in that album's folder with that album's names, so it joins the album
    instead of starting a second copy (e.g. "Discovery" vs "Discovery (Remastered)")."""
    local_id = catalog.match_album(meta.get("album_artist") or meta.get("artist", ""), meta.get("album", ""))
    if not local_id:
        return meta
    a = db.row("SELECT title, artist FROM albums WHERE id=?", (local_id,))
    t = db.row("SELECT path, disc_no FROM tracks WHERE album_id=? ORDER BY disc_no DESC LIMIT 1", (local_id,))
    if a and t:
        meta.update(album=a["title"], album_artist=a["artist"], _folder=str(Path(t["path"]).parent),
                    _album_id=local_id, multi_disc=(t["disc_no"] or 1) > 1)
    return meta


def existing_copy(meta):
    """Path of a copy of this song already in the same album, if any."""
    album_id = meta.get("_album_id") or scanner.make_id(meta.get("album_artist") or meta.get("artist", ""),
                                                        meta.get("album", ""))
    want = catalog.norm_title(meta["title"])
    for t in db.rows("SELECT path, title, duration FROM tracks WHERE album_id=?", (album_id,)):
        if catalog.norm_title(t["title"]) != want:
            continue
        if meta.get("duration") and t["duration"] and abs(t["duration"] - float(meta["duration"])) > 6:
            continue  # same name, different recording (e.g. a reprise)
        return t["path"]
    return None


def _spotdl_fetch(item, meta, tmp: Path, did):
    """Download one song with spotDL into tmp/audio.<ext>."""
    fmt = settings.get("audio_format", "m4a")
    query = item.get("source_url") if "spotify.com" in (item.get("source_url") or "") \
        else f"{meta.get('artist', '')} - {meta['title']}"
    cmd = tools.spotdl_cmd() + ["download", query, "--output", str(tmp / "audio.{output-ext}"),
                                "--format", fmt, "--overwrite", "force", "--print-errors",
                                "--simple-tui", "--log-level", "INFO"]
    ff = tools.ffmpeg_exe()
    if ff:
        cmd += ["--ffmpeg", ff]
    if fmt in ("m4a", "opus"):
        cmd += ["--bitrate", "disable"]  # keep YouTube's stream as-is, no re-encode
    elif fmt == "mp3":
        cmd += ["--bitrate", f"{settings.get('mp3_quality', '320')}k"]
    cookies = settings.get("cookies_file")
    if cookies and Path(cookies).exists():
        cmd += ["--cookie-file", cookies]
    elif settings.get("cookies_browser"):
        cmd += ["--yt-dlp-args", f"--cookies-from-browser {settings['cookies_browser']}"]
    _update(did, progress=0.15, error="Downloading with spotDL…")
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace",
                            cwd=str(tmp))
    lines = []
    for line in proc.stdout:
        if did in _cancel:
            proc.kill()
            raise DownloadCancelled()
        line = re.sub(r"\x1b\[[0-9;]*m", "", line).strip()
        if line:
            lines.append(line)
        m = re.search(r"(\d{1,3})%", line)
        if m:
            _update(did, progress=min(0.85, 0.15 + int(m.group(1)) / 100 * 0.7))
    proc.wait()
    files = [f for f in tmp.glob("audio.*") if f.suffix.lower() not in (".lrc", ".jpg", ".png", ".webp", ".part")]
    if not files:
        errs = [l for l in lines if "rror" in l or "exception" in l.lower() or "No results" in l]
        raise RuntimeError((errs or lines or ["spotDL found nothing"])[-1][:300])
    return max(files, key=lambda f: f.stat().st_size)


def _ytdlp_fetch(item, meta, tmp: Path, hook):
    url = item.get("source_url")
    if not url or "spotify.com" in url:
        url, _entry = find_match(meta["title"], meta.get("artist", ""), meta.get("duration"))
        _update(item["id"], matched_url=url)
    opts, _ext = _format_opts(item["kind"])
    opts.update({"outtmpl": str(tmp / "audio.%(ext)s"), "quiet": True, "noprogress": True,
                 "progress_hooks": [hook], "noplaylist": True, **_net_opts()})
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
    files = sorted(tmp.glob("audio.*"), key=lambda p: p.stat().st_size, reverse=True)
    files = [f for f in files if f.suffix.lower() not in (".part", ".ytdl", ".jpg", ".webp", ".png")]
    if not files:
        raise RuntimeError("Download produced no file")
    if not meta.get("duration"):
        meta["duration"] = info.get("duration")
    return files[0]


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
        if item["kind"] == "spotdl":  # queue rows from older versions
            ids = enqueue_spotify(item["source_url"])
            _update(did, status="done", progress=1, finished_at=_now(), error=f"Expanded into {len(ids)} songs")
            return
        if not tools.ffmpeg_exe():
            _update(did, error="Installing FFmpeg via spotDL…")
            if not tools.install_ffmpeg():
                raise RuntimeError("FFmpeg not found. Run: python -m spotdl --download-ffmpeg")
        if item["kind"] == "url":
            meta = _enrich_from_catalog(meta)
        audio = item["kind"] != "video"
        if audio:
            meta = _align_with_library(meta)
            dup = existing_copy(meta)
            if dup:
                _update(did, status="done", progress=1, finished_at=_now(), file_path=dup,
                        error="Already in your library — skipped")
                return
        src = None
        if audio and item["kind"] == "track" and settings.get("download_engine", "spotdl") == "spotdl" \
                and tools.has_spotdl():
            try:
                src = _spotdl_fetch(item, meta, tmp, did)
            except DownloadCancelled:
                raise
            except Exception as e:  # noqa: BLE001 - fall back to the built-in matcher
                _update(did, progress=0.1, error=f"spotDL: {str(e)[:120]} — trying direct YouTube search")
                for f in tmp.glob("*"):
                    f.unlink(missing_ok=True) if f.is_file() else shutil.rmtree(f, ignore_errors=True)
        if src is None:
            if yt_dlp is None:
                raise RuntimeError("yt-dlp is not installed (pip install yt-dlp)")
            src = _ytdlp_fetch(item, meta, tmp, hook)
        _update(did, status="processing", progress=0.9, error="Tagging…")
        ext = src.suffix.lstrip(".")
        dest = target_path(meta, ext)
        if audio:
            tag_file(src, meta, _download_cover(meta.get("cover_url")))
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            dest.unlink()
        shutil.move(str(src), dest)
        if audio:
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
