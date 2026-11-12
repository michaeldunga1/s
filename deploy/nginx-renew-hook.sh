#!/bin/sh
set -eu

systemctl reload nginx
printf '%s nginx reloaded after certificate renewal\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> /var/log/nginx/renewal-hooks.log
