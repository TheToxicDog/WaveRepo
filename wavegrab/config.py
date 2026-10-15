"""User settings, stored as JSON in the WaveGrab data folder.

Data folder: %APPDATA%\\WaveGrab on Windows, ~/.wavegrab elsewhere
(override with the WAVEGRAB_HOME environment variable).
"""
import json
import os
import string
import sys
import threading
from pathlib import Path

AUDIO_EXTS = {".mp3", ".flac", ".m4a", ".mp4", ".aac", ".ogg", ".opus", ".wav",
              ".aif", ".aiff", ".wma", ".webm", ".alac"}


def data_home() -> Path:
    env = os.environ.get("WAVEGRAB_HOME")
    if env:
        p = Path(env)
    elif sys.platform == "win32" and os.environ.get("APPDATA"):
        p = Path(os.environ["APPDATA"]) / "WaveGrab"
    else:
        p = Path.home() / ".wavegrab"
    p.mkdir(parents=True, exist_ok=True)
    (p / "cache" / "covers").mkdir(parents=True, exist_ok=True)
    (p / "cache" / "catalog").mkdir(parents=True, exist_ok=True)
    return p


def detect_external_music_folders() -> list[str]:
    """Look for a Music folder on removable/extra drives (Windows: D:..Z:)."""
    found = []
    if sys.platform == "win32":
        for letter in string.ascii_uppercase[3:]:
            for name in ("Music", "music", "Musik"):
                p = Path(f"{letter}:/") / name
                try:
                    if p.is_dir():
                        found.append(str(p))
                        break
                except OSError:
                    pass
    else:
        for base in ("/media", "/mnt", "/Volumes"):
            b = Path(base)
            if not b.is_dir():
                continue
            for p in b.glob("*/Music"):
                found.append(str(p))
            for p in b.glob("*/*/Music"):
                found.append(str(p))
    return found


def _default_settings() -> dict:
    external = detect_external_music_folders()
    home_music = str(Path.home() / "Music")
    roots = external + [home_music]
    return {
        # Folders scanned for music. External drive first = preferred.
        "library_roots": roots,
        # Where new downloads land. Defaults to the external drive when present.
        "download_dir": external[0] if external else home_music,
        "audio_format": "m4a",          # m4a | mp3 | opus | flac
        "mp3_quality": "320",
        "folder_template": "{album_artist}/{album}/{track:02d} {title}",
        "fetch_lyrics": True,
        "cookies_file": "",              # optional YouTube Music cookies.txt (256 kbps)
        "cookies_browser": "",           # or read cookies from a browser: chrome | edge | firefox | brave
        "max_parallel_downloads": 1,
        "theme": "midnight",
        "effects": "ripples",            # ripples | particles | glow | off
        "effects_intensity": 0.7,
        "adaptive_color": True,          # tint UI with the playing album's colour
        "crossfade": 0,
        "shuffle_mode": "fewer_repeats", # standard | balanced | fewer_repeats
        "eq_enabled": False,
        "eq_preset": "flat",
        "eq_gains": [0] * 10,
        "online": True,                  # allow catalog lookups / downloads
        "port": 8765,
    }


class Settings:
    def __init__(self):
        self.home = data_home()
        self.path = self.home / "config.json"
        self._lock = threading.Lock()
        self.data = _default_settings()
        if self.path.exists():
            try:
                self.data.update(json.loads(self.path.read_text("utf-8")))
            except (OSError, ValueError):
                pass
        self.save()

    def __getitem__(self, key):
        return self.data[key]

    def get(self, key, default=None):
        return self.data.get(key, default)

    def update(self, patch: dict):
        allowed = _default_settings().keys()
        with self._lock:
            for k, v in patch.items():
                if k in allowed:
                    self.data[k] = v
            self.save()

    def save(self):
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, indent=2), "utf-8")
        os.replace(tmp, self.path)

    @property
    def db_path(self) -> Path:
        return self.home / "library.db"

    @property
    def cover_cache(self) -> Path:
        return self.home / "cache" / "covers"

    @property
    def catalog_cache(self) -> Path:
        return self.home / "cache" / "catalog"


settings = Settings()
