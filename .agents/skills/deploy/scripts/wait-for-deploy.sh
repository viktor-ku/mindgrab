#!/usr/bin/env bash
# Wait for the Railway production deployment of one commit to reach a final status.
# Usage: [SERVICE=web] wait-for-deploy.sh <commit-sha> [timeout-seconds]
# Prints each status change; exits 0 on SUCCESS, 1 on any other final status, 2 on timeout.
set -euo pipefail

project=8b285039-3bb1-4136-a31d-5fede17bc0e8
environment=production
service="${SERVICE:-mindgrab}"
sha="${1:?usage: wait-for-deploy.sh <commit-sha> [timeout-seconds]}"
timeout="${2:-1800}"
export PATH="$HOME/.railway/bin:$PATH"

sha="$(git rev-parse --verify "$sha^{commit}")"
deadline=$((SECONDS + timeout))
last=""

while ((SECONDS < deadline)); do
  row="$(railway deployment list -p "$project" -e "$environment" -s "$service" --limit 20 --json 2>/dev/null |
    jq -r --arg sha "$sha" 'map(select(.meta.commitHash == $sha)) | first // empty | "\(.id) \(.status)"' || true)"
  if [[ -z "$row" ]]; then
    status="NOT_FOUND"
    id="-"
  else
    read -r id status <<<"$row"
  fi
  if [[ "$status" != "$last" ]]; then
    printf '%s deployment=%s commit=%s status=%s\n' "$(date +%H:%M:%S)" "$id" "${sha:0:7}" "$status"
    last="$status"
  fi
  case "$status" in
    SUCCESS) exit 0 ;;
    FAILED | CRASHED | REMOVED | SKIPPED | NEEDS_APPROVAL) exit 1 ;;
  esac
  sleep 15
done

printf 'Timed out after %ss; last status=%s\n' "$timeout" "$last" >&2
exit 2
