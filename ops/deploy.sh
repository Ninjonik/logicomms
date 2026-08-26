#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/home/services/logicomms}"
BRANCH="${BRANCH:-main}"

cd "$APP_DIR"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

if command -v bun >/dev/null 2>&1; then
  bun install --frozen-lockfile
  bun run build
else
  HUSKY=0 npm install
  npm run build
fi

systemctl restart logicomms-api.service
