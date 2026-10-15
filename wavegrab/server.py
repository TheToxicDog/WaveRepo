"""FastAPI app: JSON API + static web UI + audio streaming."""
import asyncio
import mimetypes
import re
import subprocess
import time
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import catalog, db, downloader, events, lrc, lyrics, organizer, scanner, tools
from .config import settings

WEB = Path(__file__).resolve().parent.parent / "web"
BROWSER_NATIVE = {"mp3", "flac", "m4a", "mp4", "aac", "ogg", "opus", "wav", "webm"}

app = FastAPI(title="WaveGrab")


@app.on_event("startup")
async def _startup():
    events.bind_loop(asyncio.get_running_loop())
    db.init()
    downloader.start()
    scanner.scan_async()


@app.exception_handler(catalog.Offline)
async def _offline(_req, exc):
    return JSONResponse({"error": str(exc), "offline": True}, status_code=503)


# ------------------------------------------------------------------ helpers

TRACK_COLS = ("t.id, t.title, t.artist, t.album, t.album_artist, t.album_id, t.artist_id, t.genre, t.year, "
              "t.track_no, t.disc_no, t.duration, t.format, t.bitrate, t.play_count, t.last_played, t.liked_at, "
              "t.lyrics_synced, (t.lyrics_plain != '') AS has_lyrics, t.added_at")

SORTS = {"title": "t.title COLLATE NOCASE", "artist": "t.artist COLLATE NOCASE, t.album, t.disc_no, t.track_no",
         "album": "t.album COLLATE NOCASE, t.disc_no, t.track_no", "added": "t.added_at DESC",
         "duration": "t.duration", "plays": "t.play_count DESC", "year": "t.year DESC"}


def cover_url(album_id):
    return f"/api/cover/{album_id}"


def with_cover(items, key="album_id"):
    for it in items:
        it["cover"] = cover_url(it[key])
    return items


# ------------------------------------------------------------------ library

@app.get("/api/stats")
def stats():
    return {
        "tracks": db.scalar("SELECT COUNT(*) FROM tracks"),
        "albums": db.scalar("SELECT COUNT(*) FROM albums WHERE track_count > 1"),
        "artists": db.scalar("SELECT COUNT(*) FROM artists"),
        "duration": db.scalar("SELECT COALESCE(SUM(duration),0) FROM tracks"),
        "liked": db.scalar("SELECT COUNT(*) FROM tracks WHERE liked_at>0"),
        "scan": scanner.scan_state,
        "roots": [{"path": r, "online": Path(r).is_dir()} for r in settings["library_roots"]],
        "downloads": downloader.stats(),
    }


@app.get("/api/albums")
def albums(sort: str = "added", q: str = ""):
    order = {"added": "added_at DESC", "title": "title COLLATE NOCASE", "artist": "artist COLLATE NOCASE, year",
             "year": "year DESC"}.get(sort, "added_at DESC")
    # a "album" with a single song is a loose track, not an album: it lives in Songs
    where, params = "WHERE track_count > 1", ()
    if q:
        where, params = "WHERE track_count > 1 AND (title LIKE ? OR artist LIKE ?)", (f"%{q}%", f"%{q}%")
    items = db.rows(f"SELECT * FROM albums {where} ORDER BY {order}", params)
    for a in items:
        a["cover"] = cover_url(a["id"])
    return items


@app.get("/api/albums/{album_id}")
def album(album_id: str):
    a = db.row("SELECT * FROM albums WHERE id=?", (album_id,))
    if not a:
        raise HTTPException(404, "Album not found")
    a["cover"] = cover_url(album_id)
    a["tracks"] = with_cover(db.rows(f"SELECT {TRACK_COLS} FROM tracks t WHERE album_id=? "
                                     "ORDER BY COALESCE(disc_no,1), COALESCE(track_no,999), title", (album_id,)))
    return a


@app.get("/api/albums/{album_id}/online")
def album_online(album_id: str):
    """Match a local album to the catalog so missing tracks can be shown."""
    a = db.row("SELECT * FROM albums WHERE id=?", (album_id,))
    if not a:
        raise HTTPException(404)
    found = catalog.find_album(a["artist"], a["title"])
    if not found:
        return {"match": None}
    return {"match": catalog.album(found["id"])}


@app.get("/api/artists")
def artists(q: str = ""):
    where, params = "", ()
    if q:
        where, params = "WHERE name LIKE ?", (f"%{q}%",)
    items = db.rows(f"SELECT * FROM artists {where} ORDER BY name COLLATE NOCASE", params)
    for a in items:
        a["cover"] = a["image_url"] or (cover_url(a["cover_album"]) if a["cover_album"] else "")
    return items


@app.get("/api/artists/{artist_id}")
def artist(artist_id: str):
    a = db.row("SELECT * FROM artists WHERE id=?", (artist_id,))
    if not a:
        raise HTTPException(404, "Artist not found")
    a["cover"] = a["image_url"] or (cover_url(a["cover_album"]) if a["cover_album"] else "")
    a["albums"] = [dict(x, cover=cover_url(x["id"])) for x in
                   db.rows("SELECT * FROM albums WHERE artist_id=? AND track_count > 1 ORDER BY year DESC", (artist_id,))]
    a["singles"] = with_cover(db.rows(
        f"SELECT {TRACK_COLS} FROM tracks t JOIN albums al ON al.id=t.album_id "
        "WHERE t.artist_id=? AND al.track_count = 1 ORDER BY t.year DESC, t.title", (artist_id,)))
    a["top_tracks"] = with_cover(db.rows(
        f"SELECT {TRACK_COLS} FROM tracks t WHERE artist_id=? OR artist LIKE ? "
        "ORDER BY play_count DESC, liked_at DESC, added_at DESC LIMIT 10", (artist_id, f"%{a['name']}%")))
    a["appears_on"] = with_cover(db.rows(
        f"SELECT {TRACK_COLS} FROM tracks t WHERE artist LIKE ? AND artist_id != ? LIMIT 20",
        (f"%{a['name']}%", artist_id)))
    return a


@app.get("/api/artists/{artist_id}/online")
def artist_online(artist_id: str):
    a = db.row("SELECT * FROM artists WHERE id=?", (artist_id,))
    if not a:
        raise HTTPException(404)
    dz = catalog.find_artist(a["name"])
    return {"match": catalog.artist(dz["id"]) if dz else None}


@app.get("/api/tracks")
def tracks(sort: str = "artist", liked: bool = False, offset: int = 0, limit: int = 100000):
    order = SORTS.get(sort, SORTS["artist"])
    where = "WHERE liked_at>0" if liked else ""
    if liked and sort == "added":
        order = "t.liked_at DESC"
    return with_cover(db.rows(f"SELECT {TRACK_COLS} FROM tracks t {where} ORDER BY {order} LIMIT ? OFFSET ?",
                              (limit, offset)))


@app.get("/api/tracks/{track_id}")
def track(track_id: int):
    t = db.row(f"SELECT {TRACK_COLS}, t.path, t.sample_rate, t.size FROM tracks t WHERE id=?", (track_id,))
    if not t:
        raise HTTPException(404)
    t["cover"] = cover_url(t["album_id"])
    return t


@app.get("/api/tracks/{track_id}/lyrics")
def track_lyrics(track_id: int):
    t = db.row("SELECT path, lrc_path, lyrics_plain FROM tracks WHERE id=?", (track_id,))
    if not t:
        raise HTTPException(404)
    p = Path(t["path"])
    _, text = scanner.find_lyrics(p, "")
    if not text:
        text = scanner.read_tags(p)["lyrics"] if p.exists() else t["lyrics_plain"]
    return lrc.parse(text or "")


@app.post("/api/tracks/{track_id}/lyrics/fetch")
def track_lyrics_fetch(track_id: int):
    ok = lyrics.fetch_for_track(track_id)
    return {"ok": ok}


@app.post("/api/tracks/{track_id}/like")
def like(track_id: int, liked: bool = Body(True, embed=True)):
    with db.tx() as c:
        c.execute("UPDATE tracks SET liked_at=? WHERE id=?", (int(time.time()) if liked else 0, track_id))
    events.publish("liked", {"track_id": track_id, "liked": liked})
    return {"ok": True}


@app.post("/api/tracks/{track_id}/played")
def played(track_id: int):
    now = int(time.time())
    with db.tx() as c:
        c.execute("UPDATE tracks SET play_count=play_count+1, last_played=? WHERE id=?", (now, track_id))
        c.execute("INSERT INTO play_history(track_id, played_at) SELECT id, ? FROM tracks WHERE id=?", (now, track_id))
    return {"ok": True}


@app.get("/api/history")
def history(limit: int = 50):
    return with_cover(db.rows(
        f"SELECT {TRACK_COLS}, MAX(h.played_at) AS played_at FROM play_history h JOIN tracks t ON t.id=h.track_id "
        "GROUP BY t.id ORDER BY played_at DESC LIMIT ?", (limit,)))


@app.get("/api/recent-albums")
def recent_albums(limit: int = 12):
    items = db.rows("SELECT a.*, MAX(h.played_at) AS played_at FROM play_history h JOIN tracks t ON t.id=h.track_id "
                    "JOIN albums a ON a.id=t.album_id WHERE a.track_count > 1 GROUP BY a.id ORDER BY played_at DESC LIMIT ?", (limit,))
    for a in items:
        a["cover"] = cover_url(a["id"])
    return items


@app.get("/api/recency")
def recency():
    """Last-played timestamps for the 'Fewer repeats' shuffle."""
    return {str(r["id"]): r["last_played"] for r in db.rows("SELECT id, last_played FROM tracks WHERE last_played>0")}


@app.get("/api/cover/{album_id}")
def cover(album_id: str):
    p = settings.cover_cache / f"{album_id}.jpg"
    if p.exists():
        head = p.read_bytes()[:4]
        mt = "image/png" if head == b"\x89PNG" else "image/jpeg"
        return FileResponse(p, media_type=mt, headers={"Cache-Control": "public, max-age=86400"})
    return Response(status_code=404)


@app.get("/api/img")
def img(u: str):
    """Disk-cached proxy for online artwork (keeps covers working offline)."""
    import hashlib
    if not u.startswith("https://"):
        raise HTTPException(400)
    p = settings.home / "cache" / "img" / (hashlib.sha1(u.encode()).hexdigest() + ".jpg")
    if not p.exists():
        try:
            r = catalog.client().get(u)
            r.raise_for_status()
        except Exception:
            return Response(status_code=404)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(r.content)
    return FileResponse(p, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=604800"})


def ranged_file(p: Path, media_type: str, request: Request):
    """Serve a file with HTTP Range support so the browser can seek.
    (spotDL pins an older Starlette whose FileResponse ignores Range.)"""
    size = p.stat().st_size
    rng = request.headers.get("range", "")
    m = re.match(r"bytes=(\d*)-(\d*)", rng)
    headers = {"Accept-Ranges": "bytes", "Cache-Control": "no-cache"}
    if not m or (not m.group(1) and not m.group(2)):
        return FileResponse(p, media_type=media_type, headers=headers)
    if m.group(1):
        start = int(m.group(1))
        end = int(m.group(2)) if m.group(2) else size - 1
    else:  # suffix range: last N bytes
        start, end = max(0, size - int(m.group(2))), size - 1
    end = min(end, size - 1)
    if start > end or start >= size:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
    length = end - start + 1

    def gen():
        with open(p, "rb") as f:
            f.seek(start)
            left = length
            while left > 0:
                chunk = f.read(min(256 * 1024, left))
                if not chunk:
                    break
                left -= len(chunk)
                yield chunk
    headers.update({"Content-Range": f"bytes {start}-{end}/{size}", "Content-Length": str(length)})
    return StreamingResponse(gen(), status_code=206, media_type=media_type, headers=headers)


@app.get("/api/stream/{track_id}")
def stream(track_id: int, request: Request):
    t = db.row("SELECT path, format FROM tracks WHERE id=?", (track_id,))
    if not t:
        raise HTTPException(404)
    p = Path(t["path"])
    if not p.exists():
        raise HTTPException(410, "File is on a drive that isn't connected")
    if t["format"] in BROWSER_NATIVE:
        mt = mimetypes.guess_type(p.name)[0] or "audio/mpeg"
        if t["format"] == "m4a":
            mt = "audio/mp4"
        elif t["format"] == "opus":
            mt = "audio/ogg"
        elif t["format"] == "flac":
            mt = "audio/flac"
        return ranged_file(p, mt, request)
    # WMA / AIFF / ALAC etc: transcode on the fly with ffmpeg
    ff = tools.ffmpeg_exe()
    if not ff:
        raise HTTPException(415, "This format needs FFmpeg to play")
    proc = subprocess.Popen([ff, "-v", "quiet", "-i", str(p), "-f", "mp3", "-b:a", "320k", "-"],
                            stdout=subprocess.PIPE)

    def gen():
        try:
            while chunk := proc.stdout.read(65536):
                yield chunk
        finally:
            proc.kill()
    return StreamingResponse(gen(), media_type="audio/mpeg")


# ------------------------------------------------------------------ music videos

VIDEO_EXTS = {".mp4", ".webm", ".mkv", ".mov", ".m4v"}


def video_dirs():
    dirs = {Path(settings["download_dir"]) / "Music Videos"}
    dirs |= {Path(r) / "Music Videos" for r in settings["library_roots"] if r}
    return [d for d in dirs if d.is_dir()]


def _video_path(vid: str) -> Path:
    """Video ids are hashes of files found inside the Music Videos folders, so a
    request can never reach a file outside them."""
    import hashlib
    for d in video_dirs():
        for f in d.rglob("*"):
            if f.suffix.lower() in VIDEO_EXTS and hashlib.sha1(str(f).encode()).hexdigest()[:16] == vid:
                return f
    raise HTTPException(404, "Video not found")


@app.get("/api/videos")
def videos():
    import hashlib
    out = []
    for d in video_dirs():
        for f in d.rglob("*"):
            if f.suffix.lower() not in VIDEO_EXTS or f.name.startswith("."):
                continue
            artist, _, title = f.stem.partition(" - ")
            st = f.stat()
            vid = hashlib.sha1(str(f).encode()).hexdigest()[:16]
            out.append({"id": vid, "title": title or f.stem, "artist": artist if title else "", "size": st.st_size,
                        "added_at": int(st.st_mtime), "thumb": f"/api/videos/{vid}/thumb"})
    out.sort(key=lambda v: v["added_at"], reverse=True)
    return out


@app.get("/api/videos/{vid}/stream")
def video_stream(vid: str, request: Request):
    p = _video_path(vid)
    mt = {".webm": "video/webm", ".mkv": "video/x-matroska", ".mov": "video/quicktime"}.get(p.suffix.lower(), "video/mp4")
    return ranged_file(p, mt, request)


@app.get("/api/videos/{vid}/thumb")
def video_thumb(vid: str):
    thumb = settings.home / "cache" / "video-thumbs" / f"{vid}.jpg"
    if not thumb.exists():
        p = _video_path(vid)
        ff = tools.ffmpeg_exe()
        if not ff:
            return Response(status_code=404)
        thumb.parent.mkdir(parents=True, exist_ok=True)
        # grab a frame a little way in (skips black intro frames)
        for at in ("00:00:20", "00:00:03", "00:00:00"):
            subprocess.run([ff, "-v", "quiet", "-y", "-ss", at, "-i", str(p), "-frames:v", "1", "-vf", "scale=640:-2",
                            str(thumb)], timeout=60)
            if thumb.exists() and thumb.stat().st_size > 0:
                break
        if not thumb.exists():
            return Response(status_code=404)
    return FileResponse(thumb, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})


@app.post("/api/scan")
def scan(full: bool = False):
    scanner.scan_async(full)
    return {"ok": True}


@app.post("/api/lyrics/backfill")
def lyrics_backfill():
    lyrics.backfill()
    return {"ok": True}


# ------------------------------------------------------------------ search

def fts_query(q: str) -> str:
    toks = re.findall(r"[\w']+", q, flags=re.UNICODE)
    return " AND ".join(f'"{t.replace(chr(34), "")}"*' for t in toks)


@app.get("/api/search")
def search(q: str, limit: int = 40):
    q = q.strip()
    if not q:
        return {"tracks": [], "albums": [], "artists": [], "lyrics": []}
    fq = fts_query(q)
    if not fq:
        return {"tracks": [], "albums": [], "artists": [], "lyrics": []}
    like = f"%{q}%"
    tracks = with_cover(db.rows(f"""
        SELECT {TRACK_COLS},
               highlight(tracks_fts, 0, '<b>', '</b>') AS hl_title,
               snippet(tracks_fts, 4, '<mark>', '</mark>', '…', 14) AS lyric_excerpt,
               bm25(tracks_fts, 10.0, 5.0, 3.0, 2.0, 1.0) AS score
        FROM tracks_fts JOIN tracks t ON t.id = tracks_fts.rowid
        WHERE tracks_fts MATCH ?
        ORDER BY score ASC, t.play_count DESC LIMIT ?""", (fq, limit)))
    # lyric-only hits: which matched in lyrics but not title/artist/album
    lyric_fq = fq
    lines = db.rows("""
        SELECT l.track_id, l.timestamp_ms,
               highlight(lyric_lines_fts, 0, '<mark>', '</mark>') AS line, bm25(lyric_lines_fts) AS score
        FROM lyric_lines_fts JOIN lyric_lines l ON l.id = lyric_lines_fts.rowid
        WHERE lyric_lines_fts MATCH ? ORDER BY score LIMIT 60""", (lyric_fq,))
    seen, lyric_hits = set(), []
    for ln in lines:
        if ln["track_id"] in seen:
            continue
        seen.add(ln["track_id"])
        t = db.row(f"SELECT {TRACK_COLS} FROM tracks t WHERE id=?", (ln["track_id"],))
        if t:
            t["cover"] = cover_url(t["album_id"])
            t["line"] = ln["line"]
            t["timestamp_ms"] = ln["timestamp_ms"]
            lyric_hits.append(t)
        if len(lyric_hits) >= 12:
            break
    toks = [t.lower() for t in re.findall(r"[\w']+", q)]

    def lyric_only(t):
        meta = f"{t['title']} {t['artist']} {t['album']} {t['genre']}".lower()
        return not all(any(w.startswith(tok) for w in re.findall(r"[\w']+", meta)) for tok in toks)

    # unsynced lyrics only exist in tracks_fts: add those excerpts too
    for t in tracks:
        if lyric_only(t) and t["id"] not in seen and len(lyric_hits) < 12:
            seen.add(t["id"])
            lyric_hits.append(dict(t, line=t["lyric_excerpt"], timestamp_ms=None))
    albums = db.rows("SELECT * FROM albums WHERE track_count > 1 AND (title LIKE ? OR artist LIKE ?) ORDER BY "
                     "CASE WHEN title LIKE ? THEN 0 ELSE 1 END, added_at DESC LIMIT 12", (like, like, f"{q}%"))
    for a in albums:
        a["cover"] = cover_url(a["id"])
    artists_ = db.rows("SELECT * FROM artists WHERE name LIKE ? ORDER BY CASE WHEN name LIKE ? THEN 0 ELSE 1 END, "
                       "track_count DESC LIMIT 8", (like, f"{q}%"))
    for a in artists_:
        a["cover"] = a["image_url"] or (cover_url(a["cover_album"]) if a["cover_album"] else "")
    songs = [t for t in tracks if not lyric_only(t)]
    return {"tracks": songs, "albums": albums, "artists": artists_, "lyrics": lyric_hits}


# ------------------------------------------------------------------ catalog / discover

@app.get("/api/online/search")
def online_search(q: str):
    return catalog.search(q)


@app.get("/api/online/album/{album_id}")
def online_album(album_id: str):
    return catalog.album(album_id)


@app.get("/api/online/artist/{artist_id}")
def online_artist(artist_id: str):
    return catalog.artist(artist_id)


@app.get("/api/online/charts")
def online_charts():
    return catalog.charts()


@app.get("/api/online/genres")
def online_genres():
    return catalog.genres()


@app.get("/api/online/genre/{genre_id}")
def online_genre(genre_id: int):
    return catalog.genre_albums(genre_id)


@app.get("/api/online/new-for-you")
def online_new_for_you():
    return catalog.new_from_your_artists()


# ------------------------------------------------------------------ downloads

@app.get("/api/downloads")
def downloads():
    return {"items": downloader.queue_list(), "paused": downloader.is_paused()}


@app.post("/api/downloads/album/{album_id}")
def dl_album(album_id: str, all_tracks: bool = False):
    return {"ids": downloader.enqueue_album(album_id, only_missing=not all_tracks)}


@app.post("/api/downloads/track/{track_id}")
def dl_track(track_id: str):
    return {"ids": downloader.enqueue_track(track_id)}


@app.post("/api/downloads/url")
def dl_url(url: str = Body(..., embed=True), mode: str = Body("audio", embed=True)):
    try:
        return {"ids": downloader.enqueue_url(url, mode)}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Couldn't read that link: {e}")


@app.post("/api/downloads/reorder")
def dl_reorder(ids: list[int] = Body(..., embed=True)):
    downloader.reorder(ids)
    return {"ok": True}


@app.post("/api/downloads/{did}/{action}")
def dl_action(did: int, action: str):
    if action in ("top", "bottom"):
        downloader.move(did, action)
    elif action in ("pause", "resume", "retry", "cancel", "remove"):
        downloader.set_status(did, action)
    else:
        raise HTTPException(400, "unknown action")
    return {"ok": True}


@app.post("/api/downloads-control/{action}")
def dl_control(action: str):
    if action == "pause":
        downloader.set_paused(True)
    elif action == "resume":
        downloader.set_paused(False)
    elif action.startswith("clear-"):
        downloader.clear(action[6:])
    return {"ok": True, "paused": downloader.is_paused()}


# ------------------------------------------------------------------ playlists

@app.get("/api/playlists")
def playlists():
    items = db.rows("SELECT p.*, COUNT(pt.track_id) AS track_count FROM playlists p "
                    "LEFT JOIN playlist_tracks pt ON pt.playlist_id=p.id GROUP BY p.id ORDER BY p.updated_at DESC")
    for p in items:
        p["covers"] = [cover_url(r["album_id"]) for r in db.rows(
            "SELECT DISTINCT t.album_id FROM playlist_tracks pt JOIN tracks t ON t.id=pt.track_id "
            "WHERE pt.playlist_id=? ORDER BY pt.position LIMIT 4", (p["id"],))]
    return items


@app.post("/api/playlists")
def playlist_create(name: str = Body(..., embed=True), track_ids: list[int] = Body([], embed=True)):
    now = int(time.time())
    with db.tx() as c:
        pid = c.execute("INSERT INTO playlists(name, created_at, updated_at) VALUES (?,?,?)",
                        (name, now, now)).lastrowid
        for i, tid in enumerate(track_ids):
            c.execute("INSERT INTO playlist_tracks SELECT ?,id,?,? FROM tracks WHERE id=?", (pid, i, now, tid))
    events.publish("playlists", {})
    return {"id": pid}


@app.get("/api/playlists/{pid}")
def playlist(pid: int):
    p = db.row("SELECT * FROM playlists WHERE id=?", (pid,))
    if not p:
        raise HTTPException(404)
    p["tracks"] = with_cover(db.rows(f"SELECT {TRACK_COLS}, pt.position FROM playlist_tracks pt "
                                     "JOIN tracks t ON t.id=pt.track_id WHERE pt.playlist_id=? ORDER BY pt.position",
                                     (pid,)))
    return p


@app.patch("/api/playlists/{pid}")
def playlist_update(pid: int, patch: dict = Body(...)):
    now = int(time.time())
    with db.tx() as c:
        if "name" in patch:
            c.execute("UPDATE playlists SET name=? WHERE id=?", (patch["name"], pid))
        if "description" in patch:
            c.execute("UPDATE playlists SET description=? WHERE id=?", (patch["description"], pid))
        if "add" in patch:
            pos = (c.execute("SELECT MAX(position) FROM playlist_tracks WHERE playlist_id=?", (pid,)).fetchone()[0]
                   or 0) + 1
            for i, tid in enumerate(patch["add"]):
                c.execute("INSERT INTO playlist_tracks SELECT ?,id,?,? FROM tracks WHERE id=?", (pid, pos + i, now, tid))
        if "order" in patch:  # full list of track ids in the new order
            c.execute("DELETE FROM playlist_tracks WHERE playlist_id=?", (pid,))
            for i, tid in enumerate(patch["order"]):
                c.execute("INSERT INTO playlist_tracks SELECT ?,id,?,? FROM tracks WHERE id=?", (pid, i, now, tid))
        if "remove_index" in patch:  # local tracks have no stable id upstream: remove by index
            rows = c.execute("SELECT rowid FROM playlist_tracks WHERE playlist_id=? ORDER BY position",
                             (pid,)).fetchall()
            idx = int(patch["remove_index"])
            if 0 <= idx < len(rows):
                c.execute("DELETE FROM playlist_tracks WHERE rowid=?", (rows[idx][0],))
        c.execute("UPDATE playlists SET updated_at=? WHERE id=?", (now, pid))
    events.publish("playlists", {})
    return {"ok": True}


@app.delete("/api/playlists/{pid}")
def playlist_delete(pid: int):
    with db.tx() as c:
        c.execute("DELETE FROM playlists WHERE id=?", (pid,))
    events.publish("playlists", {})
    return {"ok": True}


# ------------------------------------------------------------------ organizer

@app.post("/api/organize/plan")
def organize_plan(online: bool = True):
    if not organizer.state["running"]:
        organizer.plan_async(online)
    return {"ok": True}


@app.get("/api/organize")
def organize_state():
    return organizer.state


@app.post("/api/organize/apply")
def organize_apply(album_ids: list[str] = Body(None, embed=True)):
    if organizer.state["running"]:
        raise HTTPException(409, "Still checking your albums")
    return organizer.apply(album_ids)


@app.post("/api/organize/undo")
def organize_undo(log: str = Body(..., embed=True)):
    return organizer.undo(log)


@app.post("/api/tools/ffmpeg")
def tools_ffmpeg():
    return {"ok": tools.install_ffmpeg()}


# ------------------------------------------------------------------ settings & events

@app.get("/api/settings")
def get_settings():
    return {**settings.data, "data_home": str(settings.home),
            "ffmpeg": bool(tools.ffmpeg_exe()), "spotdl": tools.has_spotdl(),
            "ytdlp": downloader.yt_dlp is not None}


@app.patch("/api/settings")
def patch_settings(patch: dict = Body(...)):
    roots_before = list(settings["library_roots"])
    settings.update(patch)
    if settings["library_roots"] != roots_before:
        scanner.scan_async()
    return get_settings()


@app.get("/api/browse")
def browse(path: str = Query("")):
    """Folder picker for Settings (lists drives on Windows)."""
    import os
    import string
    import sys
    if not path:
        if sys.platform == "win32":
            drives = [f"{d}:\\" for d in string.ascii_uppercase if os.path.exists(f"{d}:\\")]
            return {"path": "", "dirs": drives, "parent": None}
        path = "/"
    p = Path(path)
    try:
        dirs = sorted([str(x) for x in p.iterdir() if x.is_dir() and not x.name.startswith(".")], key=str.lower)
    except OSError:
        dirs = []
    parent = str(p.parent) if p.parent != p else ""
    return {"path": str(p), "dirs": dirs[:500], "parent": parent}


@app.get("/api/events")
async def sse(request: Request):
    q = events.subscribe()

    async def gen():
        try:
            yield "event: hello\ndata: {}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=15)
                    yield msg
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            events.unsubscribe(q)
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/")
def index():
    return FileResponse(WEB / "index.html", headers={"Cache-Control": "no-cache"})


app.mount("/", StaticFiles(directory=WEB), name="web")
