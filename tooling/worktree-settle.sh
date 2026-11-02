#!/bin/sh
# Release what `mise run worktree:bootstrap` set up for a linked worktree:
# stop its dev servers, remove its Compose project (Postgres container, network
# and data volume) and drop the generated settings from mise.local.toml.
# The main checkout is left alone. Safe to run more than once.
set -eu

worktree_root="$(cd "${1:-.}" && pwd -P)"
main_checkout="$(git -C "$worktree_root" worktree list --porcelain | sed -n '1s/^worktree //p')"
main_checkout="$(cd "$main_checkout" && pwd -P)"
config="$worktree_root/mise.local.toml"
generated_keys='COMPOSE_PROJECT_NAME|WEBAPP_PORT|PORT|POSTGRES_PORT|DATABASE_URL|VITE_BACKEND_URL|WORKOS_REDIRECT_URI|APP_URL'

if [ "$worktree_root" = "$main_checkout" ]; then
  echo "Main checkout uses the default settings; nothing to settle."
  exit 0
fi

setting() {
  [ -f "$config" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"\(.*\)\"[[:space:]]*\$/\1/p" "$config" | head -n 1
}

process_cwd() {
  if [ -d "/proc/$1" ]; then
    readlink "/proc/$1/cwd" 2>/dev/null || true
  else
    lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'
  fi
}

# Stop servers listening on this worktree's ports, but only processes that run
# from inside this worktree, so a stranger that later took the port survives.
stop_port() {
  [ -n "$1" ] || return 0
  command -v lsof >/dev/null 2>&1 || { echo "lsof not found; skipped stopping servers on port $1." >&2; return 0; }
  for pid in $(lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | sort -u); do
    cwd="$(process_cwd "$pid")"
    case "$cwd" in
      "$worktree_root" | "$worktree_root"/*)
        echo "Stopping process $pid on port $1."
        kill "$pid" 2>/dev/null || true
        for _ in 1 2 3 4 5 6 7 8 9 10; do
          kill -0 "$pid" 2>/dev/null || break
          sleep 0.5
        done
        kill -9 "$pid" 2>/dev/null || true
        ;;
      *)
        echo "Port $1 is used by process $pid outside this worktree; left it running." >&2
        ;;
    esac
  done
}

project="$(setting COMPOSE_PROJECT_NAME)"
if [ -z "$project" ]; then
  echo "No worktree settings in $config; nothing to settle."
  exit 0
fi

stop_port "$(setting WEBAPP_PORT)"
stop_port "$(setting PORT)"

# Keep the settings when Docker cleanup fails so a later run can still find the project.
if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker is not available; Compose project $project was not removed. Start Docker and rerun." >&2
  exit 1
fi
echo "Removing Compose project $project and its volumes."
(cd "$worktree_root" && docker compose --project-name "$project" down --volumes --remove-orphans)

# Remove the generated variables; delete the file when nothing else is left.
tmp="$config.settle.$$"
trap 'rm -f "$tmp"' EXIT
grep -Ev "^[[:space:]]*($generated_keys)[[:space:]]*=" "$config" >"$tmp" || true
if grep -Ev '^[[:space:]]*(#.*)?$|^\[env\][[:space:]]*$|^_[[:space:]]*=[[:space:]]*\{[[:space:]]*file[[:space:]]*=' "$tmp" >/dev/null; then
  cat "$tmp" >"$config"
  echo "Removed generated worktree settings from $config."
else
  rm -f "$config"
  echo "Removed $config."
fi
echo "Worktree settled."
