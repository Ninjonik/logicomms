#!/usr/bin/env bash
set -euo pipefail
cd /home/appwrite
grep -q 'forwardedHeaders.insecure=true' docker-compose.yml || sed -i '/--entrypoints.appwrite_web.address=:80/a\      - --entrypoints.appwrite_web.forwardedHeaders.insecure=true' docker-compose.yml
grep -q '^_APP_HTTP_PORT=' .env && sed -i 's|^_APP_HTTP_PORT=.*|_APP_HTTP_PORT=127.0.0.1:9080|' .env || printf '\n_APP_HTTP_PORT=127.0.0.1:9080\n' >> .env
grep -q '^_APP_HTTPS_PORT=' .env && sed -i 's|^_APP_HTTPS_PORT=.*|_APP_HTTPS_PORT=127.0.0.1:9443|' .env || printf '_APP_HTTPS_PORT=127.0.0.1:9443\n' >> .env
grep -q '^_APP_VERSION=' .env && sed -i 's|^_APP_VERSION=.*|_APP_VERSION=1.9.6|' .env || printf '_APP_VERSION=1.9.6\n' >> .env
grep -q '^_APP_TRUSTED_HEADERS=' .env && sed -i 's|^_APP_TRUSTED_HEADERS=.*|_APP_TRUSTED_HEADERS=x-forwarded-for,x-forwarded-proto,x-forwarded-host,x-forwarded-port|' .env
docker compose up -d
