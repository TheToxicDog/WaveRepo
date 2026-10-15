# WaveGrab architecture

WaveGrab follows the same split the research report describes for Spotify's desktop client: a **native back end** for files, indexing, downloading and serving audio, and a **web front end** for the interface. Here the back end is Python (FastAPI) instead of C++, and the front end is plain HTML/CSS/JS modules with no build step, shown in a pywebview window (or a browser tab).

```
┌──────────────────────────── web/ (UI, runs in pywebview / browser) ───────────────────────────┐
│ app.js  router, sidebar, player bar      views/*  pages      components.js  cards + track lists │
│ player.js  2× <audio> → Web Audio graph (fade gains → preamp → 10 biquads → volume → analyser) │
│ shuffle.js  standard / balanced / fewer-repeats     panel.js  queue · synced lyrics · EQ curve │
│ fx.js  ambient background canvas: two drifting colour blobs that swell with the music          │
└──────────────▲───────────────── JSON over HTTP  +  Server-Sent Events (/api/events) ───────────┘
               │
┌──────────────┴──────────────────────── wavegrab/ (Python) ────────────────────────────────────┐
│ server.py     FastAPI routes, range-request audio streaming, ffmpeg transcode for WMA/AIFF     │
│ scanner.py    walks music folders, mutagen tags, covers, .lrc sidecars → SQLite (incremental)  │
│ db.py         schema: tracks, albums, artists, lyric_lines, playlists, downloads + 2 FTS5 tables│
│ lrc.py        resilient LRC parser                                                             │
│ catalog.py    Deezer public API (keyless): search, albums, artists, charts, genres + disk cache │
│ downloader.py persistent queue + workers: spotDL (fallback: own YouTube match + yt-dlp) → tag → │
│               lyrics → file as NN Title into the album's folder → index                          │
│ organizer.py  renumbers album files in official track order, removes duplicate songs, undo log    │
│ tools.py      finds FFmpeg (PATH or spotDL's ~/.spotdl) and runs spotDL as `python -m spotdl`    │
│ lyrics.py     LRCLIB lookup (exact /get, then scored /search)                                  │
│ events.py     thread-safe pub/sub feeding the SSE stream                                       │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Library and storage

- **Scanning** (`scanner.py`) walks every folder in *Settings → Music folders*. A file is only re-read when its size or mtime changes, so rescans are fast. Tags come from mutagen's "easy" interface (ID3, MP4, FLAC, Vorbis/Opus, ASF). Missing tags fall back to the file and folder names (`01 - Title.mp3`, `Artist/Album/`).
- **Grouping.** An album's ID is a hash of the normalised *album artist + album title*. Normalising lower-cases, strips accents and punctuation, and drops "(Deluxe Edition)"-style suffixes, so a song's album still lines up when the tags differ slightly.
- **Unplugged drives.** Tracks are only deleted when their folder is connected and the file is gone. Unplugging the external drive never removes anything.
- **Covers** are pulled from embedded art (APIC / covr / FLAC pictures / METADATA_BLOCK_PICTURE / WM/Picture) or from `cover.jpg`/`folder.jpg`, and cached per album in the data folder.
- **Database:** SQLite in WAL mode at `%APPDATA%\WaveGrab\library.db`. This plays the role of Spotify's `.bnk` local-file index: the app starts instantly without rescanning the disk.

## Search (SQLite FTS5)

As the report recommends, there are two external-content FTS5 tables kept in sync by triggers:

| table | columns | used for |
|---|---|---|
| `tracks_fts` | title, artist, album, genre, lyrics_plain | main search, weighted `bm25(10, 5, 3, 2, 1)` so title and artist matches beat a stray word in the lyrics |
| `lyric_lines_fts` | lyric_text (+ track_id, timestamp_ms) | "In the lyrics" results that know *when* the line is sung |

Each search token becomes a prefix query (`"blinding"* AND "lig"*`), so results update as you type. `highlight()` and `snippet()` produce the bold title and `<mark>`ed lyric excerpts. Clicking a lyric hit starts the song at that line's timestamp.

## Lyrics

`lrc.py` handles the edge cases the report lists: `[offset:±ms]`, multi-timestamp chorus lines (unrolled and sorted), lines without a timestamp (attached to the line before), blank-line collapsing, header tags (`[ar:]`, `[ti:]`…) and inline word timings (`<mm:ss.xx>`, kept for karaoke and stripped from the indexed text).

Sources, in order: a sidecar `.lrc` with the same name as the song, a `.txt` sidecar, then embedded lyrics (USLT / ©lyr / LYRICS). Downloads and the "Find lyrics" button query **LRCLIB**: an exact `/api/get` first, then `/api/search` without the strict album filter, picking the closest duration and preferring synced lyrics. The timeout is 20 s because LRCLIB often takes 7–10 s, and a `Retry-After` header is honoured.

In the UI, the active line is found by binary search on every time update. It's highlighted and scrolled to the centre (auto-scroll pauses for 3 s after you scroll yourself), and clicking a line seeks to it.

## Online catalog: "not saved" items

`catalog.py` uses Deezer's public API: no key, good covers and complete tracklists. Every album, track and artist it returns is checked against an in-memory index of the local library (normalised artist + title, which ignores "feat." and "Remastered"-style suffixes) and gets `saved` and `local_id` fields. The UI uses them to show **Saved** / **Not saved** badges, greyed-out art, download buttons, and "Download N missing" on partly-owned albums.

Responses are cached on disk (1 h to 7 days, depending on the endpoint), and the cache is served when you're offline. Online artwork goes through `/api/img`, which caches it locally too. *Settings → Online features* turns all of this off for a strictly offline app.

## Downloads (the WaveGrab engine)

The queue lives in the `downloads` table, so it survives restarts (anything caught mid-download goes back to *queued*). It is ordered by a `position` column, which drag-to-reorder and "move to top" update. Worker threads (1–4) claim the next queued item under a lock:

1. **Fit into the library.** If the song's album already exists locally (matched by normalised artist + album, so "Discovery (Remastered)" counts as "Discovery"), the song is saved into *that* album's folder under its existing names, so a missing track joins the album instead of starting a second copy. If the album already has a copy of this song (same normalised title, duration within 6 s), the download is skipped.
2. **Download with spotDL** (the default engine; it's a required dependency). WaveGrab runs `python -m spotdl download "<artist> - <title>"` (or the exact Spotify URL for Spotify-link items) into a temp folder. spotDL uses Spotify's metadata and YouTube Music matching. M4A/Opus are kept as-is (`--bitrate disable`), and MP3 uses 320k. Cookies and browser cookies are passed through.
3. **Fallback:** if spotDL fails, WaveGrab's own matcher runs `ytsearch8:"<artist> - <title> audio"` and scores every candidate: closeness of duration to the catalog duration (the strongest signal), title and artist word overlap, a bonus for YouTube Music "– Topic" uploads and "official audio", and penalties for live / cover / remix / sped-up / karaoke / nightcore unless the requested title contains that word. It then downloads with yt-dlp. Pasted non-Spotify links go straight to yt-dlp, with metadata filled in from the catalog when a confident match exists.
4. **Tag** with mutagen (title, artist, album, album artist, track and disc number, year, genre, front cover), always using WaveGrab's metadata so an album's files stay consistent.
5. **Lyrics** from LRCLIB, written as a `.lrc` sidecar.
6. **File** as `<download dir>/<Album Artist>/<Album>/01 Title.ext` (multi-disc albums use `2-01 Title.ext`). The number prefix makes the files sort in album order in Explorer and other players. The song is then indexed immediately.

Spotify track, album and playlist links are read with `spotdl save` and become one queue item per song, in track order for albums, skipping songs you already have. Music videos go to `<download dir>/Music Videos/`, which the scanner skips.

## Organize library (Settings)

`organizer.py` fixes music that's already on disk, album by album (albums with 2+ songs):

1. **Duplicates:** songs with the same normalised title and a duration within 6 s are treated as the same recording, so reprises and live takes survive. The best copy is kept (lossless > higher bitrate > has lyrics > has cover). The others are moved, with their sidecars, to a hidden `.wavegrab-duplicates` folder at the root of that music folder. The scanner skips dot-folders, so they leave the library but nothing is deleted.
2. **Order:** if every song has a unique track number in its tags, those are used. Otherwise the album is looked up in the online catalog and songs are matched to the official tracklist by title (the closest duration wins). Songs it can't place keep a free tag number or go last.
3. **Rename** in place to `01 Title.ext` (`2-01 Title.ext` for multi-disc albums), write the track and disc numbers into the tags, and move `.lrc`/`.txt` sidecars along. Renames go through temporary names, so swapping two numbers can't collide.

The scan only produces a plan, which is shown for review. Apply performs it and writes `organize-undo-<time>.json` to the data folder, and the Undo button replays that log in reverse.

## Albums vs. loose songs

An "album" with one song isn't shown as an album (Albums grid, Home, search, artist pages). Those songs appear under **Songs** and on the artist page under **Singles & loose songs**.

## Playback

- Two `<audio>` elements. While one plays, the next track is preloaded into the other, and swapping on `ended` gives near-gapless transitions. (True sample-accurate gapless, with LAME/iTunSMPB delay and padding trimming, would need a decoded-PCM engine. That's a possible later upgrade.)
- **Crossfade** (0–12 s) ramps the two per-element gain nodes linearly.
- **EQ:** 10 `BiquadFilterNode`s (low shelf at 32 Hz, peaking bells at 64 Hz–8 kHz with Q 1.1, high shelf at 16 kHz). These are the Web Audio implementation of the RBJ Audio EQ Cookbook filters the report describes. Gains ramp with `setTargetAtTime`, so dragging a slider never clicks. A preamp lowers the level by 60% of the largest boost to avoid clipping. The response curve in the EQ tab is computed with `getFrequencyResponse`.
- **Seeking** uses a hand-written HTTP Range handler (`ranged_file` in `server.py`), because spotDL pins an older Starlette whose `FileResponse` doesn't support Range requests.
- **Media keys** work through the Media Session API. Playback state (queue, position, volume, EQ) is saved locally and restored on launch.
- **Play counts:** a play counts after 30 s or half the track. It updates `play_count` and `last_played` and adds a row to `play_history`.

## Shuffle

`shuffle.js` implements the three modes from the report:

- **Standard:** Fisher–Yates, where every order is equally likely.
- **Balanced artist spread:** the Spotify (2014) approach. Each artist's *k* songs are placed about 1/*k* apart on [0, 1), with a random offset and ±10% jitter. The same spreading runs within each artist across their albums, then everything is sorted by position.
- **Fewer repeats (default):** generate 24 random Fisher–Yates orders and keep the one with the best freshness score,
  `F(S) = 1 − (1/N) Σ e^(−0.08·i) · e^(−hours_since_played/48)`. That penalises recently played songs near the start of the queue while keeping the order random. Right-click the shuffle button to switch modes.

## Look and feel

- A three-zone layout like Spotify's: left navigation and library, the main view, and a right panel (Queue / Lyrics / EQ) above a persistent player bar. Long song lists are virtualised (only visible rows are rendered), so 50,000 songs scroll smoothly.
- 8 themes, all defined as CSS variables in `web/css/themes.css`. The rounded corners (10 px and 16 px), translucent panels with backdrop blur, and one accent colour per theme are kept deliberately calm.
- `fx.js` draws a full-window canvas behind the panels: two slow colour blobs that drift on their own and swell gently with the music (no mouse effects). With *Match album colours* on, the background colours and the player tint follow the playing album's dominant colour.

## Merging the original WaveGrab (`C:\scripts\musicvideodln`)

This repo was built without access to the original WaveGrab scripts, because that folder is on your PC and was never pushed to GitHub. The downloader here is a fresh yt-dlp engine that covers the same job (paste a link, get tagged audio or a music video). To merge your existing code, push that folder to this repo (for example under `legacy/`) and I'll fold any custom behaviour (sites, naming rules, post-processing) into `wavegrab/downloader.py`.
