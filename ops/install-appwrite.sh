#!/usr/bin/env bash
set -euo pipefail

install_dir=/home/appwrite
version=1.9.6

mkdir -p "$install_dir"
curl -fsSL "https://raw.githubusercontent.com/appwrite/appwrite/${version}/docker-compose.yml" -o "$install_dir/docker-compose.yml"
curl -fsSL "https://raw.githubusercontent.com/appwrite/appwrite/${version}/.env" -o "$install_dir/.env"
curl -fsSL "https://raw.githubusercontent.com/appwrite/appwrite/${version}/mongo-init.js" -o "$install_dir/mongo-init.js"
curl -fsSL "https://raw.githubusercontent.com/appwrite/appwrite/${version}/mongo-entrypoint.sh" -o "$install_dir/mongo-entrypoint.sh"
# Traefik is localhost-only and must preserve the HTTPS status set by host Nginx.
sed -i '/--entrypoints.appwrite_web.address=:80/a\      - --entrypoints.appwrite_web.forwardedHeaders.insecure=true' "$install_dir/docker-compose.yml"

openssl_key=$(openssl rand -hex 32)
executor_secret=$(openssl rand -hex 32)
db_password=$(openssl rand -hex 24)
db_root_password=$(openssl rand -hex 24)

set_env() {
  sed -i "s|^${1}=.*|${1}=${2}|" "$install_dir/.env"
}

set_env _APP_ENV production
set_env _APP_VERSION "$version"
set_env _APP_OPENSSL_KEY_V1 "$openssl_key"
set_env _APP_EXECUTOR_SECRET "$executor_secret"
set_env _APP_DB_PASS "$db_password"
set_env _APP_DB_ROOT_PASS "$db_root_password"
set_env _APP_DOMAIN appwrite.igportals.eu
set_env _APP_HTTP_PORT 127.0.0.1:9080
set_env _APP_HTTPS_PORT 127.0.0.1:9443
set_env _APP_DOMAIN_FUNCTIONS functions.appwrite.igportals.eu
set_env _APP_DOMAIN_SITES sites.appwrite.igportals.eu
set_env _APP_DOMAIN_TARGET_A 194.163.171.40
set_env _APP_DNS 1.1.1.1
set_env _APP_TRUSTED_HEADERS x-forwarded-for,x-forwarded-proto,x-forwarded-host,x-forwarded-port
set_env _APP_OPTIONS_FORCE_HTTPS enabled
set_env _APP_OPTIONS_ROUTER_FORCE_HTTPS enabled
set_env _APP_OPTIONS_ROUTER_PROTECTION enabled
set_env _APP_OPTIONS_ABUSE enabled
set_env _APP_SYSTEM_EMAIL_NAME "IG Portals"
set_env _APP_SYSTEM_EMAIL_ADDRESS noreply@igportals.eu
set_env _APP_SYSTEM_TEAM_EMAIL team@igportals.eu
set_env _APP_EMAIL_SECURITY security@igportals.eu
set_env _APP_EMAIL_CERTIFICATES certificates@igportals.eu
set_env _APP_FUNCTIONS_RUNTIMES node-22
set_env _APP_SITES_RUNTIMES static-1,node-22

cd "$install_dir"
docker compose config --quiet
docker compose up -d --remove-orphans
