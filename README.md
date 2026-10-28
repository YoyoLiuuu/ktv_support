# KTV Night 🎤

let's get songssss

Plan a KTV night by date, have everyone import their Spotify playlists, and get one ranked song list:

- **Most common first**: a song that shows up in 3 people's playlists outranks one that shows up in 1 (versions like "- Remastered" or "(feat. X)" are merged).
- **Votes**: anyone with the link can 👍 / 👎. Score = playlists it's in + upvotes − downvotes.
- **At the KTV**: tick ✓ when a song's been sung; it drops to the bottom. "Copy list" / CSV export gives the queue to type into the machine.

## Run locally

Requires Node 22.13+ (uses the built-in `node:sqlite`, no npm dependencies).

```sh
npm start            # http://localhost:3000
```

## Config

| env | default | |
| --- | --- | --- |
| `PORT` | `3000` | |
| `DB_PATH` | `./data/ktv.db` | point at a persistent volume in production |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | unset | optional; without them imports read Spotify's public embed page, which only lists the first 100 tracks |

## Deploy (Railway)

Attach a volume mounted at `/data`, set `DB_PATH=/data/ktv.db`, and add the custom domain `ktv.agentfacehub.com` (CNAME to the target Railway gives you).
