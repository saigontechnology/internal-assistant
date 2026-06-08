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
