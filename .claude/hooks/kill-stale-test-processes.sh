#!/usr/bin/env bash
# Stops test and check runs of this repository that have been running longer than a limit; a normal
# `bun run check` takes about 20 seconds, so anything older is stuck. Only test runners are touched:
# the Next.js dev server, the NEAR sandbox, and editor tooling are never matched.
# Runs from the Stop and SessionEnd hooks; prints a hook JSON message only when it stopped something.
set -u

project_dir="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
max_age_seconds="${LAST_CALL_STALE_TEST_SECONDS:-600}"

# ps etime is [[dd-]hh:]mm:ss.
elapsed_seconds() {
  local value="$1" days=0 hours=0 minutes=0 seconds=0
  if [[ "$value" == *-* ]]; then
    days="${value%%-*}"
    value="${value#*-}"
  fi
  IFS=: read -r -a parts <<<"$value"
  case "${#parts[@]}" in
    3) hours="${parts[0]}" minutes="${parts[1]}" seconds="${parts[2]}" ;;
    2) minutes="${parts[0]}" seconds="${parts[1]}" ;;
    *) seconds="${parts[0]}" ;;
  esac
  echo $((10#$days * 86400 + 10#$hours * 3600 + 10#$minutes * 60 + 10#$seconds))
}

process_cwd() {
  lsof -a -d cwd -p "$1" -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
}

stale=()
while read -r pid etime command; do
  [[ -z "${pid:-}" ]] && continue
  # bun test …, bun run check, bun run test / test:bun / test:database …
  [[ "$command" =~ (^|/)bun\ (test( |$)|run\ (check|test)([:a-z-]*)( |$)) ]] || continue
  (($(elapsed_seconds "$etime") > max_age_seconds)) || continue
  cwd="$(process_cwd "$pid")"
  [[ "$cwd" == "$project_dir" || "$cwd" == "$project_dir"/* ]] || continue
  stale+=("$pid")
done < <(ps -Ao pid=,etime=,command=)

((${#stale[@]} == 0)) && exit 0

kill -TERM "${stale[@]}" 2>/dev/null
sleep 2
survivors=()
for pid in "${stale[@]}"; do
  kill -0 "$pid" 2>/dev/null && survivors+=("$pid")
done
((${#survivors[@]} > 0)) && kill -KILL "${survivors[@]}" 2>/dev/null

printf '{"systemMessage":"Stopped %d stale test/check process(es) older than %d min: %s"}\n' \
  "${#stale[@]}" "$((max_age_seconds / 60))" "${stale[*]}"
exit 0
