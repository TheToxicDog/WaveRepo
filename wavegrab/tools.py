"""Locating the external tools WaveGrab drives: FFmpeg and spotDL.

spotDL is a required dependency (requirements.txt) and is always run as
`<this python> -m spotdl`, so it works inside the .venv even when the venv's
Scripts folder isn't on PATH. spotDL can also install FFmpeg for us
(`spotdl --download-ffmpeg` puts it in ~/.spotdl/).
"""
import importlib.util
import shutil
import subprocess
import sys
from pathlib import Path


def ffmpeg_exe() -> str | None:
    found = shutil.which("ffmpeg")
    if found:
        return found
    for name in ("ffmpeg.exe", "ffmpeg"):
        p = Path.home() / ".spotdl" / name
        if p.exists():
            return str(p)
    return None


def has_spotdl() -> bool:
    return importlib.util.find_spec("spotdl") is not None


def spotdl_cmd() -> list[str]:
    return [sys.executable, "-m", "spotdl"]


def install_ffmpeg() -> bool:
    """Let spotDL download a static FFmpeg build into ~/.spotdl."""
    if not has_spotdl():
        return False
    try:
        subprocess.run(spotdl_cmd() + ["--download-ffmpeg"], input="y\n", text=True,
                       capture_output=True, timeout=600)
    except (OSError, subprocess.SubprocessError):
        return False
    return ffmpeg_exe() is not None
