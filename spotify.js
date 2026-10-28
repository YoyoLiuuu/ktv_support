// Loads track lists from Spotify. With SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET set we use the
// Web API (no track limit); otherwise, or if the API refuses, we read the public embed page,
// which needs no credentials but only lists the first 100 tracks.

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const EMBED_LIMIT = 100;

export function parseSpotifyUrl(input) {
  const m =
    input.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(playlist|album)\/([A-Za-z0-9]{10,40})/i) ||
    input.match(/^spotify:(playlist|album):([A-Za-z0-9]{10,40})$/i);
  return m ? { type: m[1].toLowerCase(), id: m[2] } : null;
}

export async function fetchSpotifyTracks(ref) {
  if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
    try {
      return await fetchViaApi(ref);
    } catch (err) {
      console.warn('Spotify API failed, falling back to embed:', err.message);
    }
  }
  return fetchViaEmbed(ref);
}

async function fetchViaEmbed({ type, id }) {
  const res = await fetch(`https://open.spotify.com/embed/${type}/${id}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('unexpected page format');
  const entity = JSON.parse(m[1])?.props?.pageProps?.state?.data?.entity;
  if (!entity?.trackList) throw new Error('not found or private');
  const tracks = entity.trackList
    .filter((t) => t.title)
    .map((t) => ({
      title: t.title,
      artist: (t.subtitle || '').replace(/ /g, ' '),
      uri: t.uri || null,
      durationMs: t.duration || null,
    }));
  return { name: entity.name || entity.title || 'Untitled', tracks, truncated: tracks.length >= EMBED_LIMIT };
}

let cachedToken = null;

async function apiToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const auth = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`token HTTP ${res.status}`);
  const data = await res.json();
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

async function apiGet(url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await apiToken()}` } });
  if (!res.ok) throw new Error(`API HTTP ${res.status}`);
  return res.json();
}

async function fetchViaApi({ type, id }) {
  const base = `https://api.spotify.com/v1/${type}s/${id}`;
  const meta = await apiGet(`${base}?fields=name`);
  const tracks = [];
  let next = `${base}/tracks?limit=50`;
  while (next && tracks.length < 2000) {
    const page = await apiGet(next);
    for (const item of page.items) {
      const t = type === 'playlist' ? item.track : item;
      if (!t?.name || t.type === 'episode') continue;
      tracks.push({
        title: t.name,
        artist: (t.artists || []).map((a) => a.name).join(', '),
        uri: t.uri || null,
        durationMs: t.duration_ms || null,
      });
    }
    next = page.next;
  }
  return { name: meta.name || 'Untitled', tracks, truncated: false };
}
