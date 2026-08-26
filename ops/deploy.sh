#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/home/services/logicomms}"
BRANCH="${BRANCH:-main}"
RELEASE_DIR="${RELEASE_DIR:-/var/www/logicomms-releases}"
export PATH="/root/.cargo/bin:/root/.bun/bin:$PATH"

cd "$APP_DIR"
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"
bun install --frozen-lockfile

BUILD_NUMBER="$(git rev-list --count HEAD)"
VERSION="0.1.${BUILD_NUMBER}"
trap 'git checkout -- package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json' EXIT
node -e "const fs=require('fs');const p=require('./package.json');p.version='$VERSION';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\\n')"
sed -i -E "s/^version = \"[^\"]+\"/version = \"$VERSION\"/" src-tauri/Cargo.toml
sed -i -E "s/\"version\": \"[^\"]+\"/\"version\": \"$VERSION\"/" src-tauri/tauri.conf.json

# Invoke the Tauri CLI directly: `bun run … -- …` forwards the flags to Cargo
# after the runner has been selected, rather than to Tauri itself.
./node_modules/.bin/tauri build --bundles nsis --runner cargo-xwin --target x86_64-pc-windows-msvc
INSTALLER="$(find src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis -type f -name '*.exe' -print -quit)"
install -d -m 755 "$RELEASE_DIR"
install -m 644 "$INSTALLER" "$RELEASE_DIR/LogiComms-${VERSION}-x64-setup.exe"
printf '%s\n' "<html><body><h1>LogiComms releases</h1><p>Latest: ${VERSION}</p><p><a href=\"LogiComms-${VERSION}-x64-setup.exe\">Download Windows installer</a></p></body></html>" > "$RELEASE_DIR/index.html"
printf '%s\n' "${VERSION}" > "$RELEASE_DIR/version.txt"
