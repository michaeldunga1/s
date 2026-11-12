#!/usr/bin/env bash
set -Eeuo pipefail
umask 022

REPO_DIR="${DEPLOY_PATH:-/home/deploy/s}"
BRANCH="${DEPLOY_BRANCH:-main}"
APPS_FILE_REL="deploy/apps.conf"
ENV_DIR="${DEPLOY_ENV_DIR:-/etc/deploy/apps}"
LOCK_FILE="${DEPLOY_LOCK_FILE:-/tmp/deploy-$(id -u).lock}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"
HEALTH_DELAY="${HEALTH_DELAY:-1}"

log() {
  printf '%s [deploy] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

die() {
  log "ERROR: $*"
  return 1
}

exec 9>"$LOCK_FILE"
flock -n 9 || die "another deployment is already running"

cd "$REPO_DIR" || die "repository not found: $REPO_DIR"
[[ -d .git ]] || die "not a git repository: $REPO_DIR"

git fetch --prune origin "$BRANCH"
OLD_SHA="$(git rev-parse HEAD)"
NEW_SHA="$(git rev-parse "origin/$BRANCH")"

if [[ "$OLD_SHA" == "$NEW_SHA" ]]; then
  log "already at $NEW_SHA; nothing to deploy"
  exit 0
fi

mapfile -t CHANGED_DIRS < <(git diff --name-only "$OLD_SHA" "$NEW_SHA" | awk -F/ 'NF > 1 { print $1 }' | sort -u)
CHANGED_APPS=()
for dir in "${CHANGED_DIRS[@]}"; do
  if git cat-file -e "$NEW_SHA:$dir/package.json" 2>/dev/null; then
    CHANGED_APPS+=("$dir")
  fi
done

declare -A APP_NAME=()
declare -A APP_PORT=()
declare -A APP_HEALTH=()

load_apps() {
  local file="$REPO_DIR/$APPS_FILE_REL"
  local folder name port health
  [[ -f "$file" ]] || die "missing app map: $file"
  APP_NAME=()
  APP_PORT=()
  APP_HEALTH=()
  while IFS='|' read -r folder name port health _; do
    folder="${folder//[[:space:]]/}"
    name="${name//[[:space:]]/}"
    port="${port//[[:space:]]/}"
    health="${health//[[:space:]]/}"
    [[ -z "$folder" || "$folder" == \#* ]] && continue
    [[ -n "$name" && -n "$port" && -n "$health" ]] || die "invalid line in $file for $folder"
    [[ "$port" =~ ^[0-9]+$ ]] || die "invalid port for $folder: $port"
    [[ "$health" == /* ]] || die "health path must start with / for $folder: $health"
    APP_NAME["$folder"]="$name"
    APP_PORT["$folder"]="$port"
    APP_HEALTH["$folder"]="$health"
  done < "$file"
}

load_app_env() {
  local dir="$1"
  local file="$ENV_DIR/$dir.env"
  if [[ -f "$file" ]]; then
    set -a
    # shellcheck disable=SC1090
    . "$file"
    set +a
  fi
}

restart_app() {
  local dir="$1" name="$2"
  load_app_env "$dir"
  if pm2 describe "$name" >/dev/null 2>&1; then
    ( cd "$REPO_DIR/$dir" && pm2 restart "$name" --update-env )
  else
    ( cd "$REPO_DIR/$dir" && pm2 start npm --name "$name" -- start )
  fi
}

health_check() {
  local dir="$1" port="$2" path="$3"
  local url="http://127.0.0.1:${port}${path}"
  local code="" i
  for ((i = 1; i <= HEALTH_RETRIES; i++)); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null || true)"
    if [[ "$code" =~ ^[23][0-9][0-9]$ ]]; then
      log "health check passed for $dir ($url -> $code)"
      return 0
    fi
    sleep "$HEALTH_DELAY"
  done
  log "health check failed for $dir ($url -> ${code:-no response})"
  return 1
}

IN_PROGRESS=0
ROLLED_BACK=0

rollback() {
  trap - ERR
  log "rolling back to $OLD_SHA"
  git reset --hard "$OLD_SHA"
  local dir name port health
  for dir in "${CHANGED_APPS[@]}"; do
    name="${APP_NAME[$dir]:-$dir}"
    if git cat-file -e "$OLD_SHA:$dir/package.json" 2>/dev/null; then
      port="${APP_PORT[$dir]:-}"
      health="${APP_HEALTH[$dir]:-/}"
      log "restoring $dir"
      ( cd "$REPO_DIR/$dir" && npm ci --omit=dev )
      restart_app "$dir" "$name" || log "failed to restart $dir during rollback"
      if [[ -n "$port" ]]; then
        health_check "$dir" "$port" "$health" || log "rollback health check failed for $dir"
      fi
    else
      log "removing newly deployed app $dir"
      pm2 delete "$name" >/dev/null 2>&1 || true
    fi
  done
  log "rollback finished"
}

on_error() {
  local exit_code=$?
  trap - ERR
  if [[ "$IN_PROGRESS" -eq 1 && "$ROLLED_BACK" -eq 0 ]]; then
    ROLLED_BACK=1
    log "deployment failed with exit code $exit_code"
    rollback || log "rollback did not complete cleanly"
  fi
  exit "$exit_code"
}

trap on_error ERR

log "deploying $OLD_SHA -> $NEW_SHA"

if [[ ${#CHANGED_APPS[@]} -eq 0 ]]; then
  git reset --hard "$NEW_SHA"
  log "no app changes; repository updated to $NEW_SHA"
  exit 0
fi

IN_PROGRESS=1
git reset --hard "$NEW_SHA"
load_apps

for dir in "${CHANGED_APPS[@]}"; do
  [[ -n "${APP_NAME[$dir]:-}" ]] || die "no $APPS_FILE_REL entry for changed app: $dir"
done

for dir in "${CHANGED_APPS[@]}"; do
  log "installing production dependencies for $dir"
  ( cd "$REPO_DIR/$dir" && npm ci --omit=dev )
done

for dir in "${CHANGED_APPS[@]}"; do
  name="${APP_NAME[$dir]}"
  port="${APP_PORT[$dir]}"
  health="${APP_HEALTH[$dir]}"
  log "restarting $dir as pm2 process $name"
  restart_app "$dir" "$name"
  health_check "$dir" "$port" "$health"
done

IN_PROGRESS=0
log "deployment complete: $NEW_SHA"
