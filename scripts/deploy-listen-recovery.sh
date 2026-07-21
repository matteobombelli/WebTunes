#!/usr/bin/env bash
# One-time production deployment for migration 0027 and selective recovery of
# legacy listen history from the last healthy R2 backup. Historical rows remain
# available to Discover/friend activity but are excluded from the new Stats.

set -Eeuo pipefail

readonly APP_SERVICE="webtunes.service"
readonly BACKUP_TIMER="webtunes-backup.timer"
readonly BACKUP_KEY="backups/webtunes-2026-07-08T04-00-05-230Z.dump"
readonly LOCK_FILE="/run/webtunes-listen-recovery.lock"

readonly APP_ROOT="$(readlink -f "$(dirname "${BASH_SOURCE[0]}")/..")"
readonly APP_USER="$(stat -c '%U' "${APP_ROOT}")"

usage() {
  echo "Usage: sudo bash scripts/deploy-listen-recovery.sh --apply"
  echo
  echo "This recovers legacy listens from:"
  echo "  ${BACKUP_KEY}"
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

[[ ${EUID} -eq 0 ]] || die "Run this script with sudo."
[[ ${1:-} == "--apply" && $# -eq 1 ]] || {
  usage
  exit 2
}

for command in flock git install mktemp pgrep readlink rm runuser sed stat systemctl; do
  command -v "${command}" >/dev/null || die "Required command is missing: ${command}"
done

exec 9>"${LOCK_FILE}"
flock -n 9 || die "Another listen-recovery deployment is already running."

[[ ${APP_ROOT} == /* ]] || die "Could not resolve the WebTunes checkout path."
[[ ${APP_ROOT} =~ ^/[A-Za-z0-9._/-]+$ ]] || die \
  "Unsupported characters in checkout path: ${APP_ROOT}"
[[ ${APP_USER} != "root" ]] || die \
  "The checkout must be owned by the non-root user that runs WebTunes."
[[ ${APP_USER} =~ ^[a-z_][a-z0-9_-]*[$]?$ ]] || die \
  "Unsupported checkout owner name: ${APP_USER}"

for path in \
  "drizzle/0027_greedy_mathemanic.sql" \
  "scripts/restore-listen-history.mjs" \
  "deploy/webtunes-backup.service" \
  "deploy/webtunes-backup.timer"; do
  [[ -f "${APP_ROOT}/${path}" ]] || die "Missing required file: ${path}"
done

run_app() {
  runuser -u "${APP_USER}" -- /bin/bash -lc \
    "cd '${APP_ROOT}' && $1"
}

systemctl cat "${APP_SERVICE}" >/dev/null || die \
  "${APP_SERVICE} is not installed on this host."
service_root="$(systemctl show "${APP_SERVICE}" -p WorkingDirectory --value)"
service_user="$(systemctl show "${APP_SERVICE}" -p User --value)"
[[ ${service_root} == "${APP_ROOT}" ]] || die \
  "${APP_SERVICE} uses ${service_root:-no WorkingDirectory}, not ${APP_ROOT}."
[[ ${service_user} == "${APP_USER}" ]] || die \
  "${APP_SERVICE} runs as ${service_user:-root}, not ${APP_USER}."
run_app "git diff --quiet" || die \
  "The production checkout has tracked changes. Commit or remove them first."
run_app "git diff --cached --quiet" || die \
  "The production checkout has staged changes. Commit or remove them first."

timer_was_active=0
app_was_stopped=0
backup_service_tmp=""

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM

  if (( app_was_stopped )); then
    echo "Restarting ${APP_SERVICE} after an interrupted deployment..." >&2
    systemctl start "${APP_SERVICE}" || true
  fi
  if (( timer_was_active )); then
    echo "Restarting ${BACKUP_TIMER} after an interrupted deployment..." >&2
    systemctl start "${BACKUP_TIMER}" || true
  fi
  if [[ -n ${backup_service_tmp} ]]; then
    rm -f "${backup_service_tmp}" || true
  fi

  if (( exit_code != 0 )); then
    echo "Recovery deployment failed. Review the error above before retrying." >&2
  fi
  exit "${exit_code}"
}
trap cleanup EXIT INT TERM

if systemctl is-active --quiet "${BACKUP_TIMER}"; then
  timer_was_active=1
  echo "Pausing ${BACKUP_TIMER} during recovery..."
  systemctl stop "${BACKUP_TIMER}"
fi

echo
echo "[1/9] Validating the July 8 archive in a temporary database..."
run_app "node scripts/restore-listen-history.mjs --backup-key='${BACKUP_KEY}'"

echo
echo "[2/9] Taking a pre-recovery backup of the current database..."
run_app "node scripts/backup-db-to-r2.mjs"

echo
echo "[3/9] Stopping ${APP_SERVICE}..."
systemctl stop "${APP_SERVICE}"
app_was_stopped=1

# A previous `next start` can survive a systemd restart outside the unit's
# cgroup. While the real service is stopped, only terminate next-server
# processes whose cwd proves they belong to this checkout.
mapfile -t stale_pids < <(pgrep -f 'next-server' || true)
repo_stale_pids=()
for pid in "${stale_pids[@]}"; do
  [[ -d "/proc/${pid}" ]] || continue
  process_cwd="$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)"
  if [[ ${process_cwd} == "${APP_ROOT}" ]]; then
    repo_stale_pids+=("${pid}")
  fi
done
if (( ${#repo_stale_pids[@]} > 0 )); then
  echo "Stopping stale WebTunes next-server process(es): ${repo_stale_pids[*]}"
  for pid in "${repo_stale_pids[@]}"; do
    kill -TERM "${pid}" 2>/dev/null || true
  done
  for _ in 1 2 3 4 5; do
    remaining=()
    for pid in "${repo_stale_pids[@]}"; do
      kill -0 "${pid}" 2>/dev/null && remaining+=("${pid}")
    done
    (( ${#remaining[@]} == 0 )) && break
    sleep 1
  done
  (( ${#remaining[@]} == 0 )) || die \
    "Stale next-server process(es) would not stop: ${remaining[*]}"
fi

echo
echo "[4/9] Applying database migration 0027..."
run_app "npx drizzle-kit migrate"

echo
echo "[5/9] Recovering legacy listens without adding them to Stats..."
existing_recovered_count="$(run_app \
  'docker compose exec -T postgres psql -U webtunes -d webtunes -Atqc "SELECT count(*) FROM listens WHERE include_in_stats = false;"')"
existing_recovered_count="${existing_recovered_count//[[:space:]]/}"
[[ ${existing_recovered_count} =~ ^[0-9]+$ ]] || die \
  "Could not inspect existing recovered listens (got: ${existing_recovered_count})."
if (( existing_recovered_count > 0 )); then
  echo "Recovery is already present (${existing_recovered_count} legacy rows); skipping the idempotency-guarded apply step."
else
  run_app "node scripts/restore-listen-history.mjs --backup-key='${BACKUP_KEY}' --apply"
fi

echo
echo "[6/9] Verifying recovered data..."
recovered_count="$(run_app \
  'docker compose exec -T postgres psql -U webtunes -d webtunes -Atqc "SELECT count(*) FROM listens WHERE include_in_stats = false;"')"
recovered_count="${recovered_count//[[:space:]]/}"
[[ ${recovered_count} =~ ^[0-9]+$ ]] || die \
  "Could not read the recovered-listen count (got: ${recovered_count})."
(( recovered_count > 0 )) || die "No legacy listen rows were recovered."
run_app \
  'docker compose exec -T postgres psql -U webtunes -d webtunes -P pager=off -c "SELECT count(*) AS all_listens, count(*) FILTER (WHERE include_in_stats = false) AS recovered_legacy_listens, count(*) FILTER (WHERE include_in_stats = true) AS new_stats_listens FROM listens; SELECT sum(friend_play_count) AS friend_listens FROM tracks;"'

echo
echo "[7/9] Building the recovered release as ${APP_USER}..."
run_app "npm run build"

echo
echo "[8/9] Starting and checking ${APP_SERVICE}..."
systemctl start "${APP_SERVICE}"
app_was_stopped=0
sleep 2
if ! systemctl is-active --quiet "${APP_SERVICE}"; then
  journalctl -u "${APP_SERVICE}" -n 80 --no-pager >&2 || true
  die "${APP_SERVICE} did not stay active after restart."
fi
systemctl status "${APP_SERVICE}" --no-pager -l

mapfile -t next_pids < <(pgrep -f 'next-server' || true)
repo_next_pids=()
for pid in "${next_pids[@]}"; do
  [[ -d "/proc/${pid}" ]] || continue
  process_cwd="$(readlink -f "/proc/${pid}/cwd" 2>/dev/null || true)"
  if [[ ${process_cwd} == "${APP_ROOT}" ]]; then
    repo_next_pids+=("${pid}")
  fi
done
(( ${#repo_next_pids[@]} == 1 )) || die \
  "Expected one WebTunes next-server process, found ${#repo_next_pids[@]}: ${repo_next_pids[*]:-none}"
echo "WebTunes next-server PID: ${repo_next_pids[0]}"

echo
echo "[9/9] Taking a post-recovery backup and repairing the daily timer..."
run_app "node scripts/backup-db-to-r2.mjs"
backup_service_tmp="$(mktemp /tmp/webtunes-backup.service.XXXXXX)"
sed \
  -e "s/^User=.*/User=${APP_USER}/" \
  -e "s|^WorkingDirectory=.*|WorkingDirectory=${APP_ROOT}|" \
  "${APP_ROOT}/deploy/webtunes-backup.service" >"${backup_service_tmp}"
install -o root -g root -m 0644 \
  "${backup_service_tmp}" \
  "/etc/systemd/system/webtunes-backup.service"
rm -f "${backup_service_tmp}"
backup_service_tmp=""
install -o root -g root -m 0644 \
  "${APP_ROOT}/deploy/webtunes-backup.timer" \
  "/etc/systemd/system/webtunes-backup.timer"
systemctl daemon-reload
systemctl enable "${BACKUP_TIMER}"
systemctl restart "${BACKUP_TIMER}"
timer_was_active=0
systemctl status "${BACKUP_TIMER}" --no-pager -l
systemctl list-timers "${BACKUP_TIMER}" --no-pager

trap - EXIT INT TERM
echo
echo "Recovery deployment complete."
echo "Recovered legacy listens: ${recovered_count}"
echo "Stats now use only new 50%-threshold telemetry."
echo "A fresh post-recovery R2 backup was created and the daily timer is active."
