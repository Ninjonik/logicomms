#!/usr/bin/env bash
set -euo pipefail

backup="/root/nginx-sites-enabled-backup-2026-08-25-logicomms.tgz"
targets_file="$(mktemp)"
backup_dir="$(mktemp -d)"
backup_tar_dir="$(dirname "$backup")"
backup_name="$(basename "$backup")"
trap 'rm -f "$targets_file"' EXIT

for enabled in /etc/nginx/sites-enabled/*; do
  readlink -f "$enabled"
done | sort -u > "$targets_file"

while IFS= read -r file; do
  cp -a "$file" "$backup_dir/"
done < "$targets_file"

tar -C "$backup_dir" -czf "$backup_tar_dir/$backup_name" .

while IFS= read -r file; do
  if [ "$file" = "/etc/nginx/sites-available/mesh-tls.conf" ]; then
    continue
  fi

  perl -0pi -e '
    s/listen 443 ssl default_server;/listen 127.0.0.1:4443 ssl default_server;/g;
    s/listen 443 ssl;/listen 127.0.0.1:4443 ssl;/g;
    s/listen \[::\]:443 ssl default_server;/listen [::1]:4443 ssl default_server;/g;
    s/listen \[::\]:443 ssl;/listen [::1]:4443 ssl;/g;
  ' "$file"
done < "$targets_file"

ln -sfn /etc/nginx/streams-available/tls-sni-router.conf /etc/nginx/streams-enabled/tls-sni-router.conf
ufw allow 443/udp

cd /docker/livekitlogicomms
docker compose up -d --force-recreate

nginx -t
systemctl reload nginx
