#!/usr/bin/env bash
set -Eeuo pipefail
umask 022

usage() {
  cat <<'EOF'
Usage: add-site.sh <subdomain> <app-folder> <port>

Example:
  sudo /home/deploy/s/deploy/add-site.sh app.example.com my-app 3001

Required for first-time certificate issuance:
  LETSENCRYPT_EMAIL in the environment or in /etc/deploy/deploy.env

Optional:
  SERVER_IP=1.2.3.4        Skip public-IP auto-detection
  SKIP_DNS_CHECK=1         Bypass the DNS safety check (not recommended)
  APP_ROOT=/path           Root containing app folders (default: repo root)
  WEBROOT=/var/www/certbot ACME webroot (default)
EOF
}

if [[ $# -ne 3 ]]; then
  usage
  exit 2
fi

DOMAIN="${1,,}"
DOMAIN="${DOMAIN%.}"
APP_FOLDER="$2"
PORT="$3"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  exec sudo -E -- "$0" "$@"
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
TEMPLATE="$SCRIPT_DIR/templates/nginx-app.conf"
ENV_FILE="${DEPLOY_ENV_FILE:-/etc/deploy/deploy.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

WEBROOT="${WEBROOT:-/var/www/certbot}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-}"
SERVER_IP="${SERVER_IP:-}"
SKIP_DNS_CHECK="${SKIP_DNS_CHECK:-0}"
APP_ROOT="${APP_ROOT:-$REPO_DIR}"

NGINX_CONF="/etc/nginx/sites-available/$DOMAIN.conf"
NGINX_ENABLED="/etc/nginx/sites-enabled/$DOMAIN.conf"
CERT_DIR="/etc/letsencrypt/live/$DOMAIN"

if [[ ! "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]; then
  echo "ERROR: invalid subdomain: $DOMAIN" >&2
  exit 2
fi
if [[ ${#DOMAIN} -gt 253 ]]; then
  echo "ERROR: subdomain is longer than 253 characters" >&2
  exit 2
fi
if [[ ! "$APP_FOLDER" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "ERROR: app folder must be a single folder name" >&2
  exit 2
fi
if [[ ! "$PORT" =~ ^[0-9]+$ ]] || ((PORT < 1 || PORT > 65535)); then
  echo "ERROR: invalid port: $PORT" >&2
  exit 2
fi

APP_DIR="$APP_ROOT/$APP_FOLDER"
if [[ ! -d "$APP_DIR" ]]; then
  echo "ERROR: app folder not found: $APP_DIR" >&2
  exit 1
fi
if [[ ! -f "$APP_DIR/package.json" ]]; then
  echo "ERROR: missing package.json in $APP_DIR" >&2
  exit 1
fi
if [[ ! -f "$TEMPLATE" ]]; then
  echo "ERROR: nginx template not found: $TEMPLATE" >&2
  exit 1
fi

for cmd in nginx certbot openssl dig curl systemctl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: required command not found: $cmd" >&2
    exit 1
  fi
done

cert_exists() {
  [[ -s "$CERT_DIR/fullchain.pem" && -s "$CERT_DIR/privkey.pem" ]]
}

detect_server_ip() {
  if [[ -n "$SERVER_IP" ]]; then
    printf '%s\n' "$SERVER_IP"
    return 0
  fi
  local ip=""
  ip="$(curl -4fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
  if [[ -z "$ip" ]]; then
    ip="$(dig +short myip.opendns.com @resolver1.opendns.com 2>/dev/null | head -n1 || true)"
  fi
  printf '%s\n' "$ip"
}

check_dns() {
  if [[ "$SKIP_DNS_CHECK" == "1" ]]; then
    echo "WARNING: DNS check skipped because SKIP_DNS_CHECK=1" >&2
    return 0
  fi
  local server_ip
  server_ip="$(detect_server_ip)"
  if [[ -z "$server_ip" ]]; then
    echo "ERROR: could not determine this server's public IPv4; set SERVER_IP explicitly" >&2
    return 1
  fi
  local -a ips=()
  mapfile -t ips < <(dig +short A "$DOMAIN" @1.1.1.1 | grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}$' | sort -u)
  if [[ ${#ips[@]} -eq 0 ]]; then
    echo "ERROR: no A record for $DOMAIN yet; point it to $server_ip and wait for DNS propagation" >&2
    return 1
  fi
  local ip
  for ip in "${ips[@]}"; do
    if [[ "$ip" == "$server_ip" ]]; then
      echo "DNS OK: $DOMAIN -> $ip"
      return 0
    fi
  done
  echo "ERROR: $DOMAIN resolves to ${ips[*]}, not this server ($server_ip); refusing to provision" >&2
  return 1
}

render_bootstrap() {
  cat <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    location /.well-known/acme-challenge/ {
        root $WEBROOT;
        default_type text/plain;
        try_files \$uri =404;
    }

    location / {
        return 503;
    }
}
EOF
}

render_full() {
  sed -e "s|{{DOMAIN}}|$DOMAIN|g" -e "s|{{PORT}}|$PORT|g" "$TEMPLATE"
}

apply_config() {
  local src="$1"
  local backup="" had_previous=0 had_symlink=0 old_target=""

  if [[ -L "$NGINX_ENABLED" ]]; then
    had_symlink=1
    old_target="$(readlink "$NGINX_ENABLED" || true)"
  fi

  if [[ -f "$NGINX_CONF" ]] && cmp -s "$src" "$NGINX_CONF"; then
    if [[ -L "$NGINX_ENABLED" ]] && [[ "$(readlink -f "$NGINX_ENABLED")" == "$(readlink -f "$NGINX_CONF")" ]]; then
      return 1
    fi
    ln -sfn "$NGINX_CONF" "$NGINX_ENABLED"
    if ! nginx -t; then
      if [[ "$had_symlink" -eq 1 && -n "$old_target" ]]; then
        ln -sfn "$old_target" "$NGINX_ENABLED"
      else
        rm -f "$NGINX_ENABLED"
      fi
      echo "ERROR: nginx -t failed; previous enabled-site link restored" >&2
      return 2
    fi
    systemctl reload nginx
    return 0
  fi

  if [[ -f "$NGINX_CONF" ]]; then
    backup="$(mktemp)"
    cp -p "$NGINX_CONF" "$backup"
    had_previous=1
  fi

  install -m 0644 "$src" "$NGINX_CONF"
  ln -sfn "$NGINX_CONF" "$NGINX_ENABLED"

  if ! nginx -t; then
    if [[ "$had_previous" -eq 1 ]]; then
      cp -p "$backup" "$NGINX_CONF"
    else
      rm -f "$NGINX_CONF"
    fi
    if [[ "$had_symlink" -eq 1 && -n "$old_target" ]]; then
      ln -sfn "$old_target" "$NGINX_ENABLED"
    else
      rm -f "$NGINX_ENABLED"
    fi
    [[ -n "$backup" ]] && rm -f "$backup"
    echo "ERROR: nginx -t failed; previous configuration restored" >&2
    return 2
  fi

  [[ -n "$backup" ]] && rm -f "$backup"
  systemctl reload nginx
  return 0
}

check_dns

install -d -m 0755 "$WEBROOT/.well-known/acme-challenge"

TMP_CONFIG="$(mktemp)"
trap 'rm -f "$TMP_CONFIG"' EXIT

if ! cert_exists; then
  if [[ -z "$LETSENCRYPT_EMAIL" ]]; then
    echo "ERROR: LETSENCRYPT_EMAIL is required to request the first certificate" >&2
    exit 1
  fi
  echo "Certificate not found; creating temporary HTTP config for ACME"
  render_bootstrap > "$TMP_CONFIG"
  rc=0
  apply_config "$TMP_CONFIG" || rc=$?
  if [[ "$rc" -eq 2 ]]; then
    echo "ERROR: could not install bootstrap nginx config" >&2
    exit 1
  fi
  if ! certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" --cert-name "$DOMAIN" \
    --non-interactive --agree-tos --email "$LETSENCRYPT_EMAIL" --keep-until-expiring; then
    echo "ERROR: certbot failed; removing temporary config" >&2
    rm -f "$NGINX_ENABLED" "$NGINX_CONF"
    nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
    exit 1
  fi
  if ! cert_exists; then
    echo "ERROR: certbot reported success but certificate files are missing" >&2
    exit 1
  fi
fi

render_full > "$TMP_CONFIG"
rc=0
apply_config "$TMP_CONFIG" || rc=$?
case "$rc" in
  0)
    echo "Site $DOMAIN provisioned or updated on port $PORT"
    ;;
  1)
    echo "Site $DOMAIN is already up to date; no changes made"
    ;;
  *)
    echo "ERROR: failed to apply nginx configuration for $DOMAIN" >&2
    exit 1
    ;;
esac
