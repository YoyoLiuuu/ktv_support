const app = document.getElementById('app');
const nicknameInput = document.getElementById('nickname');
const POLL_MS = 5000;

const voterId = (() => {
  let id = safeGet('ktv.voter');
  if (!id) {
    id = crypto.randomUUID();
    safeSet('ktv.voter', id);
  }
  return id;
})();

nicknameInput.value = safeGet('ktv.nickname') || '';
nicknameInput.addEventListener('input', () => safeSet('ktv.nickname', nicknameInput.value.trim()));

function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Voter-Id': voterId, ...options.headers },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDate(iso, opts = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
}

/* ---------- routing ---------- */

let stopPolling = () => {};

function route() {
  stopPolling();
  const m = location.pathname.match(/^\/e\/([A-Za-z0-9_-]+)/);
  if (m) renderEvent(m[1]);
  else renderHome();
  window.scrollTo(0, 0);
}

function navigate(path) {
  history.pushState(null, '', path);
  route();
}

document.addEventListener('click', (e) => {
  const link = e.target.closest('a[data-link]');
  if (link && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
    e.preventDefault();
    navigate(link.getAttribute('href'));
  }
});
window.addEventListener('popstate', route);

/* ---------- home ---------- */

async function renderHome() {
  document.title = 'KTV Night';
  app.innerHTML = `
    <section class="hero">
      <h1>Pool the playlists.<br><span class="glow">Vote the bangers.</span></h1>
      <p>Everyone drops in their Spotify playlists. Songs that show up for more people float to the top,
        then the crowd votes. Take the final list to the KTV room.</p>
    </section>

    <section class="card">
      <h2>Plan a KTV night</h2>
      <form id="new-event" class="row-form">
        <label class="field grow">
          <span>Name</span>
          <input name="name" required maxlength="80" placeholder="Friday karaoke at Partyworld">
        </label>
        <label class="field">
          <span>Date</span>
          <input name="date" type="date" required value="${todayIso()}">
        </label>
        <button class="btn primary" type="submit">Create</button>
      </form>
    </section>

    <section id="events"><p class="muted">Loading…</p></section>
  `;

  document.getElementById('new-event').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    try {
      const { event } = await api('/events', {
        method: 'POST',
        body: { name: form.get('name'), date: form.get('date') },
      });
      navigate(`/e/${event.id}`);
    } catch (err) {
      toast(err.message, true);
    }
  });

  try {
    const { events } = await api('/events');
    const today = todayIso();
    const upcoming = events.filter((e) => e.date >= today).sort((a, b) => a.date.localeCompare(b.date));
    const past = events.filter((e) => e.date < today);
    document.getElementById('events').innerHTML =
      eventGroup('Upcoming', upcoming, 'Nothing planned yet. Make one above!') +
      (past.length ? eventGroup('Past nights', past) : '');
  } catch (err) {
    document.getElementById('events').innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

function eventGroup(title, events, emptyText = '') {
  const items = events
    .map(
      (e) => `
      <li>
        <a class="event-link" href="/e/${esc(e.id)}" data-link>
          <span class="event-date">
            <span class="mon">${esc(formatDate(e.date, { month: 'short' }))}</span>
            <span class="day">${esc(formatDate(e.date, { day: 'numeric' }))}</span>
          </span>
          <span class="event-info">
            <strong>${esc(e.name)}</strong>
            <span class="muted">${esc(formatDate(e.date))} · ${plural(e.song_count, 'song')} · ${plural(e.playlist_count, 'playlist')}</span>
          </span>
          <span class="chev" aria-hidden="true">›</span>
        </a>
      </li>`
    )
    .join('');
  return `
    <h2 class="group-title">${esc(title)}</h2>
    ${events.length ? `<ul class="event-list">${items}</ul>` : `<p class="muted">${esc(emptyText)}</p>`}`;
}

/* ---------- event ---------- */

async function renderEvent(eventId) {
  const state = { data: null, query: '', hideSung: safeGet('ktv.hideSung') === '1', playlistFilter: null };

  app.innerHTML = `
    <div id="event-head"><p class="muted">Loading…</p></div>

    <section class="card">
      <h2>Add songs</h2>
      <form id="import-form" class="row-form">
        <label class="field grow">
          <span>Spotify playlist or album link</span>
          <input name="url" required placeholder="https://open.spotify.com/playlist/…" inputmode="url" autocomplete="off">
        </label>
        <button class="btn primary" type="submit">Import</button>
      </form>
      <details class="manual">
        <summary>Or request a single song</summary>
        <form id="manual-form" class="row-form">
          <label class="field grow"><span>Song</span><input name="title" required maxlength="200" placeholder="晴天"></label>
          <label class="field grow"><span>Artist</span><input name="artist" maxlength="200" placeholder="周杰伦"></label>
          <button class="btn" type="submit">Add</button>
        </form>
      </details>
      <div id="playlists" class="chips"></div>
    </section>

    <section class="card songs-card">
      <div class="songs-toolbar">
        <h2>Song list</h2>
        <input id="search" type="search" placeholder="Search songs or artists" autocomplete="off">
        <label class="toggle"><input id="hide-sung" type="checkbox" ${state.hideSung ? 'checked' : ''}> Hide sung</label>
      </div>
      <p class="muted small">Ranked by how many playlists a song is in, plus 👍 minus 👎. Tap ✓ once you've sung it.</p>
      <ol id="songs" class="songs"></ol>
    </section>

    <section class="card">
      <h2>Take it to KTV</h2>
      <p class="muted small">Grab the ranked list (sung songs left out) to type into the KTV machine or send to the group chat.</p>
      <div class="export-actions">
        <button class="btn primary" id="copy-list" type="button">Copy list</button>
        <a class="btn" href="/api/events/${esc(eventId)}/export" target="_blank" rel="noopener">Open as text</a>
        <a class="btn" href="/api/events/${esc(eventId)}/export?format=csv">Download CSV</a>
      </div>
    </section>
  `;

  const load = async () => {
    try {
      state.data = await api(`/events/${eventId}`);
      paint();
    } catch (err) {
      if (!state.data) {
        app.innerHTML = `<section class="card"><h2>Hmm.</h2><p>${esc(err.message)}</p><a class="btn" href="/" data-link>Back home</a></section>`;
        stopPolling();
      }
    }
  };

  function paint() {
    const { event, playlists, songs } = state.data;
    document.title = `${event.name} · KTV Night`;
    document.getElementById('event-head').innerHTML = `
      <section class="event-hero">
        <a href="/" data-link class="back">‹ All nights</a>
        <p class="eyebrow">${esc(formatDate(event.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }))}</p>
        <h1>${esc(event.name)}</h1>
        <div class="hero-actions">
          <button class="btn" id="share" type="button">Copy invite link</button>
          <span class="muted">${songs.length} songs from ${plural(playlists.filter((p) => p.kind !== 'manual').length, 'playlist')}</span>
        </div>
      </section>`;
    document.getElementById('share').onclick = () => copy(location.href, 'Invite link copied');

    const names = Object.fromEntries(playlists.map((p) => [p.id, p.name]));
    document.getElementById('playlists').innerHTML = playlists
      .map(
        (p) => `
        <span class="chip ${state.playlistFilter === p.id ? 'active' : ''}">
          <button type="button" class="chip-main" data-filter="${p.id}" title="Show only songs from this playlist">
            ${p.kind === 'manual' ? '✍️' : p.kind === 'album' ? '💿' : '🎧'} ${esc(p.name)}
            <span class="muted">${p.track_count}${p.added_by ? ` · ${esc(p.added_by)}` : ''}</span>
          </button>
          <button type="button" class="chip-x" data-remove="${p.id}" aria-label="Remove ${esc(p.name)}">×</button>
        </span>`
      )
      .join('');

    const q = state.query.toLowerCase();
    let rank = 0;
    const rows = songs
      .map((s) => ({ ...s, rank: s.sung ? null : ++rank }))
      .filter((s) => !state.hideSung || !s.sung)
      .filter((s) => state.playlistFilter == null || s.playlist_ids.includes(state.playlistFilter))
      .filter((s) => !q || `${s.title} ${s.artist}`.toLowerCase().includes(q));

    document.getElementById('songs').innerHTML = rows.length
      ? rows.map((s) => songRow(s, names)).join('')
      : `<li class="empty muted">${songs.length ? 'No songs match.' : 'No songs yet. Import a playlist to get started!'}</li>`;
  }

  function songRow(s, names) {
    const inNames = s.playlist_ids.map((id) => names[id]).filter(Boolean).join(', ');
    const net = s.up - s.down;
    const yt = `https://www.youtube.com/results?search_query=${encodeURIComponent(`${s.title} ${s.artist} karaoke`)}`;
    const sp = s.spotify_uri?.startsWith('spotify:track:')
      ? `https://open.spotify.com/track/${s.spotify_uri.split(':')[2]}`
      : null;
    return `
      <li class="song ${s.sung ? 'sung' : ''}" data-id="${s.id}">
        <span class="rank">${s.rank ?? '✓'}</span>
        <div class="song-main">
          <div class="song-title">${esc(s.title)}</div>
          <div class="song-artist muted">${esc(s.artist || 'Unknown artist')}</div>
          <div class="song-meta">
            <span class="badge ${s.count > 1 ? 'hot' : ''}" title="${esc(inNames)}">
              ${s.count > 1 ? `🔥 in ${s.count} playlists` : `in 1 playlist`}
            </span>
            <a class="mini" href="${yt}" target="_blank" rel="noopener">Karaoke ↗</a>
            ${sp ? `<a class="mini" href="${sp}" target="_blank" rel="noopener">Spotify ↗</a>` : ''}
          </div>
        </div>
        <div class="vote" role="group" aria-label="Vote">
          <button type="button" class="vote-btn up ${s.my_vote > 0 ? 'on' : ''}" data-vote="1" aria-pressed="${s.my_vote > 0}" aria-label="Upvote">▲</button>
          <span class="net ${net > 0 ? 'pos' : net < 0 ? 'neg' : ''}" title="${s.up} up · ${s.down} down">${net > 0 ? '+' : ''}${net}</span>
          <button type="button" class="vote-btn down ${s.my_vote < 0 ? 'on' : ''}" data-vote="-1" aria-pressed="${s.my_vote < 0}" aria-label="Downvote">▼</button>
        </div>
        <button type="button" class="sung-btn ${s.sung ? 'on' : ''}" data-sung aria-pressed="${s.sung}" title="${s.sung ? 'Mark as not sung' : 'Mark as sung'}">✓</button>
      </li>`;
  }

  async function copy(text, message) {
    try {
      await navigator.clipboard.writeText(text);
      toast(message);
    } catch {
      prompt('Copy this:', text);
    }
  }

  document.getElementById('import-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = form.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Importing…';
    try {
      const { playlist, truncated } = await api(`/events/${eventId}/playlists`, {
        method: 'POST',
        body: { url: form.elements.url.value, addedBy: nicknameInput.value.trim() },
      });
      form.reset();
      toast(
        truncated
          ? `Added “${playlist.name}” (first 100 songs only)`
          : `Added “${playlist.name}” · ${playlist.track_count} songs`
      );
      await load();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Import';
    }
  });

  document.getElementById('manual-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      await api(`/events/${eventId}/songs`, {
        method: 'POST',
        body: { title: form.elements.title.value, artist: form.elements.artist.value, addedBy: nicknameInput.value.trim() },
      });
      form.reset();
      toast('Song added');
      await load();
    } catch (err) {
      toast(err.message, true);
    }
  });

  document.getElementById('playlists').addEventListener('click', async (e) => {
    const filter = e.target.closest('[data-filter]');
    const remove = e.target.closest('[data-remove]');
    if (filter) {
      const id = Number(filter.dataset.filter);
      state.playlistFilter = state.playlistFilter === id ? null : id;
      paint();
    } else if (remove) {
      const id = Number(remove.dataset.remove);
      const p = state.data.playlists.find((x) => x.id === id);
      if (!confirm(`Remove “${p?.name}” and its songs (and their votes) from this night?`)) return;
      try {
        await api(`/events/${eventId}/playlists/${id}`, { method: 'DELETE' });
        if (state.playlistFilter === id) state.playlistFilter = null;
        await load();
      } catch (err) {
        toast(err.message, true);
      }
    }
  });

  document.getElementById('songs').addEventListener('click', async (e) => {
    const row = e.target.closest('.song');
    if (!row) return;
    const song = state.data.songs.find((s) => s.id === Number(row.dataset.id));
    const voteBtn = e.target.closest('[data-vote]');
    const sungBtn = e.target.closest('[data-sung]');
    try {
      if (voteBtn) {
        const clicked = Number(voteBtn.dataset.vote);
        const value = song.my_vote === clicked ? 0 : clicked;
        // Optimistic update so taps feel instant; the reload re-sorts.
        if (song.my_vote > 0) song.up--;
        if (song.my_vote < 0) song.down--;
        if (value > 0) song.up++;
        if (value < 0) song.down++;
        song.my_vote = value;
        paint();
        await api(`/events/${eventId}/songs/${song.id}/vote`, { method: 'POST', body: { value } });
        await load();
      } else if (sungBtn) {
        await api(`/events/${eventId}/songs/${song.id}/sung`, { method: 'POST', body: { sung: !song.sung } });
        await load();
      }
    } catch (err) {
      toast(err.message, true);
      load();
    }
  });

  document.getElementById('search').addEventListener('input', (e) => {
    state.query = e.target.value;
    paint();
  });

  document.getElementById('hide-sung').addEventListener('change', (e) => {
    state.hideSung = e.target.checked;
    safeSet('ktv.hideSung', state.hideSung ? '1' : '0');
    paint();
  });

  document.getElementById('copy-list').addEventListener('click', async () => {
    try {
      const res = await fetch(`/api/events/${eventId}/export`);
      copy(await res.text(), 'Song list copied');
    } catch (err) {
      toast(err.message, true);
    }
  });

  await load();
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible') load();
  }, POLL_MS);
  stopPolling = () => clearInterval(timer);
}

route();
