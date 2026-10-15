# Changelog

## 0.1.0 — first build (2026-10-15)

The first complete version of the WaveGrab player: an offline, Spotify-style app with the downloader built in.

### Library
- Scans any number of music folders (external drive first, then your Music folder). Incremental rescans only re-read changed files.
- Reads tags from MP3, FLAC, M4A/MP4, Ogg, Opus, WAV, AIFF and WMA. Falls back to file and folder names when tags are missing.
- Groups music into albums and artists using normalised names, so "Album (Deluxe Edition)" still matches.
- Extracts embedded cover art (or `cover.jpg` / `folder.jpg`) and caches it.
- Keeps an unplugged drive's songs in the library instead of deleting them.
- Plays WMA/AIFF by transcoding them on the fly with FFmpeg.

### Search
- SQLite FTS5 index over title, artist, album, genre and lyrics, ranked with weighted BM25 and updated as you type.
- A separate line-level lyric index: "In the lyrics" results jump to the exact moment the line is sung.
- Online results (albums, songs, artists) appear under your own music with **Not saved** badges.

### Online catalog and downloads
- Discover page: trending albums, songs and artists, genre charts, and new releases from artists in your library.
- Online album and artist pages show the full discography and tracklist, with saved / not saved / queued marked per track.
- Local album pages list the tracks you're missing, with a "Download missing" button.
- Download queue page: drag-to-reorder, move to top, hold/resume, cancel, retry, pause all, clear finished/failed, and live progress (speed, ETA). The queue survives restarts.
- Downloader: duration-scored YouTube matching (prefers YouTube Music "Topic" uploads, avoids live/cover/remix), yt-dlp download (M4A by default; Opus, MP3 and FLAC also available), full tagging with cover art, LRCLIB lyrics, and filing into `Artist/Album/NN Title`.
- Paste-a-link mode for YouTube, YouTube Music, SoundCloud and similar sites, with playlists expanded. Spotify links go through spotDL when it's installed. Music video mode saves MP4s to `Music Videos/`.
- If YouTube asks for bot verification, a "Use browser cookies" setting fixes it. An optional cookies.txt unlocks 256 kbps audio.

### Player
- Queue with "Next in queue" (play next / add to queue) and "Next from" sections, drag-to-reorder and click-to-jump.
- Three shuffle modes: Fewer repeats (freshness-scored, the default), Balanced artist spread, and Standard. Right-click the shuffle button to switch.
- Repeat off / all / one, crossfade (0–12 s), next-track preloading for near-gapless playback.
- 10-band EQ (biquad filters) with presets, a live response curve, and automatic preamp so boosts never clip.
- Synced lyrics panel (active line highlighted and centred, click a line to seek) and a full-screen lyrics view with controls.
- Liked Songs, playlists (create, rename, add, remove, delete), play counts and history.
- Media keys, keyboard shortcuts, and the play position remembered between launches.

### Look and feel
- Sidebar + main view + right panel + player bar, with rounded corners and translucent blurred panels.
- 8 themes: Midnight, Aurora, Sunset, Ocean, Forest, Mono, Paper (light) and Blossom (light).
- Background effects that follow the mouse and pulse with the music: ripples (drawn over the UI), particles, or cursor glow. Clicks send out rings.
- Colours adapt to the playing album's cover.

### Known limits
- Your original WaveGrab scripts (`C:\scripts\musicvideodln`) weren't available to this build. See ARCHITECTURE.md → "Merging the original WaveGrab".
- Gapless playback is near-gapless (preloaded element swap), not sample-accurate.
