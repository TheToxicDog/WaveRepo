"""Library organizer: puts every album's files in track order and removes
duplicate songs.

For each album with 2+ songs:
  1. Duplicates: songs with the same (normalised) title and a duration within
     6 s are the same recording. The best copy is kept (lossless > higher
     bitrate > has lyrics > has cover); the others are moved to a hidden
     `.wavegrab-duplicates` folder next to the music (nothing is deleted).
  2. Order: if every song has a unique track number in its tags, those are
     used. Otherwise the album is looked up online and songs are matched to
     the official tracklist by title. Songs that still have no number go last.
  3. Files are renamed in place to "01 Title.ext" ("2-01 Title.ext" on
     multi-disc albums) so they sort in album order everywhere, the track /
     disc numbers are written into the tags, and .lrc / .txt sidecars follow.

`plan()` only computes changes (shown for review); `apply()` performs them and
writes an undo log to the data folder.
"""
import json
import os
import threading
import time
from pathlib import Path

import mutagen

from . import catalog, db, events, scanner
from .config import settings
from .downloader import track_filename

LOSSLESS = {"flac", "wav", "aif", "aiff", "alac"}
state = {"running": False, "done": 0, "total": 0, "plan": None, "applied": None, "error": ""}
_lock = threading.Lock()


def _quality(t):
    return (t["format"] in LOSSLESS, t["bitrate"] or 0, bool(t["lyrics_plain"]), t["has_cover"], -len(t["path"]))


def _dup_groups(tracks):
    """[(keep, [dupes...]), ...] for one album."""
    groups = {}
    for t in tracks:
        groups.setdefault(catalog.norm_title(t["title"]), []).append(t)
    out = []
    for same_title in groups.values():
        if len(same_title) < 2:
            continue
        # split into recordings by duration so reprises / live takes survive
        clusters = []
        for t in sorted(same_title, key=lambda x: x["duration"] or 0):
            for c in clusters:
                if abs((c[0]["duration"] or 0) - (t["duration"] or 0)) <= 6:
                    c.append(t)
                    break
            else:
                clusters.append([t])
        for c in clusters:
            if len(c) > 1:
                c.sort(key=_quality, reverse=True)
                out.append((c[0], c[1:]))
    return out


def _online_order(album, tracks, use_online):
    """Map track id -> (disc, no) from the official tracklist."""
    if not use_online or not settings.get("online", True):
        return {}, None
    try:
        found = catalog.find_album(album["artist"], album["title"])
        if not found:
            return {}, None
        official = catalog.album(found["id"])["tracks"]
    except Exception:  # offline / not found: fall back to tags + filenames
        return {}, None
    by_title = {}
    for ot in official:
        by_title.setdefault(catalog.norm_title(ot["title"]), []).append(ot)
    result = {}
    for t in tracks:
        cands = by_title.get(catalog.norm_title(t["title"]))
        if not cands:
            continue
        best = min(cands, key=lambda o: abs((o.get("duration") or 0) - (t["duration"] or 0)))
        result[t["id"]] = (best.get("disc_no") or 1, best["track_no"])
    return result, found["id"]


def _album_plan(album, use_online):
    tracks = db.rows("SELECT id, path, title, duration, format, bitrate, has_cover, lyrics_plain, track_no, disc_no "
                     "FROM tracks WHERE album_id=?", (album["id"],))
    if len(tracks) < 2:
        return None
    dups = []
    drop = set()
    for keep, extra in _dup_groups(tracks):
        for d in extra:
            drop.add(d["id"])
            dups.append({"track_id": d["id"], "path": d["path"], "title": d["title"], "keep_path": keep["path"]})
    tracks = [t for t in tracks if t["id"] not in drop]

    # -------- order
    keys = [((t["disc_no"] or 1), t["track_no"]) for t in tracks]
    tags_ok = all(t["track_no"] for t in tracks) and len(set(keys)) == len(keys)
    source = "tags"
    order = {t["id"]: ((t["disc_no"] or 1), t["track_no"]) for t in tracks} if tags_ok else {}
    catalog_id = None
    if not tags_ok:
        order, catalog_id = _online_order(album, tracks, use_online)
        source = "online" if order else "filenames"
        # songs the tracklist didn't cover: keep their tag number if it's free, else number after the rest
        taken = set(order.values())
        leftovers = sorted([t for t in tracks if t["id"] not in order],
                           key=lambda t: (t["disc_no"] or 1, t["track_no"] or 999, Path(t["path"]).name.lower()))
        for t in leftovers:
            k = ((t["disc_no"] or 1), t["track_no"])
            if t["track_no"] and k not in taken:
                order[t["id"]] = k
                taken.add(k)
        for t in leftovers:
            if t["id"] in order:
                continue
            disc = t["disc_no"] or 1
            n = max([k[1] for k in taken if k[0] == disc] or [0]) + 1
            order[t["id"]] = (disc, n)
            taken.add((disc, n))
    multi = len({d for d, _ in order.values()}) > 1

    renames = []
    for t in tracks:
        disc, no = order[t["id"]]
        old = Path(t["path"])
        new = old.with_name(track_filename(t["title"], no, disc, multi) + old.suffix.lower())
        retag = (t["track_no"] != no) or ((t["disc_no"] or 1) != disc)
        if new.name != old.name or retag:
            renames.append({"track_id": t["id"], "old": str(old), "new": str(new), "track_no": no, "disc_no": disc,
                            "retag": retag, "title": t["title"]})
    if not renames and not dups:
        return None
    renames.sort(key=lambda r: (r["disc_no"], r["track_no"]))
    return {"album_id": album["id"], "title": album["title"], "artist": album["artist"], "source": source,
            "catalog_id": catalog_id, "renames": renames, "duplicates": dups}


def plan_async(use_online=True):
    def run():
        with _lock:
            state.update(running=True, done=0, plan=None, applied=None, error="")
            albums = db.rows("SELECT id, title, artist FROM albums WHERE track_count > 1 ORDER BY artist, title")
            state["total"] = len(albums)
            out = []
            try:
                for i, a in enumerate(albums):
                    p = _album_plan(a, use_online)
                    if p:
                        out.append(p)
                    state["done"] = i + 1
                    if i % 5 == 0:
                        events.publish("organize", {k: v for k, v in state.items() if k != "plan"})
            except Exception as e:  # noqa: BLE001
                state["error"] = str(e)
            state.update(running=False, plan=out)
            events.publish("organize", {k: v for k, v in state.items() if k != "plan"})
    threading.Thread(target=run, daemon=True).start()


def _write_numbers(path: Path, no, disc):
    try:
        f = mutagen.File(path, easy=True)
        if f is None:
            return
        if f.tags is None:
            f.add_tags()
        f["tracknumber"] = str(no)
        f["discnumber"] = str(disc)
        f.save()
    except Exception:  # some formats (WMA) have no easy tags: rename only
        pass


def _move_with_sidecars(src: Path, dst: Path, log):
    for ext in ("", ".lrc", ".txt"):
        s = src if not ext else src.with_suffix(ext)
        d = dst if not ext else dst.with_suffix(ext)
        if s.exists() and s != d:
            d.parent.mkdir(parents=True, exist_ok=True)
            os.replace(s, d)
            log.append({"from": str(s), "to": str(d)})


def apply(album_ids=None):
    plan = state.get("plan") or []
    if album_ids:
        plan = [p for p in plan if p["album_id"] in set(album_ids)]
    log, errors, renamed, removed = [], [], 0, 0
    for p in plan:
        for d in p["duplicates"]:
            src = Path(d["path"])
            if not src.exists():
                continue
            root = next((Path(r) for r in settings["library_roots"] if str(src).startswith(str(Path(r)))), src.parent)
            dst = root / ".wavegrab-duplicates" / src.relative_to(root) if src.is_relative_to(root) else \
                src.parent / ".wavegrab-duplicates" / src.name
            try:
                _move_with_sidecars(src, dst, log)
                with db.tx() as c:
                    c.execute("DELETE FROM tracks WHERE id=?", (d["track_id"],))
                removed += 1
                try:
                    if src.parent != root and not any(src.parent.iterdir()):
                        src.parent.rmdir()  # don't leave empty folders behind
                except OSError:
                    pass
            except OSError as e:
                errors.append(f"{src.name}: {e}")
        # two-step rename (via temp names) so swapping "01 A" <-> "02 B" can't collide
        staged = []
        for r in p["renames"]:
            old, new = Path(r["old"]), Path(r["new"])
            if not old.exists():
                continue
            if r["retag"]:
                _write_numbers(old, r["track_no"], r["disc_no"])
            if old == new:
                continue
            tmp = old.with_name(f".wg-tmp-{r['track_id']}{old.suffix}")
            try:
                _move_with_sidecars(old, tmp, log)
                staged.append((tmp, new, r))
            except OSError as e:
                errors.append(f"{old.name}: {e}")
        for tmp, new, r in staged:
            target = new
            if target.exists():  # a file we don't know about already has that name
                target = new.with_name(f"{new.stem} ({r['track_id']}){new.suffix}")
            try:
                _move_with_sidecars(tmp, target, log)
                with db.tx() as c:
                    c.execute("UPDATE tracks SET path=?, lrc_path=CASE WHEN lrc_path IS NULL THEN NULL ELSE ? END, "
                              "track_no=?, disc_no=?, mtime=? WHERE id=?",
                              (str(target), str(target.with_suffix(".lrc")), r["track_no"], r["disc_no"],
                               target.stat().st_mtime, r["track_id"]))
                renamed += 1
            except OSError as e:
                errors.append(f"{tmp.name}: {e}")
    stamp = time.strftime("%Y%m%d-%H%M%S")
    undo = settings.home / f"organize-undo-{stamp}.json"
    undo.write_text(json.dumps(log, indent=1), "utf-8")
    with db.tx() as c:
        scanner.rebuild_aggregates(c)
    result = {"renamed": renamed, "duplicates_moved": removed, "errors": errors, "undo_log": str(undo)}
    state.update(applied=result, plan=None)
    events.publish("library", {"reason": "organize"})
    return result


def undo(log_path: str):
    """Reverse an apply() using its log (newest move first)."""
    entries = json.loads(Path(log_path).read_text("utf-8"))
    for e in reversed(entries):
        if Path(e["to"]).exists() and not Path(e["from"]).exists():  # (re)creates removed folders too
            Path(e["from"]).parent.mkdir(parents=True, exist_ok=True)
            os.replace(e["to"], e["from"])
    scanner.scan_async(full=True)
    return {"restored": len(entries)}
