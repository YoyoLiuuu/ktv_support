import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  spotify_id TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  added_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_id, spotify_id)
);
CREATE TABLE IF NOT EXISTS songs (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  match_key TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  spotify_uri TEXT,
  duration_ms INTEGER,
  sung INTEGER NOT NULL DEFAULT 0,
  UNIQUE (event_id, match_key)
);
CREATE TABLE IF NOT EXISTS playlist_songs (
  playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  PRIMARY KEY (playlist_id, song_id)
);
CREATE TABLE IF NOT EXISTS votes (
  song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  voter_id TEXT NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (song_id, voter_id)
);
CREATE INDEX IF NOT EXISTS playlist_songs_song ON playlist_songs(song_id);
`;

// Collapse versions of the same song ("Song - Remastered 2011", "Song (feat. X)",
// "Song (Taylor's Version)") so they count as one when they show up in different playlists.
export function matchKey(title, artist) {
  const clean = (s) => s.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '');
  const baseTitle = title.replace(/\s[-–—]\s.*$/, '').replace(/[([{（【].*?[)\]}）】]/g, '');
  const firstArtist = artist.split(/,|&|\s+(?:feat\.?|ft\.?|x|with)\s+/i)[0] || '';
  return `${clean(baseTitle) || clean(title)}|${clean(firstArtist)}`;
}

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  const q = (sql) => db.prepare(sql);
  const stmts = {
    listEvents: q(`
      SELECT e.id, e.name, e.date,
        (SELECT COUNT(*) FROM songs s WHERE s.event_id = e.id) AS song_count,
        (SELECT COUNT(*) FROM playlists p WHERE p.event_id = e.id AND p.kind != 'manual') AS playlist_count
      FROM events e ORDER BY e.date DESC, e.created_at DESC`),
    getEvent: q('SELECT id, name, date FROM events WHERE id = ?'),
    createEvent: q('INSERT INTO events (id, name, date) VALUES (?, ?, ?)'),
    deleteEvent: q('DELETE FROM events WHERE id = ?'),
    listPlaylists: q(`
      SELECT p.id, p.name, p.kind, p.spotify_id, p.added_by,
        (SELECT COUNT(*) FROM playlist_songs ps WHERE ps.playlist_id = p.id) AS track_count
      FROM playlists p WHERE p.event_id = ? ORDER BY p.kind = 'manual', p.id`),
    hasPlaylist: q('SELECT 1 FROM playlists WHERE event_id = ? AND spotify_id = ?'),
    insertPlaylist: q(
      'INSERT INTO playlists (event_id, spotify_id, kind, name, added_by) VALUES (?, ?, ?, ?, ?) RETURNING id, name, kind'
    ),
    manualPlaylist: q("SELECT id FROM playlists WHERE event_id = ? AND kind = 'manual'"),
    upsertSong: q(`
      INSERT INTO songs (event_id, match_key, title, artist, spotify_uri, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (event_id, match_key) DO UPDATE SET
        spotify_uri = COALESCE(songs.spotify_uri, excluded.spotify_uri),
        duration_ms = COALESCE(songs.duration_ms, excluded.duration_ms)
      RETURNING id, title, artist`),
    linkSong: q('INSERT OR IGNORE INTO playlist_songs (playlist_id, song_id) VALUES (?, ?)'),
    deletePlaylist: q('DELETE FROM playlists WHERE id = ? AND event_id = ?'),
    deleteOrphans: q(
      'DELETE FROM songs WHERE event_id = ? AND id NOT IN (SELECT song_id FROM playlist_songs)'
    ),
    songInEvent: q('SELECT 1 FROM songs WHERE id = ? AND event_id = ?'),
    setVote: q(`
      INSERT INTO votes (song_id, voter_id, value) VALUES (?, ?, ?)
      ON CONFLICT (song_id, voter_id) DO UPDATE SET value = excluded.value`),
    clearVote: q('DELETE FROM votes WHERE song_id = ? AND voter_id = ?'),
    setSung: q('UPDATE songs SET sung = ? WHERE id = ?'),
    rankedSongs: q(`
      SELECT s.id, s.title, s.artist, s.spotify_uri, s.duration_ms, s.sung,
        (SELECT COUNT(*) FROM playlist_songs ps WHERE ps.song_id = s.id) AS count,
        (SELECT COUNT(*) FROM votes v WHERE v.song_id = s.id AND v.value > 0) AS up,
        (SELECT COUNT(*) FROM votes v WHERE v.song_id = s.id AND v.value < 0) AS down,
        COALESCE((SELECT v.value FROM votes v WHERE v.song_id = s.id AND v.voter_id = ?), 0) AS my_vote,
        (SELECT group_concat(p.id) FROM playlist_songs ps JOIN playlists p ON p.id = ps.playlist_id
          WHERE ps.song_id = s.id) AS playlist_ids
      FROM songs s WHERE s.event_id = ?`),
  };

  function tx(fn) {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function addSongTo(eventId, playlistId, { title, artist, uri = null, durationMs = null }) {
    const song = stmts.upsertSong.get(eventId, matchKey(title, artist), title, artist, uri, durationMs);
    stmts.linkSong.run(playlistId, song.id);
    return song;
  }

  return {
    listEvents: () => stmts.listEvents.all(),
    getEvent: (id) => stmts.getEvent.get(id),
    createEvent: (id, name, date) => stmts.createEvent.run(id, name, date),
    deleteEvent: (id) => stmts.deleteEvent.run(id),
    listPlaylists: (eventId) => stmts.listPlaylists.all(eventId),
    hasPlaylist: (eventId, spotifyId) => Boolean(stmts.hasPlaylist.get(eventId, spotifyId)),

    addPlaylist: (eventId, { spotifyId, kind, name, addedBy, tracks }) =>
      tx(() => {
        const playlist = stmts.insertPlaylist.get(eventId, spotifyId, kind, name, addedBy);
        for (const t of tracks) addSongTo(eventId, playlist.id, t);
        return { ...playlist, track_count: tracks.length };
      }),

    addManualSong: (eventId, { title, artist, addedBy }) =>
      tx(() => {
        const manual =
          stmts.manualPlaylist.get(eventId) ||
          stmts.insertPlaylist.get(eventId, null, 'manual', 'Song requests', addedBy);
        return addSongTo(eventId, manual.id, { title, artist });
      }),

    deletePlaylist: (eventId, playlistId) =>
      tx(() => {
        stmts.deletePlaylist.run(playlistId, eventId);
        stmts.deleteOrphans.run(eventId);
      }),

    songInEvent: (eventId, songId) => Boolean(stmts.songInEvent.get(songId, eventId)),
    vote: (songId, voterId, value) =>
      value === 0 ? stmts.clearVote.run(songId, voterId) : stmts.setVote.run(songId, voterId, value),
    setSung: (songId, sung) => stmts.setSung.run(sung ? 1 : 0, songId),

    // Rank: how many playlists a song is in, plus net votes. Already-sung songs sink to the bottom.
    rankedSongs: (eventId, voterId) =>
      stmts.rankedSongs
        .all(voterId, eventId)
        .map((s) => ({
          ...s,
          sung: Boolean(s.sung),
          score: s.count + s.up - s.down,
          playlist_ids: s.playlist_ids ? s.playlist_ids.split(',').map(Number) : [],
        }))
        .sort(
          (a, b) =>
            a.sung - b.sung ||
            b.score - a.score ||
            b.count - a.count ||
            b.up - a.up ||
            a.title.localeCompare(b.title)
        ),
  };
}
