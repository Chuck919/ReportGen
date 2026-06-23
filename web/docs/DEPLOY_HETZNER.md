# Deploy ReportGen on Hetzner Cloud

Use this instead of Vercel when you hit Hobby CPU limits. Same Docker stack as Oracle — **no 300s OCR cap**, local **fast / balanced / thorough** modes, `workers=1`.

**Result:** `http://YOUR_SERVER_IP/tax`

> **Important:** Use **[Hetzner Cloud](https://console.hetzner.cloud)** → **Add Server** (a VPS).  
> Do **not** use **Hetzner Web Hosting** (shared PHP/cPanel) — it cannot run Docker or long OCR jobs.

---

## 1. Create a Hetzner Cloud server

1. Go to **https://console.hetzner.com** (or console.hetzner.cloud) — **Cloud**, not the web-hosting product.
2. **Add Server**
   - Location: nearest to you (e.g. Falkenstein, Helsinki, Ashburn)
   - Image: **Ubuntu 24.04**
   - Type: **CX22** (2 shared vCPU, 4 GB RAM, ~€4.49/mo) — enough for OCR with `workers=1`  
     Or **CPX22** if you want dedicated vCPU (~€8/mo; not required for this app).
   - Networking: **IPv4** enabled
   - SSH key: paste your public key (below)
3. Optional: attach a **Firewall** with inbound TCP **22, 80, 443** (install script also opens `ufw`)

Copy the **IPv4 address**.

### SSH key (Windows, one-time)

```powershell
ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\hetzner_rsa -N '""'
Get-Content $env:USERPROFILE\.ssh\hetzner_rsa.pub
```

Paste the `.pub` line into Hetzner when creating the server.

---

## 2. Deploy from your PC (one command)

```powershell
cd "c:\Users\chang\OneDrive\Desktop\Blue Folder\saas\ReportGen\web"

.\deploy\hetzner\push-to-vm.ps1 `
  -VmIp YOUR_HETZNER_IP `
  -SshKey $env:USERPROFILE\.ssh\hetzner_rsa
```

First build: **5–10 minutes** on the VM.

Open: **http://YOUR_HETZNER_IP/tax**

---

## 3. Verify OCR

```powershell
cd web
npm run benchmark:prod-cold -- http://YOUR_HETZNER_IP
```

Use modes `fast`, `balanced`, `thorough` in the UI (not `vercel-*`). Balanced should reach **100%** primary on KCF returns in ~3–4 min.

---

## 4. HTTPS (optional)

1. DNS **A record** → server IP (e.g. `reportgen.yourdomain.com`)
2. Edit `deploy/vps/Caddyfile` on the server:

```
reportgen.yourdomain.com {
    reverse_proxy app:3000
}
```

3. `cd /opt/reportgen && docker compose up -d`

---

## Redeploy after code changes

```powershell
.\deploy\hetzner\push-to-vm.ps1 -VmIp YOUR_HETZNER_IP -SshKey $env:USERPROFILE\.ssh\hetzner_rsa
```

Or on the server:

```bash
cd /opt/reportgen
docker compose up -d --build
```

---

## Hetzner vs Vercel

| | Vercel Hobby | Hetzner CX22 |
|--|--------------|--------------|
| OCR time limit | 300s (CPU quota) | 20 min configured |
| Local thorough (2× merge) | No | Yes |
| Monthly cost | Free (capped) | ~€4.50 + VAT (~£4–5) |

Pause or delete the Vercel project in the dashboard to avoid further CPU billing.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| SSH refused | Hetzner firewall + `ufw`; port 22 open |
| Browser timeout | Port **80** open in Hetzner firewall |
| UI shows vercel-* modes | Rebuild without `VERCEL=1`; check `.env.production` |
| OCR OOM | Use CPX32 (8 GB) or set `FREE_OCR_WORKERS=1` |
