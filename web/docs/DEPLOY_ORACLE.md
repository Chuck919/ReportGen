# Deploy ReportGen on Oracle Cloud (free, shareable URL)

This guide fixes the usual Oracle "weirdness" (no public IP, firewall, wrong shape). **I cannot create the Oracle account for you**, but after you make one VM, deployment is one PowerShell command from your PC.

**Result:** `http://YOUR_PUBLIC_IP` (or `https://yourdomain.com` if you add DNS).

---

## What you need (15–30 min once)

1. Oracle Cloud free account — https://www.oracle.com/cloud/free/
2. SSH key on your PC (PowerShell):
   ```powershell
   ssh-keygen -t rsa -b 4096 -f $env:USERPROFILE\.ssh\oracle_rsa -N '""'
   ```
3. This repo on your machine

---

## Part 1 — Create the VM (Oracle Console)

### 1.1 Region & capacity

- Pick a home region (e.g. **US East Ashburn** or **US West Phoenix**).
- If "Out of capacity" later, try another **Availability Domain** or region.

### 1.2 Launch instance

**Compute → Instances → Create instance**

| Setting | Value |
|---------|--------|
| Name | `reportgen` |
| Image | **Ubuntu 22.04 Minimal** (aarch64) |
| Shape | **Ampere A1 Flex** (Always Free-eligible) |
| OCPUs | **2** |
| Memory (GB) | **12** (fits free tier; OCR needs RAM) |
| Boot volume | 50 GB default is fine |

**Networking (critical — this is why Oracle felt "weird")**

- Create / use a **VCN** with **public subnet**
- **Assign a public IPv4 address** — must be **checked**
- Download or paste your **SSH public key** (`oracle_rsa.pub`)

Click **Create**. Wait until state = **Running**. Copy the **Public IP address**.

### 1.3 Open firewall ports

**Networking → Virtual cloud networks → your VCN → Security Lists → Default**

Add **Ingress** rules:

| Source | Protocol | Port | Description |
|--------|----------|------|-------------|
| 0.0.0.0/0 | TCP | 22 | SSH |
| 0.0.0.0/0 | TCP | 80 | HTTP |
| 0.0.0.0/0 | TCP | 443 | HTTPS |

Save. Without **80**, the shareable link will not load.

### 1.4 Test SSH

```powershell
ssh -i $env:USERPROFILE\.ssh\oracle_rsa ubuntu@YOUR_PUBLIC_IP
```

If this fails, fix networking before deploying the app.

---

## Part 2 — Deploy the app (one command from Windows)

From PowerShell:

```powershell
cd "c:\Users\chang\OneDrive\Desktop\Blue Folder\saas\ReportGen\web"
.\deploy\oracle\push-to-vm.ps1 -VmIp YOUR_PUBLIC_IP -SshKey $env:USERPROFILE\.ssh\oracle_rsa
```

This will:

1. Pack the `web/` folder (no `node_modules`)
2. Upload to `/opt/reportgen` on the VM
3. Install Docker
4. Build and run ReportGen + Caddy reverse proxy

**First build takes 5–10 minutes** on the VM.

Open: **http://YOUR_PUBLIC_IP**

---

## Part 3 — Optional HTTPS with your domain

1. Buy/use a domain; add **A record** → VM public IP (e.g. `reportgen.yourdomain.com`)
2. On the VM, edit `deploy/oracle/Caddyfile`:
   ```
   reportgen.yourdomain.com {
       reverse_proxy app:3000
   }
   ```
3. Restart:
   ```bash
   cd /opt/reportgen && docker compose up -d
   ```

Caddy obtains a free Let''s Encrypt certificate automatically.

---

## Useful commands (on the VM)

```bash
cd /opt/reportgen
docker compose ps
docker compose logs -f app
docker compose up -d --build   # after code update
docker compose down
```

---

## Redeploy after code changes

Run `push-to-vm.ps1` again from your PC, or on the VM:

```bash
cd /opt/reportgen
git pull   # if you use git on the server
docker compose up -d --build
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| SSH timeout | Public IP missing, or port 22 not in security list |
| Browser timeout on IP | Port **80** not open in security list |
| `Out of capacity` | Different AD or region; or shape 1 OCPU / 6 GB RAM |
| OCR slow / OOM | Use 2 OCPU / 12 GB shape; set `FREE_OCR_MODE=fast` in `.env.production` |
| Build fails on VM | `docker compose logs app`; ensure Ubuntu **aarch64** image (not x86) |

---

## Why Oracle instead of Vercel?

| | Vercel Hobby | Oracle VM |
|--|--------------|-----------|
| Cost | Free | Free (Always Free tier) |
| OCR max time | 5 min hard stop | No limit (20 min configured) |
| Shareable URL | Yes | Yes (`http://IP` or domain) |

---

## Files added for this deploy

- `web/Dockerfile` — production image with OCR deps
- `web/docker-compose.yml` — app + Caddy
- `web/deploy/oracle/install-on-vm.sh` — runs on VM (Docker + compose up)
- `web/deploy/oracle/push-to-vm.ps1` — upload from Windows
- `web/deploy/oracle/.env.production.example` — VPS env template
- `web/deploy/oracle/Caddyfile` — reverse proxy
- `web/AGENT_HANDOFF_ORACLE_DEPLOY.md` — **agent copy-paste deploy runbook**