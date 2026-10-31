#!/bin/sh
# Local restore drill (phase 4 gate): a chat created before the stack and its volume are deleted
# must open after scripts/restore.sh rebuilds /data from the S3 bucket. Needs docker and node.
# S3 stand-in: rustfs (MinIO's Docker Hub repository is gone, see docs/deploy.md).
set -eu
cd "$(dirname "$0")/.."
ROOT=$PWD
export COMPOSE_PROJECT_NAME=padrill
PORT=${DRILL_PORT:-13000}
S3PORT=${DRILL_S3_PORT:-19000}
TMP=$(mktemp -d)

export S3_ENDPOINT=http://s3:9000 S3_BUCKET=drillbucket S3_ACCESS_KEY=drillkey S3_SECRET_KEY=drillsecret123
export RESTIC_PASSWORD=drill-restic-pass DRILL_PORT=$PORT DRILL_S3_PORT=$S3PORT
export AUTH_ORIGIN=http://127.0.0.1:$PORT AUTH_PASSKEY_RP_ID=127.0.0.1
export COOKIE_SECRET=drill-cookie-secret-0123456789abcdef0123 USER_ID=drill MODEL=zdr/strong
export PSEUDO_VAULT_KEY=drill-vault-key OPENROUTER_API_KEY=unused
export LITELLM_URL=http://127.0.0.1:9 LITELLM_MASTER_KEY=drill-litellm-key-0123456789abcdef
# Required by mcp-workspace, which the drill does not start. Its token volume is not drilled.
export GOOGLE_OAUTH_CLIENT_ID=unused GOOGLE_OAUTH_CLIENT_SECRET=unused USER_GOOGLE_EMAIL=unused@example.invalid
PW=drill-password
AUTH_PASSWORD_HASH=$(printf %s "$PW" | node scripts/hash-password.mjs)
export AUTH_PASSWORD_HASH

cat >"$TMP/override.yaml" <<YAML
services:
  s3:
    image: rustfs/rustfs:1.0.3@sha256:9ca9559533b537d10482fe923288b676ad08f92a7069d9a17327fbae3cab688b
    environment:
      RUSTFS_ACCESS_KEY: \${S3_ACCESS_KEY}
      RUSTFS_SECRET_KEY: \${S3_SECRET_KEY}
    ports: ["127.0.0.1:\${DRILL_S3_PORT}:9000"]
    networks: [internal]
  pa-server:
    image: pa-server:dev
    environment:
      PSEUDO_URL: ""  # empty disables the sidecar client; masking is not under test
      NODE_ENV: development  # production refuses to start without PSEUDO_URL
    ports: ["127.0.0.1:\${DRILL_PORT}:3000"]
YAML
dc() { docker compose -f infra/compose.yaml -f "$TMP/override.yaml" "$@"; }

cleanup() {
  code=$?
  [ "$code" -eq 0 ] || { echo "drill FAILED (exit $code); recent logs:"; dc logs --tail 15 pa-server backup 2>&1 || true; }
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$TMP"
  exit "$code"
}
trap cleanup EXIT INT TERM

# WebSocket client. create: log in, make a chat, send one message (the model call fails; fine).
# verify ID: log in, assert chat.list holds the chat and chat.open returns the user message.
cat >"$TMP/client.mjs" <<'JS'
import { createRequire } from 'node:module';
const WebSocket = createRequire(`${process.env.ROOT}/apps/server/package.json`)('ws');
const [mode, id] = process.argv.slice(2);
const base = process.env.AUTH_ORIGIN;
const TEXT = 'drill-hello';
const res = await fetch(`${base}/api/auth/password`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: process.env.PW }),
});
if (!res.ok) throw new Error(`login ${res.status}`);
const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { cookie, origin: base } });
const inbox = [];
let wake;
ws.on('message', (d) => { inbox.push(JSON.parse(d)); wake?.(); });
const next = async (pred, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) {
    const i = inbox.findIndex(pred);
    if (i >= 0) return inbox.splice(i, 1)[0];
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => { wake = r; setTimeout(r, 200); });
  }
};
const send = (m) => ws.send(JSON.stringify(m));
await next((m) => m.type === 'auth.state');
if (mode === 'create') {
  send({ type: 'chat.create' });
  const { chat } = await next((m) => m.type === 'chat.created');
  send({ type: 'user.message', chatId: chat.id, text: TEXT });
  await next((m) => m.type === 'error' || (m.type === 'agent.status' && m.state === 'idle')).catch(() => {});
  console.log(chat.id);
} else {
  send({ type: 'chat.list' });
  const { chats } = await next((m) => m.type === 'chat.list');
  if (!chats.some((c) => c.id === id)) throw new Error('chat missing from chat.list');
  send({ type: 'chat.open', chatId: id });
  const { messages } = await next((m) => m.type === 'chat.state');
  if (!messages.some((m) => m.role === 'user' && m.text === TEXT)) throw new Error('user message missing');
  console.log(`chat ${id} listed, user message present`);
}
ws.close();
process.exit(0);
JS
client() { ROOT=$ROOT PW=$PW node "$TMP/client.mjs" "$@"; }
wait_http() { i=0; until curl -fs -o /dev/null "$1"; do i=$((i + 1)); [ $i -lt 60 ] || { echo "timeout waiting for $1"; exit 1; }; sleep 1; done; }

echo "== start s3, pa-server, backup"
dc up -d s3
i=0; until curl -s -o /dev/null "http://127.0.0.1:$S3PORT/"; do i=$((i + 1)); [ $i -lt 30 ] || exit 1; sleep 1; done
dc exec -T s3 mkdir -p "/data/$S3_BUCKET"
docker image inspect pa-server:dev >/dev/null 2>&1 \
  || docker build -f infra/Dockerfile.server -t pa-server:dev .
dc build backup
dc up -d --no-build pa-server backup
wait_http "http://127.0.0.1:$PORT/healthz"

echo "== create chat"
CHAT=$(client create)
echo "chat $CHAT"
sleep 5
echo "== restic backup (nightly, then the hourly app.db snapshot by hand)"
dc exec -T backup /backup-now.sh
dc exec -T backup sh -c 'restic backup /data/app.db $( [ -e /data/app.db-wal ] && echo /data/app.db-wal ) --tag app' >/dev/null

echo "== delete stack and volume"
dc stop pa-server backup
dc rm -f pa-server backup
docker volume rm padrill_pa-data

echo "== restore"
dc run --rm --no-deps backup /scripts/restore.sh
dc up -d --no-build pa-server
wait_http "http://127.0.0.1:$PORT/healthz"
client verify "$CHAT"
echo "DRILL OK"
