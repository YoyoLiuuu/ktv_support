#!/usr/bin/env bash
# Starts the app on :3456 and the Cloudflare tunnel for ktv.agentfacehub.com in the background.
# Logs: data/app.log, data/tunnel.log
cd "$(dirname "$0")" && mkdir -p data
if ! curl -sf localhost:3456/healthz >/dev/null; then
  PORT=3456 setsid nohup node server.js >> data/app.log 2>&1 < /dev/null &
fi
if ! pgrep -f "cloudflared.*ktv.yml" >/dev/null; then
  setsid nohup ~/.local/bin/cloudflared tunnel --no-autoupdate --config ~/.cloudflared/ktv.yml run >> data/tunnel.log 2>&1 < /dev/null &
fi
sleep 3 && curl -sf https://ktv.agentfacehub.com/healthz >/dev/null && echo "Live at https://ktv.agentfacehub.com" || echo "Starting… check data/*.log"
