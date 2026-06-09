#!/usr/bin/env bash
#
# dev.sh — run the full Internal Assistant dev stack in a tmux session.
#
#   ┌─ ⬡ 9router :20128 ─────────────────────────┐  top, slim, full width
#   ├─ ⚙ backend :8000 ───┬─ ▲ frontend :5173 ───┤  middle row
#   ├─ ✦ claude ──────────┴──────────────────────┤  bottom, full width
#   └────────────────────────────────────────────┘
#
# Labeled pane borders + violet status bar come from the project .tmux.conf.
# Re-running this script attaches to the existing session.
#
#   Detach (leave running): Ctrl-b d
#   Switch panes:           click (mouse) · Option+arrow · Ctrl-b h/j/k/l
#   Reload look:            Ctrl-b r
#   Kill the session:       tmux kill-session -t internal-assistant

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION=internal-assistant

# Reuse an existing session if present.
if tmux has-session -t "$SESSION" 2>/dev/null; then
  exec tmux attach -t "$SESSION"
fi

# ── Local Postgres (pgvector) ────────────────────────────────────────────────
# Bring up the postgres service from docker-compose.yml if it's not running,
# then wait until it's accepting connections. Backend reads DATABASE_URL from
# backend/.env — that file must point at this instance (default port 5432).
ensure_postgres() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "dev.sh: docker not found — skipping local Postgres bootstrap." >&2
    return
  fi

  # Read POSTGRES_USER / POSTGRES_DB from the root .env without exporting
  # everything else — otherwise root .env's FRONTEND_URL etc. would leak into
  # the backend pane and override backend/.env (Node's dotenv does NOT clobber
  # pre-existing process.env values).
  local user db
  user=$(grep -E '^POSTGRES_USER=' "$ROOT/.env" 2>/dev/null | tail -n1 | cut -d= -f2-)
  db=$(grep -E '^POSTGRES_DB=' "$ROOT/.env" 2>/dev/null | tail -n1 | cut -d= -f2-)
  user="${user:-docwise}"
  db="${db:-docwise}"

  local state
  state=$(docker compose -f "$ROOT/docker-compose.yml" ps -q postgres 2>/dev/null \
          | xargs -I{} docker inspect -f '{{.State.Running}}' {} 2>/dev/null || true)
  if [[ "$state" != "true" ]]; then
    echo "dev.sh: starting postgres via docker compose…"
    docker compose -f "$ROOT/docker-compose.yml" up -d postgres
  fi

  echo -n "dev.sh: waiting for postgres"
  for _ in $(seq 1 30); do
    if docker compose -f "$ROOT/docker-compose.yml" exec -T postgres \
         pg_isready -U "$user" -d "$db" >/dev/null 2>&1; then
      echo " ✓"; return
    fi
    echo -n "."; sleep 1
  done
  echo
  echo "dev.sh: postgres did not become ready in time" >&2
  exit 1
}

ensure_postgres

# 9router (top, full width).
tmux new-session -d -s "$SESSION" -c "$ROOT" -n dev

# Load the project tmux config (theme, mouse, pane titles, keybindings).
tmux source-file "$ROOT/.tmux.conf"
tmux bind r source-file "$ROOT/.tmux.conf" \; display "Internal Assistant tmux config reloaded"
tmux select-pane -t "$SESSION" -T "⬡ 9router  :20128"
tmux send-keys   -t "$SESSION" '9router' Enter

# backend (middle-left) — fills the full-width lower region first (85%),
# leaving 9router a small strip on top.
svc=$(tmux split-window -P -F '#{pane_id}' -v -l 85% -t "$SESSION" -c "$ROOT/backend")
tmux select-pane -t "$svc" -T "⚙ backend  :8000"
tmux send-keys   -t "$svc" 'npm run dev' Enter

# claude (bottom, full width — 70% of the lower region).
cla=$(tmux split-window -P -F '#{pane_id}' -v -l 70% -t "$svc" -c "$ROOT")
tmux select-pane -t "$cla" -T "✦ claude"
tmux send-keys   -t "$cla" 'claude' Enter

# frontend (right of backend).
fe=$(tmux split-window -P -F '#{pane_id}' -h -t "$svc" -c "$ROOT/frontend")
tmux select-pane -t "$fe" -T "▲ frontend :5173"
tmux send-keys   -t "$fe" 'npm run dev' Enter

# Land focus on the claude pane.
tmux select-pane -t "$cla"
exec tmux attach -t "$SESSION"
