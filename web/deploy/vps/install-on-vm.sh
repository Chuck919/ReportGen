#!/usr/bin/env bash
# Run on VPS after push-to-vm extracts tarball into /opt/reportgen
set -euo pipefail

cd "$(dirname "$0")/../.."
APP_DIR="$(pwd)"
ENV_TEMPLATE="${ENV_TEMPLATE:-deploy/vps/.env.production.example}"
OPEN_UFW="${OPEN_UFW:-1}"

echo "==> ReportGen install in ${APP_DIR}"

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "${USER}" || true
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "==> Installing Docker Compose plugin..."
  sudo apt-get update -qq
  sudo apt-get install -y docker-compose-plugin
fi

if [ "${OPEN_UFW}" = "1" ] && command -v ufw >/dev/null 2>&1; then
  echo "==> Opening firewall (22, 80, 443)..."
  sudo ufw allow 22/tcp || true
  sudo ufw allow 80/tcp || true
  sudo ufw allow 443/tcp || true
  sudo ufw --force enable || true
fi

if [ ! -f .env.production ]; then
  echo "==> Creating .env.production from ${ENV_TEMPLATE}..."
  cp "${ENV_TEMPLATE}" .env.production
fi

echo "==> Building and starting containers (first build: 5–10 min)..."
docker compose build app
docker compose up -d

echo ""
echo "==> Status:"
docker compose ps
echo ""
echo "App: http://$(curl -fsS ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')/tax"
