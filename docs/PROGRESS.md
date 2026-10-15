# WaveGrab Player — build progress

This file is the source of truth for the "resume after usage limit" routine.
Work top to bottom; tick items as they land on `claude/sharp-shannon-f3eedk`.

## Phase 1 — Core
- [ ] Backend: config, SQLite schema with FTS5 (tracks + lyric lines)
- [ ] Backend: library scanner (mutagen tags, covers, .lrc sidecars, incremental)
- [ ] Backend: LRC parser (offsets, multi-timestamp, continuations)
- [ ] Backend: online catalog (Deezer, keyless) with saved/not-saved matching
- [ ] Backend: download queue + yt-dlp worker (reorder, pause, cancel, retry), tagging, LRCLIB lyrics
- [ ] Backend: FastAPI routes, range streaming, SSE events
- [ ] Frontend: shell (sidebar, player bar, right panel), themes, rounded UI
- [ ] Frontend: library views (albums, artists, songs, album/artist pages)
- [ ] Frontend: search (local + lyrics + online)
- [ ] Frontend: downloads page (drag reorder, controls, paste URL)
- [ ] Frontend: player (queue, shuffle modes, repeat, EQ, lyrics, crossfade)
- [ ] Frontend: mouse effects (ripples, particles, glow) + audio reactive
- [ ] Liked songs + playlists
- [ ] Demo library + screenshots, docs (README, ARCHITECTURE, CHANGELOG)

## Phase 2 — Polish (after Phase 1)
- [ ] Merge user's existing WaveGrab code (needs the user to push C:\scripts\musicvideodln)
- [ ] Desktop window via pywebview + Windows launcher
- [ ] Music video downloads tab
