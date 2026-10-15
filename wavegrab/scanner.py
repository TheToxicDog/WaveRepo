"""Library scanner: walks the music folders, reads tags with mutagen,
extracts cover art and indexes lyrics (.lrc sidecars or embedded).

Incremental: a file is only re-read when its size or mtime changed.
Tracks on a drive that is currently unplugged are kept (not deleted), so
unplugging the external drive never wipes your library.
"""
import hashlib
import os
import re
import threading
import time
import unicodedata
from pathlib import Path

import mutagen

from . import db, events, lrc
from .config import AUDIO_EXTS, settings

_scan_lock = threading.Lock()
scan_state = {"running": False, "done": 0, "total": 0, "current": "", "last_scan": 0}

COVER_NAMES = ("cover", "folder", "front", "album", "albumart", "albumartsmall")


def norm(s: str) -> str:
    """Normalise names for matching: lowercase, no accents, no punctuation,
    no '(Deluxe Edition)' style suffixes."""
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    s = s.lower()
    s = re.sub(r"\s*[\(\[][^)\]]*(deluxe|remaster|edition|version|expanded|anniversary|bonus)[^)\]]*[\)\]]", "", s)
    s = re.sub(r"^the\s+", "", s)
    s = s.replace("&", "and")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return s.strip()


def make_id(*parts) -> str:
    return hashlib.sha1("|".join(norm(p) for p in parts).encode()).hexdigest()[:16]


def primary_artist(name: str) -> str:
    return re.split(r"\s*(?:;|/|,| feat\.? | ft\.? | featuring | x )\s*", name or "", maxsplit=1, flags=re.I)[0].strip() or name


def _first(tags, *keys):
    if not tags:
        return ""
    for k in keys:
        try:
            v = tags.get(k)
        except (KeyError, ValueError):
            v = None
        if v:
            if isinstance(v, list):
                v = v[0]
            v = str(v).strip()
            if v:
                return v
    return ""


def _num(v):
    m = re.match(r"\s*(\d+)", str(v or ""))
    return int(m.group(1)) if m else None


def read_tags(path: Path) -> dict:
    info = {"title": "", "artist": "", "album": "", "album_artist": "", "genre": "",
            "year": None, "track_no": None, "disc_no": None, "duration": 0.0,
            "bitrate": None, "sample_rate": None, "lyrics": ""}
    try:
        easy = mutagen.File(path, easy=True)
    except Exception:
        easy = None
    if easy is not None:
        t = easy.tags
        info["title"] = _first(t, "title", "Title")
        info["artist"] = _first(t, "artist", "Author", "WM/AlbumArtist")
        info["album"] = _first(t, "album", "WM/AlbumTitle")
        info["album_artist"] = _first(t, "albumartist", "album artist", "WM/AlbumArtist")
        info["genre"] = _first(t, "genre", "WM/Genre")
        info["year"] = _num(_first(t, "date", "originaldate", "year", "WM/Year"))
        info["track_no"] = _num(_first(t, "tracknumber", "WM/TrackNumber"))
        info["disc_no"] = _num(_first(t, "discnumber", "WM/PartOfSet"))
        if easy.info:
            info["duration"] = float(getattr(easy.info, "length", 0) or 0)
            info["bitrate"] = getattr(easy.info, "bitrate", None)
            info["sample_rate"] = getattr(easy.info, "sample_rate", None)
    # embedded lyrics need the full (non-easy) tag set
    try:
        full = mutagen.File(path)
        tags = full.tags if full else None
        if tags is not None:
            if hasattr(tags, "getall"):  # ID3
                for fr in tags.getall("USLT"):
                    info["lyrics"] = str(fr.text)
                    break
            else:
                info["lyrics"] = _first(tags, "\xa9lyr", "lyrics", "LYRICS", "unsyncedlyrics", "UNSYNCEDLYRICS")
    except Exception:
        pass
    # filename / folder fallbacks
    stem = path.stem
    if not info["title"]:
        m = re.match(r"^\s*(\d{1,3})[\s.\-_]+(.*)$", stem)
        if m:
            info["track_no"] = info["track_no"] or int(m.group(1))
            stem = m.group(2)
        if " - " in stem and not info["artist"]:
            a, _, ttl = stem.partition(" - ")
            info["artist"], stem = a.strip(), ttl.strip()
        info["title"] = stem.strip() or path.stem
    if not info["album"]:
        info["album"] = path.parent.name or "Unknown Album"
    if not info["artist"]:
        info["artist"] = info["album_artist"] or path.parent.parent.name or "Unknown Artist"
    if not info["album_artist"]:
        info["album_artist"] = primary_artist(info["artist"])
    return info


def extract_cover(path: Path):
    """Return embedded cover bytes, or None."""
    try:
        f = mutagen.File(path)
    except Exception:
        return None
    if f is None:
        return None
    tags = f.tags
    try:
        if hasattr(f, "pictures") and f.pictures:  # FLAC
            return f.pictures[0].data
        if tags is None:
            return None
        if hasattr(tags, "getall"):  # ID3
            pics = tags.getall("APIC")
            if pics:
                front = [p for p in pics if p.type == 3]
                return (front or pics)[0].data
        if "covr" in tags:  # MP4
            return bytes(tags["covr"][0])
        for key in ("metadata_block_picture", "METADATA_BLOCK_PICTURE"):
            if key in tags:  # Ogg / Opus
                import base64
                from mutagen.flac import Picture
                return Picture(base64.b64decode(tags[key][0])).data
        if "WM/Picture" in tags:  # WMA
            raw = tags["WM/Picture"][0].value
            # ASF picture: type(1) size(4) mime(utf16z) desc(utf16z) data
            i = 5
            for _ in range(2):
                while raw[i:i + 2] != b"\x00\x00":
                    i += 2
                i += 2
            return raw[i:]
    except Exception:
        return None
    return None


def folder_cover(folder: Path):
    try:
        for p in folder.iterdir():
            if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp") and \
                    p.stem.lower().split("_")[0].split(" ")[0] in COVER_NAMES:
                return p
    except OSError:
        pass
    return None


def find_lyrics(path: Path, embedded: str):
    sidecar = path.with_suffix(".lrc")
    if sidecar.exists():
        try:
            return str(sidecar), sidecar.read_text("utf-8", errors="replace")
        except OSError:
            pass
    txt = path.with_suffix(".txt")
    if txt.exists() and txt.stat().st_size < 64_000:
        try:
            return None, txt.read_text("utf-8", errors="replace")
        except OSError:
            pass
    return None, embedded or ""


def index_file(conn, path: Path, root: str, st=None):
    st = st or path.stat()
    tags = read_tags(path)
    lrc_path, lyr_text = find_lyrics(path, tags["lyrics"])
    parsed = lrc.parse(lyr_text)
    album_id = make_id(tags["album_artist"], tags["album"])
    artist_id = make_id(tags["album_artist"])
    has_cover = 1 if extract_cover(path) else 0
    now = int(time.time())
    existing = conn.execute("SELECT id, added_at FROM tracks WHERE path=?", (str(path),)).fetchone()
    vals = dict(path=str(path), root=root, lrc_path=lrc_path, title=tags["title"], artist=tags["artist"],
                album=tags["album"], album_artist=tags["album_artist"], album_id=album_id, artist_id=artist_id,
                genre=tags["genre"], year=tags["year"], track_no=tags["track_no"], disc_no=tags["disc_no"],
                duration=tags["duration"], bitrate=tags["bitrate"], sample_rate=tags["sample_rate"],
                format=path.suffix.lower().lstrip("."), size=st.st_size, mtime=st.st_mtime, has_cover=has_cover,
                lyrics_plain=parsed["plain"], lyrics_synced=1 if parsed["synced"] else 0)
    if existing:
        tid = existing["id"]
        sets = ", ".join(f"{k}=:{k}" for k in vals)
        conn.execute(f"UPDATE tracks SET {sets} WHERE id=:id", {**vals, "id": tid})
        conn.execute("DELETE FROM lyric_lines WHERE track_id=?", (tid,))
    else:
        vals["added_at"] = int(min(st.st_mtime, now)) if st.st_mtime > 0 else now
        cols = ", ".join(vals)
        ph = ", ".join(f":{k}" for k in vals)
        tid = conn.execute(f"INSERT INTO tracks ({cols}) VALUES ({ph})", vals).lastrowid
    if parsed["synced"]:
        conn.executemany(
            "INSERT INTO lyric_lines(track_id, timestamp_ms, line_index, lyric_text) VALUES (?,?,?,?)",
            [(tid, l["t"], i, l["text"]) for i, l in enumerate(parsed["lines"]) if l["text"]])
    return tid


def rebuild_aggregates(conn):
    """Recompute albums/artists tables and cache album covers."""
    now = int(time.time())
    conn.execute("DELETE FROM albums")
    conn.execute("""
        INSERT INTO albums(id, title, artist, artist_id, year, genre, track_count, duration, added_at, norm)
        SELECT album_id, MAX(album), MAX(album_artist), MAX(artist_id), MAX(year), MAX(genre),
               COUNT(*), SUM(duration), MAX(added_at), ''
        FROM tracks GROUP BY album_id""")
    for a in conn.execute("SELECT id, title, artist FROM albums").fetchall():
        conn.execute("UPDATE albums SET norm=? WHERE id=?", (norm(a["artist"]) + "|" + norm(a["title"]), a["id"]))
    conn.execute("DELETE FROM artists")
    conn.execute("""
        INSERT INTO artists(id, name, album_count, track_count, norm)
        SELECT artist_id, MAX(album_artist), COUNT(DISTINCT album_id), COUNT(*), ''
        FROM tracks GROUP BY artist_id""")
    for a in conn.execute("SELECT id, name FROM artists").fetchall():
        conn.execute("UPDATE artists SET norm=?, cover_album=(SELECT id FROM albums WHERE artist_id=? "
                     "ORDER BY year DESC LIMIT 1) WHERE id=?", (norm(a["name"]), a["id"], a["id"]))
    # restore artist images fetched from the catalog earlier
    for k, v in conn.execute("SELECT k, v FROM kv WHERE k LIKE 'artist_img:%'").fetchall():
        conn.execute("UPDATE artists SET image_url=? WHERE id=?", (v, k.split(":", 1)[1]))
    cache = settings.cover_cache
    for a in conn.execute("SELECT id FROM albums").fetchall():
        aid = a["id"]
        target = cache / f"{aid}.jpg"
        if target.exists():
            conn.execute("UPDATE albums SET cover=? WHERE id=?", (str(target), aid))
            continue
        tracks = conn.execute("SELECT path, has_cover FROM tracks WHERE album_id=? ORDER BY has_cover DESC, "
                              "disc_no, track_no LIMIT 3", (aid,)).fetchall()
        data = None
        for t in tracks:
            p = Path(t["path"])
            if t["has_cover"]:
                data = extract_cover(p)
            if not data:
                fc = folder_cover(p.parent)
                if fc:
                    try:
                        data = fc.read_bytes()
                    except OSError:
                        pass
            if data:
                break
        if data:
            target.write_bytes(data)
            conn.execute("UPDATE albums SET cover=? WHERE id=?", (str(target), aid))
    conn.execute("INSERT OR REPLACE INTO kv(k, v) VALUES ('last_scan', ?)", (str(now),))


def scan(full: bool = False):
    if not _scan_lock.acquire(blocking=False):
        return False
    try:
        scan_state.update(running=True, done=0, total=0, current="")
        events.publish("scan", scan_state)
        roots = [r for r in settings["library_roots"] if r]
        files = []
        live_roots = []
        for root in roots:
            rp = Path(root)
            if not rp.is_dir():
                continue
            live_roots.append(str(rp))
            for dirpath, dirnames, filenames in os.walk(rp):
                dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in ("$RECYCLE.BIN", "Music Videos")]
                for fn in filenames:
                    if os.path.splitext(fn)[1].lower() in AUDIO_EXTS and not fn.startswith("._"):
                        files.append((Path(dirpath) / fn, str(rp)))
        scan_state["total"] = len(files)
        conn = db.connect()
        known = {r["path"]: (r["mtime"], r["size"]) for r in conn.execute("SELECT path, mtime, size FROM tracks")}
        seen = set()
        batch = 0
        with db.tx() as c:
            for i, (p, root) in enumerate(files):
                sp = str(p)
                seen.add(sp)
                try:
                    st = p.stat()
                    k = known.get(sp)
                    if full or not k or abs(k[0] - st.st_mtime) > 1 or k[1] != st.st_size:
                        index_file(c, p, root, st)
                        batch += 1
                except Exception as e:  # unreadable file: skip, keep scanning
                    print(f"[scan] skip {p}: {e}")
                scan_state["done"] = i + 1
                if i % 50 == 0:
                    scan_state["current"] = p.name
                    events.publish("scan", scan_state)
                if batch >= 200:
                    c.commit()
                    batch = 0
            # remove tracks that vanished from a drive that IS connected
            for sp in known:
                if sp in seen:
                    continue
                if any(sp.startswith(r) for r in live_roots) or not any(sp.startswith(r) for r in roots):
                    if not os.path.exists(sp):
                        c.execute("DELETE FROM tracks WHERE path=?", (sp,))
            rebuild_aggregates(c)
        scan_state.update(running=False, last_scan=int(time.time()), current="")
        events.publish("scan", scan_state)
        events.publish("library", {"reason": "scan"})
        return True
    finally:
        scan_state["running"] = False
        _scan_lock.release()


def index_single(path: Path):
    """Add one freshly downloaded file without a full rescan."""
    root = ""
    for r in settings["library_roots"]:
        if str(path).startswith(str(Path(r))):
            root = str(Path(r))
    with db.tx() as c:
        tid = index_file(c, path, root)
        rebuild_aggregates(c)
    events.publish("library", {"reason": "download", "track_id": tid})
    return tid


def scan_async(full=False):
    t = threading.Thread(target=scan, kwargs={"full": full}, daemon=True)
    t.start()
    return t
