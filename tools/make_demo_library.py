"""Build a small demo library for testing / screenshots.

Real album metadata + covers come from the Deezer API and lyrics from LRCLIB;
the audio itself is a generated low-bitrate tone of the right length.
Nothing here is meant to be committed.

    python tools/make_demo_library.py <output-folder>
"""
import concurrent.futures as cf
import math
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

ALBUMS = [
    ("Daft Punk", "Discovery"), ("Radiohead", "OK Computer"), ("Kendrick Lamar", "DAMN."),
    ("Fleetwood Mac", "Rumours"), ("Tame Impala", "Currents"), ("The Weeknd", "After Hours"),
    ("Frank Ocean", "Blonde"), ("Arctic Monkeys", "AM"), ("Billie Eilish", "Happier Than Ever"),
    ("Gorillaz", "Demon Days"), ("Lorde", "Melodrama"), ("Mac DeMarco", "Salad Days"),
]


def main(out: Path):
    os.environ.setdefault("WAVEGRAB_HOME", str(out.parent / "wavegrab-home"))
    from wavegrab import catalog, db, lyrics
    db.init()
    from wavegrab.downloader import tag_file, target_path

    out.mkdir(parents=True, exist_ok=True)
    jobs = []
    for artist, title in ALBUMS:
        a = catalog.find_album(artist, title)
        if not a:
            print("not found", artist, title)
            continue
        alb = catalog.album(a["id"])
        cover = catalog.client().get(alb["cover"]).content if alb["cover"] else None
        for t in alb["tracks"][:14]:
            meta = dict(title=t["title"], artist=t["artist"], album=alb["title"], album_artist=alb["artist"],
                        track_no=t["track_no"], disc_no=t["disc_no"], year=alb["year"], genre=alb.get("genre", ""),
                        duration=t["duration"])
            jobs.append((meta, cover))
    print(len(jobs), "tracks")

    def make(job):
        meta, cover = job
        dest = target_path(meta, "mp3")
        dest = out / dest.relative_to(dest.parents[2])
        if dest.exists():
            return
        dest.parent.mkdir(parents=True, exist_ok=True)
        f = 110 * 2 ** ((hash(meta["title"]) % 12) / 12)
        dur = meta["duration"] or 180
        expr = f"0.15*sin(2*PI*{f:.1f}*t)*(0.6+0.4*sin(2*PI*0.5*t))+0.08*sin(2*PI*{f*1.5:.1f}*t)"
        subprocess.run(["ffmpeg", "-v", "quiet", "-y", "-f", "lavfi", "-i", f"aevalsrc={expr}:s=22050:d={dur}",
                        "-ac", "1", "-b:a", "16k", str(dest)], check=True)
        tag_file(dest, meta, cover)
        text = lyrics.fetch(meta["title"], meta["artist"], meta["album"], dur)
        if text:
            dest.with_suffix(".lrc").write_text(text, "utf-8")
        print("ok", dest.name, "(lyrics)" if text else "")

    with cf.ThreadPoolExecutor(8) as ex:
        list(ex.map(make, jobs))


if __name__ == "__main__":
    main(Path(sys.argv[1]))
