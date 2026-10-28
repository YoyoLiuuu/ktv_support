import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { fetchSpotifyTracks, parseSpotifyUrl } from './spotify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3000;
const db = openDb(process.env.DB_PATH || path.join(__dirname, 'data', 'ktv.db'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function str(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function voterId(req) {
  const id = str(req.headers['x-voter-id'], 64);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new HttpError(400, 'Missing voter id');
  return id;
}

function getEvent(id) {
  const event = db.getEvent(id);
  if (!event) throw new HttpError(404, 'Event not found');
  return event;
}

function serveStatic(req, res, pathname) {
  // Event pages are client-routed; everything else maps to a file in public/.
  const file = pathname === '/' || pathname.startsWith('/e/') ? 'index.html' : pathname.slice(1);
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found');
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function exportText(event, songs) {
  const lines = [`${event.name} — ${event.date}`, ''];
  songs.forEach((s, i) => lines.push(`${i + 1}. ${s.title} - ${s.artist}`));
  return lines.join('\n') + '\n';
}

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv(songs) {
  const rows = [['rank', 'title', 'artist', 'playlists', 'upvotes', 'downvotes', 'score', 'spotify_uri']];
  songs.forEach((s, i) =>
    rows.push([i + 1, s.title, s.artist, s.count, s.up, s.down, s.score, s.spotify_uri || ''])
  );
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function slugFilename(event) {
  return `${event.date}-${event.name}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ktv';
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
  const method = req.method;

  if (parts[0] === 'events' && parts.length === 1) {
    if (method === 'GET') return send(res, 200, { events: db.listEvents() });
    if (method === 'POST') {
      const body = await readJson(req);
      const name = str(body.name, 80);
      const date = str(body.date, 10);
      if (!name) throw new HttpError(400, 'Give the night a name');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
        throw new HttpError(400, 'Pick a valid date');
      }
      const id = crypto.randomBytes(5).toString('base64url');
      db.createEvent(id, name, date);
      return send(res, 201, { event: db.getEvent(id) });
    }
  }

  if (parts[0] !== 'events' || !parts[1]) throw new HttpError(404, 'Not found');
  const event = getEvent(parts[1]);
  const sub = parts[2];

  if (!sub && method === 'GET') {
    const voter = str(req.headers['x-voter-id'], 64);
    return send(res, 200, {
      event,
      playlists: db.listPlaylists(event.id),
      songs: db.rankedSongs(event.id, voter),
    });
  }

  if (!sub && method === 'DELETE') {
    db.deleteEvent(event.id);
    return send(res, 200, { ok: true });
  }

  if (sub === 'playlists' && method === 'POST') {
    const body = await readJson(req);
    const ref = parseSpotifyUrl(str(body.url, 500));
    if (!ref) throw new HttpError(400, 'Paste a Spotify playlist or album link');
    if (db.hasPlaylist(event.id, ref.id)) throw new HttpError(409, 'That playlist is already imported');
    let result;
    try {
      result = await fetchSpotifyTracks(ref);
    } catch (err) {
      console.error('spotify import failed', ref, err);
      throw new HttpError(502, `Couldn't load that from Spotify (${err.message}). Is it public?`);
    }
    if (!result.tracks.length) throw new HttpError(422, 'That playlist has no tracks');
    const playlist = db.addPlaylist(event.id, {
      spotifyId: ref.id,
      kind: ref.type,
      name: result.name,
      addedBy: str(body.addedBy, 40),
      tracks: result.tracks,
    });
    return send(res, 201, { playlist, truncated: result.truncated });
  }

  if (sub === 'playlists' && parts[3] && method === 'DELETE') {
    db.deletePlaylist(event.id, Number(parts[3]));
    return send(res, 200, { ok: true });
  }

  if (sub === 'songs' && !parts[3] && method === 'POST') {
    const body = await readJson(req);
    const title = str(body.title, 200);
    const artist = str(body.artist, 200);
    if (!title) throw new HttpError(400, 'Song title is required');
    const song = db.addManualSong(event.id, { title, artist, addedBy: str(body.addedBy, 40) });
    db.vote(song.id, voterId(req), 1);
    return send(res, 201, { song });
  }

  if (sub === 'songs' && parts[3] && parts[4] === 'vote' && method === 'POST') {
    const body = await readJson(req);
    const value = Number(body.value);
    if (![1, 0, -1].includes(value)) throw new HttpError(400, 'Vote must be 1, 0 or -1');
    const songId = Number(parts[3]);
    if (!db.songInEvent(event.id, songId)) throw new HttpError(404, 'Song not found');
    db.vote(songId, voterId(req), value);
    return send(res, 200, { ok: true });
  }

  if (sub === 'songs' && parts[3] && parts[4] === 'sung' && method === 'POST') {
    const body = await readJson(req);
    const songId = Number(parts[3]);
    if (!db.songInEvent(event.id, songId)) throw new HttpError(404, 'Song not found');
    db.setSung(songId, Boolean(body.sung));
    return send(res, 200, { ok: true });
  }

  if (sub === 'export' && method === 'GET') {
    const songs = db.rankedSongs(event.id, '').filter((s) => url.searchParams.get('all') || !s.sung);
    const filename = slugFilename(event);
    if (url.searchParams.get('format') === 'csv') {
      return send(res, 200, exportCsv(songs), {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}.csv"`,
      });
    }
    return send(res, 200, exportText(event, songs), {
      'Content-Disposition': `inline; filename="${filename}.txt"`,
    });
  }

  throw new HttpError(404, 'Not found');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/healthz') return send(res, 200, 'ok');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    console.error(err);
    return send(res, 500, { error: 'Something went wrong' });
  }
});

server.listen(PORT, () => console.log(`KTV app listening on :${PORT}`));
