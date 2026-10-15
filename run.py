"""Start WaveGrab.

    python run.py                    # check for updates, then open in its own window (or your browser)
    python run.py --browser          # use a browser tab even if pywebview is installed
    python run.py --no-update-check  # skip the update check this time
    python run.py --no-browser       # server only
"""
import argparse
import json
import os
import sys
import threading
import time
import webbrowser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

SPLASH = """<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#0b0b10;color:#f4f4f6;font:15px "Segoe UI",system-ui,sans-serif}
body{display:grid;place-items:center}
.box{text-align:center}
.mark{width:64px;height:64px;border-radius:18px;margin:0 auto 18px;display:grid;place-items:center;
  background:linear-gradient(135deg,#1ed760,#4078ff);color:#04130a}
h1{font-size:26px;margin:0 0 8px;letter-spacing:-.02em}
#s{color:#a4a4ad;min-height:20px}
.bar{width:220px;height:4px;border-radius:9px;background:rgba(255,255,255,.1);margin:18px auto 0;overflow:hidden}
.bar i{display:block;width:35%;height:100%;border-radius:inherit;background:#1ed760;animation:m 1.1s ease-in-out infinite}
@keyframes m{from{transform:translateX(-100%)}to{transform:translateX(300%)}}
</style></head><body><div class="box"><div class="mark"><svg width="34" height="34" viewBox="0 0 24 24">
<path d="M3 13c1.5 0 1.5-4 3-4s1.5 7 3 7 1.5-10 3-10 1.5 7 3 7 1.5-3 3-3 1.5 2 3 2" stroke="currentColor"
stroke-width="2.4" fill="none" stroke-linecap="round"/></svg></div><h1>WaveGrab</h1>
<div id="s">Starting…</div><div class="bar"><i></i></div></div>
<script>function setStatus(t){document.getElementById('s').textContent=t}</script></body></html>"""


def wants_update_check(args):
    if args.no_update_check:
        return False
    from wavegrab.config import data_home
    try:
        cfg = json.loads((data_home() / "config.json").read_text("utf-8"))
        return cfg.get("check_updates", True)
    except (OSError, ValueError):
        return True


def start_server(args):
    import uvicorn
    from wavegrab.config import settings
    from wavegrab.server import app
    port = args.port or settings.get("port", 8765)
    server = uvicorn.Server(uvicorn.Config(app, host=args.host, port=port, log_level="warning"))
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    while not server.started:
        time.sleep(0.05)
    url = f"http://{args.host}:{port}/"
    print(f"WaveGrab running at {url}")
    print(f"Data folder: {settings.home}")
    return url, t


def main():
    ap = argparse.ArgumentParser(description="WaveGrab local music player")
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--browser", action="store_true", help="use a browser tab even if pywebview is installed")
    ap.add_argument("--no-update-check", action="store_true")
    args = ap.parse_args()
    check = wants_update_check(args)
    from wavegrab import updater

    webview = None
    if not args.browser and not args.no_browser:
        try:
            import webview  # pywebview
        except ImportError:
            webview = None

    if webview is None:
        # console / browser mode: update first, then serve
        if check:
            status, msg = updater.run(status=lambda m: print(m))
            print(msg)
            if status == "updated":
                print("Restarting WaveGrab…")
                updater.restart()
        if args.no_browser:
            url, t = start_server(args)
            t.join()
            return
        url, t = start_server(args)
        webbrowser.open(url)
        try:
            while t.is_alive():
                time.sleep(0.5)
        except KeyboardInterrupt:
            pass
        return

    # desktop window: show a splash while checking for updates, then load the app
    window = webview.create_window("WaveGrab", html=SPLASH, width=1400, height=900, min_size=(960, 600),
                                   background_color="#0b0b10")
    state = {"restart": False}

    def boot():
        def say(msg):
            try:
                window.evaluate_js(f"setStatus({json.dumps(msg)})")
            except Exception:  # window not ready yet
                pass
        if check:
            status, msg = updater.run(status=say)
            say(msg)
            if status == "updated":
                say("Updated! Restarting…")
                time.sleep(1.2)
                state["restart"] = True
                window.destroy()
                return
        say("Opening your library…")
        url, _ = start_server(args)
        window.load_url(url)

    webview.start(boot)
    if state["restart"]:
        updater.restart()


if __name__ == "__main__":
    main()
