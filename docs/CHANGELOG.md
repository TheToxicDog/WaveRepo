# Changelog

## 0.5.0 — checks for updates on launch (2026-10-15)
- **WaveGrab checks for updates every time it opens.** The window shows a splash screen ("Checking for updates…"). If GitHub has a newer version, it downloads and installs it (plus any new requirements), then restarts into the new version. If you're offline, it opens the version you have.
- Works for a **git clone** (`git pull --ff-only`, skipped if you edited files) and for a **downloaded zip** (fetches the latest commit's zip and copies it over the app folder; `.venv` and your library data aren't touched).
- **Settings → Updates:** turn the launch check off, see the current version, or "Check now".
- `python run.py --no-update-check` skips the check once.
- Added a `VERSION` file.

## 0.4.0 — albums only, download the rest (2026-10-15)
- **The Albums page shows only full albums.** Singles and EPs have their own **Singles & EPs** page (sidebar and library tabs) and their own section on artist pages.
- How a release is classified: the file's release-type tag (`MusicBrainz Album Type` / `RELEASETYPE`) when present. Otherwise the online catalog is checked once per album and cached. Otherwise Spotify's rule: 1–3 songs under 30 min is a single, 4–6 songs under 30 min is an EP.
- That online check means a partly downloaded album (for example 3 of 12 songs) still counts as an album instead of looking like a single.
- Downloads now write the release type into the file's tags, so new music is classified exactly.
- **Download the rest:** albums you only have part of show a "3 of 12" badge, and the album page has a **Download the rest (N songs)** button. It turns into "In your download queue" once queued. The full list of missing songs is still shown below.

## 0.3.0 — music videos page (2026-10-15)
- New **Music videos** page in the sidebar. It lists everything in the `Music Videos` folder of your music drive and download folder (where Downloads → "Music video" saves), with thumbnails (FFmpeg grabs a frame about 20 s in, cached) and the artist and title taken from the `Artist - Title` filename.
- Clicking a video opens a full-window player with Previous/Next. It plays the next video automatically, and Esc closes it. Music that was playing pauses while the video plays and resumes afterwards.
- Videos stream with seeking support. Requests can only reach files inside the Music Videos folders.

## 0.2.0 — spotDL, album order, no duplicates (2026-10-15)

### Downloads
- **spotDL is now a required dependency and the main download engine.** It uses Spotify's metadata and YouTube Music matching. If spotDL can't get a song, WaveGrab's own YouTube search takes over automatically. You can choose the engine under Settings → Downloads.
- Spotify track, album and playlist links become one queue item per song (in track order for albums), and songs you already have are left out.
- FFmpeg can be installed by spotDL: automatically by `start-wavegrab.bat`, from Settings → Tools, or on the first download.
- Songs download into the existing album folder when you already have part of the album, so they join it instead of creating a second copy.
- Songs an album already has are skipped ("Already in your library"), and an album download never queues the same song twice.

### Album order
- Downloaded album songs are named `01 Title`, `02 Title`… (`2-01 Title` on multi-disc albums), so the files sort in album order.
- New **Settings → Organize library**: renames your existing album files to the same pattern in the official track order (looked up online when your tags are missing or conflicting), writes the track numbers into the tags, and moves `.lrc` lyric files along. It shows every change first, and there's an Undo button.

### Duplicates and 1-song albums
- Organize library also finds duplicate songs within an album, keeps the best copy, and moves the rest to a hidden `.wavegrab-duplicates` folder (nothing is deleted).
- A single song no longer shows up as an album. Lone songs are listed under Songs and in a new "Singles & loose songs" section on artist pages.

### Look
- Removed the mouse/cursor effects (ripples, particles, cursor glow, click ripples). The background is now a soft ambient glow that pulses with the music, or Off.

### Under the hood
- Audio seeking now uses a built-in HTTP Range handler, because spotDL pins an older web framework.
- Database migration adds a `multi_disc` flag to queued downloads.

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
