#!/usr/bin/env bash
set -Eeuo pipefail

THRESHOLD_DAYS="${THRESHOLD_DAYS:-14}"
ALERT_EMAIL="${ALERT_EMAIL:-}"
LOG_FILE="${LOG_FILE:-/var/log/deploy-cert-check.log}"
ENV_FILE="${DEPLOY_ENV_FILE:-/etc/deploy/deploy.env}"
DRY_RUN=0

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_FILE" >&2
}

alert() {
  local subject="$1" body="$2"
  log "ALERT: $subject - $body"
  if [[ -n "$ALERT_EMAIL" ]] && command -v mail >/dev/null 2>&1; then
    printf '%s\n' "$body" | mail -s "$subject" "$ALERT_EMAIL" || log "mail command failed"
  fi
}

FAILED=0

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "running certbot renew --dry-run"
  if certbot renew --dry-run --non-interactive; then
    log "certbot dry-run succeeded"
  else
    alert "Certbot dry-run failed on $(hostname)" "certbot renew --dry-run failed. Check /var/log/letsencrypt/letsencrypt.log"
    FAILED=1
  fi
fi

shopt -s nullglob
for cert in /etc/letsencrypt/live/*/fullchain.pem; do
  domain="$(basename "$(dirname "$cert")")"
  if ! expiry_date="$(openssl x509 -enddate -noout -in "$cert" | cut -d= -f2)"; then
    alert "Certificate read failed for $domain" "Could not read $cert"
    FAILED=1
    continue
  fi
  if ! expiry_epoch="$(date -d "$expiry_date" +%s)"; then
    alert "Certificate date parse failed for $domain" "Could not parse expiry date: $expiry_date"
    FAILED=1
    continue
  fi
  now_epoch="$(date +%s)"
  days_left=$(( (expiry_epoch - now_epoch) / 86400 ))
  if (( days_left < THRESHOLD_DAYS )); then
    alert "Certificate for $domain expires in $days_left days" "Certificate $cert expires on $expiry_date (less than ${THRESHOLD_DAYS} days)."
    FAILED=1
  else
    log "certificate for $domain has $days_left days left"
  fi
done

if [[ "$FAILED" -ne 0 ]]; then
  exit 1
fi
