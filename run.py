"""Start WaveGrab.

    python run.py              # opens in its own window (pywebview) or your browser
    python run.py --no-browser # server only
"""
import argparse
import os
import sys
import threading
import time
import webbrowser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def main():
    ap = argparse.ArgumentParser(description="WaveGrab local music player")
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--browser", action="store_true", help="use a browser tab even if pywebview is installed")
    args = ap.parse_args()

    import uvicorn
    from wavegrab.config import settings
    from wavegrab.server import app

    port = args.port or settings.get("port", 8765)
    url = f"http://{args.host}:{port}/"
    server = uvicorn.Server(uvicorn.Config(app, host=args.host, port=port, log_level="warning"))
    print(f"WaveGrab running at {url}")
    print(f"Data folder: {settings.home}")

    if args.no_browser:
        server.run()
        return
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    while not server.started:
        time.sleep(0.05)
    try:
        if args.browser:
            raise ImportError
        import webview  # pywebview
        webview.create_window("WaveGrab", url, width=1400, height=900, min_size=(960, 600),
                              background_color="#0b0b10")
        webview.start()
    except ImportError:
        webbrowser.open(url)
        try:
            while t.is_alive():
                time.sleep(0.5)
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
