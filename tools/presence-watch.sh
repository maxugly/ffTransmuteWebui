#!/usr/bin/env bash
# presence-watch.sh — polls .presence.json, detects agent state changes.
# Adapted from AIIM presence-watch.sh for the nested ffTransmuteWebui format.
#
# Tracks: pending (poke), current (task), status changes.
# Prints notifications to stdout. Add --webhook URL for remote delivery.
#
# Usage:
#   ./presence-watch.sh [--poll 3] [--webhook URL]
#   ./presence-watch.sh --once   (print current board and exit)
#
# Requirements: curl, jq
# Exit codes: 0 = clean exit (SIGTERM/INT), 1 = setup failure

set -euo pipefail
IFS=$'\n'

# ── config ────────────────────────────────────────────────────────────
POLL_SEC="${POLL_SEC:-3}"
PROJECT_DIR="${PROJECT_DIR:-$(dirname "$(readlink -f "$0")")}"
PRESENCE_FILE="${PROJECT_DIR}/.presence.json"
WEBHOOK_URL="${WEBHOOK_URL:-}"
ONCE="${ONCE:-false}"
AGENTS_FILTER="${AGENTS_FILTER:-}"   # comma-separated list: only notify about these agents

# CLI overrides
while [[ $# -gt 0 ]]; do
  case "$1" in
    --poll)    POLL_SEC="$2"; shift 2 ;;
    --webhook) WEBHOOK_URL="$2"; shift 2 ;;
    --project) PROJECT_DIR="$2"; shift 2 ;;
    --agents)  AGENTS_FILTER="$2"; shift 2 ;;
    --once)    ONCE=true; shift ;;
    *)         echo "unknown: $1"; exit 1 ;;
  esac
done

PRESENCE_FILE="${PROJECT_DIR}/.presence.json"

# ── ensure jq ─────────────────────────────────────────────────────────
if ! command -v jq &>/dev/null; then
  echo "presence-watch: jq required (pacman -S jq)" >&2
  exit 1
fi

# ── helpers ───────────────────────────────────────────────────────────
now_epoch() { date +%s; }

# Returns 0 if agent should be notified, 1 if filtered out
should_notify() {
  local agent="$1"
  if [[ -z "${AGENTS_FILTER:-}" ]]; then
    return 0  # no filter — notify everyone
  fi
  # Check if agent is in the comma-separated list
  local IFS=','
  for allowed in $AGENTS_FILTER; do
    if [[ "$agent" == "$allowed" ]]; then
      return 0
    fi
  done
  return 1
}

notify() {
  local msg="$1"
  local agent="${2:-}"
  # Filter check — skip if agent not in allowed list
  if [[ -n "${agent:-}" ]]; then
    should_notify "$agent" || return 0
  fi
  local ts
  ts=$(date '+%H:%M:%S')
  echo "[${ts}] ${msg}"
  if [[ -n "${WEBHOOK_URL:-}" ]]; then
    curl -s -X POST -H "Content-Type: application/json" \
      -d "{\"text\":\"${msg}\"}" "$WEBHOOK_URL" >/dev/null 2>&1 || true
  fi
}

# ── once mode ─────────────────────────────────────────────────────────
if $ONCE; then
  if [[ -f "$PRESENCE_FILE" ]]; then
    echo "=== agents ==="
    jq -r '.agents | to_entries[] | "\(.key): status=\(.value.status) current=\(.value.current // "—") pending=\(.value.pending // "none")"' "$PRESENCE_FILE"
    echo ""
    echo "=== milestones ==="
    jq -r '.state.milestones | to_entries[] | "\(.key): \(.value.status) — \(.value.label) (\(.value.by))"' "$PRESENCE_FILE"
  else
    echo "(no .presence.json yet)"
  fi
  exit 0
fi

# ── main loop ─────────────────────────────────────────────────────────
trap 'echo; echo "presence-watch: stopped"; exit 0' INT TERM

echo "presence-watch: polling ${PRESENCE_FILE} every ${POLL_SEC}s"
echo "  project: ${PROJECT_DIR}"
[[ -n "${WEBHOOK_URL:-}" ]] && echo "  webhook: ${WEBHOOK_URL}"

# Track previous values per agent: status, current, pending
declare -A LAST_STATUS
declare -A LAST_CURRENT
declare -A LAST_PENDING

while true; do
  if [[ ! -f "$PRESENCE_FILE" ]]; then
    sleep "$POLL_SEC"
    continue
  fi

  DATA=$(jq -c '.' "$PRESENCE_FILE" 2>/dev/null) || { sleep "$POLL_SEC"; continue; }

  # ── iterate agents ─────────────────────────────────────────────────
  AGENT_IDS=$(echo "$DATA" | jq -r '.agents | keys[]' 2>/dev/null) || AGENT_IDS=""
  for id in $AGENT_IDS; do
    status=$(echo "$DATA"  | jq -r ".agents.\"$id\".status // \"offline\"")
    current=$(echo "$DATA" | jq -r ".agents.\"$id\".current // \"\"")
    pending=$(echo "$DATA" | jq -r ".agents.\"$id\".pending // \"\"")

    old_status="${LAST_STATUS[$id]:-}"
    old_current="${LAST_CURRENT[$id]:-}"
    old_pending="${LAST_PENDING[$id]:-}"

    # ── POKE: pending appeared or changed ──────────────────────────
    if [[ -n "$pending" && "$pending" != "null" ]]; then
      if [[ "$pending" != "$old_pending" ]]; then
        if [[ -z "$old_pending" || "$old_pending" == "null" ]]; then
          notify "🔔 POKE → ${id}: ${pending}" "$id"
        else
          notify "🔔 ${id} poke updated: ${pending}" "$id"
        fi
      fi
    elif [[ (-z "$pending" || "$pending" == "null") && -n "$old_pending" && "$old_pending" != "null" ]]; then
      notify "✅ ${id} poke cleared (was: ${old_pending})" "$id"
    fi

    # ── task change ─────────────────────────────────────────────────
    if [[ -n "$current" && "$current" != "$old_current" ]]; then
      if [[ -z "$old_current" ]]; then
        notify "📋 ${id} started: ${current}" "$id"
      else
        notify "📋 ${id} switched → ${current}" "$id"
      fi
    fi

    # ── status change ───────────────────────────────────────────────
    if [[ "$status" != "$old_status" ]]; then
      if [[ "$old_status" == "" ]]; then
        notify "👋 ${id} appeared — ${status}" "$id"
      elif [[ "$status" == "offline" ]]; then
        notify "❌ ${id} went offline" "$id"
      elif [[ "$status" == "idle" ]]; then
        notify "💤 ${id} is now idle" "$id"
      elif [[ "$status" == "active" && "$old_status" != "active" ]]; then
        notify "🔧 ${id} is active" "$id"
      fi
    fi

    LAST_STATUS[$id]="$status"
    LAST_CURRENT[$id]="$current"
    LAST_PENDING[$id]="$pending"
  done

  # ── agents removed from board ──────────────────────────────────────
  for id in "${!LAST_STATUS[@]}"; do
    in_board=$(echo "$DATA" | jq -r ".agents | has(\"$id\")" 2>/dev/null)
    if [[ "$in_board" != "true" ]]; then
      if [[ "${LAST_STATUS[$id]}" != "offline" ]]; then
        notify "❌ ${id} removed from board"
      fi
      unset "LAST_STATUS[$id]"
      unset "LAST_CURRENT[$id]"
      unset "LAST_PENDING[$id]"
    fi
  done

  sleep "$POLL_SEC"
done
