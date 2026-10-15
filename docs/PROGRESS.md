# WaveGrab Player — build progress

This file is the source of truth for the "resume after usage limit" routine.
Work top to bottom; tick items as they land on `claude/sharp-shannon-f3eedk`.

## Phase 1 — Core
- [x] Backend: config, SQLite schema with FTS5 (tracks + lyric lines)
- [x] Backend: library scanner (mutagen tags, covers, .lrc sidecars, incremental)
- [x] Backend: LRC parser (offsets, multi-timestamp, continuations)
- [x] Backend: online catalog (Deezer, keyless) with saved/not-saved matching
- [x] Backend: download queue + yt-dlp worker (reorder, pause, cancel, retry), tagging, LRCLIB lyrics
- [x] Backend: FastAPI routes, range streaming, SSE events
- [x] Frontend: shell (sidebar, player bar, right panel), themes, rounded UI
- [x] Frontend: library views (albums, artists, songs, album/artist pages)
- [x] Frontend: search (local + lyrics + online)
- [x] Frontend: downloads page (drag reorder, controls, paste URL)
- [x] Frontend: player (queue, shuffle modes, repeat, EQ, lyrics, crossfade)
- [x] Frontend: mouse effects (ripples, particles, glow) + audio reactive
- [x] Liked songs + playlists
- [x] Demo library + screenshots, docs (README, ARCHITECTURE, CHANGELOG)

## Phase 2 — Polish (after Phase 1)
- [~] Merge user's existing WaveGrab code — BLOCKED: waiting for the user to push C:\scripts\musicvideodln (skip until it appears in the repo)
- [x] Desktop window via pywebview + Windows launcher (run.py, start-wavegrab.bat)
- [ ] Music video library tab (downloads already work via Downloads → "Music video"; add a page to browse/play them)
