"""Self-updater, run by run.py every time WaveGrab opens.

Two install styles are supported:
  * a git clone       -> `git fetch` + `git pull --ff-only` (skipped if you edited files)
  * a downloaded zip  -> compare the latest commit on GitHub with the one we
                         installed, download that commit's zip and copy it over
                         the app folder (your .venv and data are left alone)
If requirements.txt changed, the new packages are installed. Offline or any
error -> WaveGrab just opens the version you have. Standard library only, so it
works even if a dependency is broken.
"""
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
DEFAULT_REPO = "TheToxicDog/WaveRepo"
SKIP = {".venv", ".git", "__pycache__", ".pytest_cache"}
last_result = {"status": "not-checked", "message": ""}


def _get(url, timeout=8):
    req = urllib.request.Request(url, headers={"User-Agent": "WaveGrab-updater", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _git(*args, timeout=30):
    return subprocess.run(["git", "-C", str(APP_DIR), *args], capture_output=True, text=True, timeout=timeout)


def _req_hash():
    p = APP_DIR / "requirements.txt"
    return hashlib.sha1(p.read_bytes()).hexdigest() if p.exists() else ""


def _install_requirements(status):
    status("Installing new requirements…")
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-r", str(APP_DIR / "requirements.txt")],
                   timeout=1800)


def current_version():
    v = APP_DIR / "VERSION"
    return v.read_text().strip() if v.exists() else "dev"


def _update_git(status):
    br = _git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    if not br or br == "HEAD":
        return "skipped", "Not on a branch"
    status("Checking for updates…")
    if _git("fetch", "--quiet", "origin", br, timeout=25).returncode:
        return "offline", "Couldn't reach GitHub"
    behind = _git("rev-list", "--count", f"HEAD..origin/{br}").stdout.strip()
    if not behind or behind == "0":
        return "current", "You're on the latest version"
    if _git("status", "--porcelain", "--untracked-files=no").stdout.strip():
        return "skipped", f"{behind} update(s) available, but you have edited files, so the update was skipped"
    status(f"Downloading {behind} update(s)…")
    before = _req_hash()
    if _git("pull", "--ff-only", "--quiet", "origin", br, timeout=120).returncode:
        return "skipped", "Couldn't apply the update automatically"
    if _req_hash() != before:
        _install_requirements(status)
    return "updated", f"Updated ({behind} change(s))"


def _update_zip(status, data_home: Path, repo: str):
    marker = data_home / "installed_commit"
    status("Checking for updates…")
    info = json.loads(_get(f"https://api.github.com/repos/{repo}"))
    branch = info.get("default_branch", "main")
    latest = json.loads(_get(f"https://api.github.com/repos/{repo}/commits/{branch}"))["sha"]
    installed = marker.read_text().strip() if marker.exists() else ""
    if not installed:
        # first run of a fresh download: assume it's current, remember it
        marker.write_text(latest)
        return "current", "You're on the latest version"
    if installed == latest:
        return "current", "You're on the latest version"
    status("Downloading the update…")
    data = _get(f"https://codeload.github.com/{repo}/zip/{latest}", timeout=120)
    before = _req_hash()
    with tempfile.TemporaryDirectory() as td:
        zipfile.ZipFile(io.BytesIO(data)).extractall(td)
        root = next(Path(td).iterdir())  # zip has one top-level folder
        status("Installing the update…")
        for src in root.rglob("*"):
            rel = src.relative_to(root)
            if rel.parts and rel.parts[0] in SKIP:
                continue
            dst = APP_DIR / rel
            if src.is_dir():
                dst.mkdir(parents=True, exist_ok=True)
            else:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
    marker.write_text(latest)
    if _req_hash() != before:
        _install_requirements(status)
    return "updated", "Updated to the latest version"


def run(status=print, data_home: Path | None = None, repo: str = DEFAULT_REPO):
    """Check for an update and install it. Returns (status, message) where status is
    updated | current | skipped | offline | error."""
    if data_home is None:
        from .config import data_home as _dh
        data_home = _dh()
    try:
        if (APP_DIR / ".git").exists() and shutil.which("git"):
            result = _update_git(status)
        else:
            result = _update_zip(status, data_home, repo)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError, zipfile.BadZipFile) as e:
        result = ("offline", f"Couldn't check for updates ({e.__class__.__name__})")
    last_result.update(status=result[0], message=result[1])
    return result


def restart():
    """Start a fresh copy of WaveGrab (new code) and exit this one."""
    args = [a for a in sys.argv if a != "--no-update-check"] + ["--no-update-check"]
    if os.name == "nt":
        subprocess.Popen([sys.executable] + args, cwd=str(APP_DIR))
        os._exit(0)
    os.execv(sys.executable, [sys.executable] + args)
