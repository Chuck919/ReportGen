# ReportGen VPS deploy (OVH + DuckDNS + HTTPS)

Production stack: **Docker Compose** runs Next.js (`next build` + `next start`) behind **Caddy** with automatic Let's Encrypt TLS.

## Server

| Item | Value |
|------|--------|
| Provider | OVH VPS-1 (Ubuntu 24.04) |
| App path | `/opt/reportgen-src/web` |
| Public URL | https://reportgen.duckdns.org/tax |
| Raw IP (HTTP only) | http://135.148.42.88/tax |

## First-time VPS setup

1. SSH as `ubuntu@YOUR_IP` (key from OVH or `~/.ssh/ovh_ed25519`).
2. Clone the repo (public):

```bash
sudo mkdir -p /opt/reportgen-src && sudo chown -R ubuntu:ubuntu /opt/reportgen-src
git clone -b master https://github.com/Chuck919/ReportGen.git /opt/reportgen-src
cd /opt/reportgen-src/web
cp deploy/vps/.env.production.example .env.production
# edit .env.production if using Supabase
chmod +x deploy/vps/install-on-vm.sh
bash deploy/vps/install-on-vm.sh
```

3. Optional **2GB swap** (OCR OOM insurance):

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## DuckDNS + HTTPS

1. At [duckdns.org](https://www.duckdns.org), point `reportgen` → your VPS IPv4.
2. Caddy config lives in `deploy/vps/Caddyfile`:

```
reportgen.duckdns.org {
    reverse_proxy app:3000
}

http://135.148.42.88 {
    reverse_proxy app:3000
}
```

3. After editing Caddyfile on the server:

```bash
cd /opt/reportgen-src/web
sudo docker compose restart caddy
```

Caddy obtains and renews the certificate automatically.

## Redeploy after `git push`

**On the VPS (preferred):**

```bash
cd /opt/reportgen-src && git pull origin master
cd web && sudo docker compose up -d --build
```

**From Windows (tar upload):**

```powershell
cd web
.\deploy\vps\push-to-vm.ps1 -VmIp 135.148.42.88 -SshKey "$env:USERPROFILE\.ssh\ovh_ed25519"
```

## Useful commands

```bash
cd /opt/reportgen-src/web
sudo docker compose ps
sudo docker compose logs -f app
sudo docker compose restart
```

## Production notes

- Runs `next start`, not `next dev`.
- `FREE_OCR_WORKERS=2` on the 2-vCPU VPS (set in `docker-compose.yml` + `.env.production`).
- Copy/paste works on HTTPS via the browser clipboard API; HTTP IP uses a fallback in `CopyButton`.
- One PDF per browser session in the Tax UI — use **Clear all** before uploading another return.

## API smoke test (all benchmark clients)

```bash
cd web
UI_BENCH_LIVE=1 UI_BENCH_LIVE_BATCH=1 BASE_URL=https://reportgen.duckdns.org \
  npx tsx scripts/benchmark-ui-session.ts balanced
```
