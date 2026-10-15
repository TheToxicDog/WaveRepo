"""SQLite storage: tracks, albums, artists, lyrics, playlists, downloads.

Search uses two external-content FTS5 tables (see docs/ARCHITECTURE.md):
  tracks_fts       title / artist / album / genre / lyrics, weighted BM25
  lyric_lines_fts  one row per timed lyric line, so a lyric hit can seek
"""
import sqlite3
import threading
from contextlib import contextmanager

from .config import settings

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,
    root TEXT,
    lrc_path TEXT,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    album TEXT NOT NULL,
    album_artist TEXT NOT NULL,
    album_id TEXT NOT NULL,
    artist_id TEXT NOT NULL,
    genre TEXT DEFAULT '',
    year INTEGER,
    track_no INTEGER,
    disc_no INTEGER,
    duration REAL DEFAULT 0,
    bitrate INTEGER,
    sample_rate INTEGER,
    format TEXT,
    size INTEGER,
    mtime REAL,
    has_cover INTEGER DEFAULT 0,
    lyrics_plain TEXT DEFAULT '',
    lyrics_synced INTEGER DEFAULT 0,
    added_at INTEGER,
    play_count INTEGER DEFAULT 0,
    last_played INTEGER DEFAULT 0,
    liked_at INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_id, disc_no, track_no);
CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist_id);
CREATE INDEX IF NOT EXISTS idx_tracks_added ON tracks(added_at);

CREATE TABLE IF NOT EXISTS albums (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    artist_id TEXT NOT NULL,
    year INTEGER,
    genre TEXT,
    track_count INTEGER,
    duration REAL,
    cover TEXT,
    added_at INTEGER,
    norm TEXT
);

CREATE TABLE IF NOT EXISTS artists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    album_count INTEGER,
    track_count INTEGER,
    cover_album TEXT,
    image_url TEXT,
    norm TEXT
);

CREATE TABLE IF NOT EXISTS lyric_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    timestamp_ms INTEGER NOT NULL,
    line_index INTEGER NOT NULL,
    lyric_text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lyric_lines_track ON lyric_lines(track_id, timestamp_ms);

CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
    title, artist, album, genre, lyrics_plain,
    content='tracks', content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);
CREATE VIRTUAL TABLE IF NOT EXISTS lyric_lines_fts USING fts5(
    lyric_text, track_id UNINDEXED, timestamp_ms UNINDEXED,
    content='lyric_lines', content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS tracks_ai AFTER INSERT ON tracks BEGIN
  INSERT INTO tracks_fts(rowid, title, artist, album, genre, lyrics_plain)
  VALUES (new.id, new.title, new.artist, new.album, new.genre, new.lyrics_plain);
END;
CREATE TRIGGER IF NOT EXISTS tracks_ad AFTER DELETE ON tracks BEGIN
  INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, genre, lyrics_plain)
  VALUES ('delete', old.id, old.title, old.artist, old.album, old.genre, old.lyrics_plain);
END;
CREATE TRIGGER IF NOT EXISTS tracks_au AFTER UPDATE OF title, artist, album, genre, lyrics_plain ON tracks BEGIN
  INSERT INTO tracks_fts(tracks_fts, rowid, title, artist, album, genre, lyrics_plain)
  VALUES ('delete', old.id, old.title, old.artist, old.album, old.genre, old.lyrics_plain);
  INSERT INTO tracks_fts(rowid, title, artist, album, genre, lyrics_plain)
  VALUES (new.id, new.title, new.artist, new.album, new.genre, new.lyrics_plain);
END;

CREATE TRIGGER IF NOT EXISTS lyric_ai AFTER INSERT ON lyric_lines BEGIN
  INSERT INTO lyric_lines_fts(rowid, lyric_text, track_id, timestamp_ms)
  VALUES (new.id, new.lyric_text, new.track_id, new.timestamp_ms);
END;
CREATE TRIGGER IF NOT EXISTS lyric_ad AFTER DELETE ON lyric_lines BEGIN
  INSERT INTO lyric_lines_fts(lyric_lines_fts, rowid, lyric_text, track_id, timestamp_ms)
  VALUES ('delete', old.id, old.lyric_text, old.track_id, old.timestamp_ms);
END;

CREATE TABLE IF NOT EXISTS play_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    played_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_time ON play_history(played_at);

CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at INTEGER,
    updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    added_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pl_tracks ON playlist_tracks(playlist_id, position);

CREATE TABLE IF NOT EXISTS downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    kind TEXT NOT NULL DEFAULT 'track',
    title TEXT NOT NULL,
    artist TEXT DEFAULT '',
    album TEXT DEFAULT '',
    album_artist TEXT DEFAULT '',
    track_no INTEGER,
    disc_no INTEGER,
    year INTEGER,
    genre TEXT DEFAULT '',
    duration REAL,
    cover_url TEXT DEFAULT '',
    catalog_id TEXT DEFAULT '',
    source_url TEXT DEFAULT '',
    group_id TEXT DEFAULT '',
    group_title TEXT DEFAULT '',
    progress REAL DEFAULT 0,
    speed REAL DEFAULT 0,
    eta REAL,
    error TEXT DEFAULT '',
    file_path TEXT DEFAULT '',
    matched_url TEXT DEFAULT '',
    created_at INTEGER,
    finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(status, position);

CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
"""

_local = threading.local()
_write_lock = threading.RLock()


def connect() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = sqlite3.connect(settings.db_path, timeout=30, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=30000")
        _local.conn = conn
    return conn


def init():
    conn = connect()
    with _write_lock:
        conn.executescript(SCHEMA)
        conn.commit()


@contextmanager
def tx():
    """Serialised write transaction."""
    conn = connect()
    with _write_lock:
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise


def rows(sql, params=()):
    return [dict(r) for r in connect().execute(sql, params).fetchall()]


def row(sql, params=()):
    r = connect().execute(sql, params).fetchone()
    return dict(r) if r else None


def scalar(sql, params=()):
    r = connect().execute(sql, params).fetchone()
    return r[0] if r else None
