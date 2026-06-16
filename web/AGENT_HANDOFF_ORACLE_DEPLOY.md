# Agent Handoff — Automated Oracle Cloud Deploy

**Copy this entire doc into the next agent session.**

Also read: `docs/DEPLOY_ORACLE.md` (human setup), `AGENT_HANDOFF_CHANGES_SUMMARY.md`, `Dockerfile`, `docker-compose.yml`

---

## Mission

Deploy ReportGen to an **Oracle Cloud Always Free VM** so OCR uses **local `fast` / `balanced` / `thorough`** presets with **no 300s Vercel limit** (~20 min timeout). Provide a **shareable HTTP URL** for `/tax` uploads.

The agent should be able to deploy **without manual steps** after the user supplies VM IP + SSH key once.

---

## Prerequisites (user must do once)

1. **Oracle Cloud free account** — https://www.oracle.com/cloud/free/
2. **VM created** — Ubuntu 22.04 **aarch64**, Ampere A1 **2 OCPU / 12 GB RAM**, **public IPv4**, ports **22/80/443** open in security list  
   (Full steps: `docs/DEPLOY_ORACLE.md` Part 1)
3. **SSH key** on the agent’s machine:

   ```powershell
   ssh-keygen -t rsa -b 4096 -f $env:USERPROFILE\.ssh\oracle_rsa -N '""'
   ```

4. **Secrets the agent needs** (env vars or ask user):

   | Variable | Example | Required |
   |----------|---------|----------|
   | `ORACLE_VM_IP` | `123.45.67.89` | Yes |
   | `ORACLE_SSH_KEY` | `$env:USERPROFILE\.ssh\oracle_rsa` | Yes |
   | `ORACLE_SSH_USER` | `ubuntu` | Default `ubuntu` |

---

## One-command deploy (agent runs from Windows)

```powershell
cd "c:\Users\chang\OneDrive\Desktop\Blue Folder\saas\ReportGen\web"

$VmIp = $env:ORACLE_VM_IP
$SshKey = $env:ORACLE_SSH_KEY
if (-not $VmIp) { throw "Set ORACLE_VM_IP" }
if (-not $SshKey) { $SshKey = "$env:USERPROFILE\.ssh\oracle_rsa" }

.\deploy\oracle\push-to-vm.ps1 -VmIp $VmIp -SshKey $SshKey
```

**First deploy:** 5–10 min (Docker install + `npm ci` + `next build` on VM).  
**Output URL:** `http://ORACLE_VM_IP`

---

## What the deploy script does

`deploy/oracle/push-to-vm.ps1`:

1. Tarballs `web/` (excludes `node_modules`, `.next`, `.git`)
2. `scp` to `/opt/reportgen` on VM
3. Runs `deploy/oracle/install-on-vm.sh` which:
   - Installs Docker + Compose if missing
   - Creates `.env.production` from `deploy/oracle/.env.production.example` if absent
   - `docker compose build app && docker compose up -d`

**Stack:** Next.js app + Caddy reverse proxy (`docker-compose.yml`).

---

## Environment on Oracle (critical)

File: `.env.production` on VM (from `deploy/oracle/.env.production.example`)

```env
# Do NOT set VERCEL=1 or NEXT_PUBLIC_VERCEL=1
FREE_OCR_MODE=balanced
FREE_OCR_WORKERS=1
FREE_OCR_TIMEOUT_MS=1200000
```

- **`NEXT_PUBLIC_VERCEL` must be unset** at Docker **build** time → UI shows **Fast / Balanced / Thorough** (local modes), not `vercel-*`.
- Dockerfile sets `FREE_OCR_TIMEOUT_MS=1200000` (20 min).
- `next.config.mjs` bakes `NEXT_PUBLIC_VERCEL` from `process.env.VERCEL` at build — **do not pass `VERCEL=1` during `docker compose build`**.

---

## Agent deploy checklist

```
[ ] User provided ORACLE_VM_IP and SSH works:
      ssh -i $ORACLE_SSH_KEY ubuntu@$ORACLE_VM_IP "echo ok"
[ ] Run push-to-vm.ps1 from web/
[ ] Wait for build; check: ssh ... 'cd /opt/reportgen && docker compose ps'
[ ] HTTP smoke: curl -s -o /dev/null -w "%{http_code}" http://ORACLE_VM_IP/tax  → 200
[ ] OCR smoke: upload 2024 PDF on /tax with Balanced mode; confirm completes without 422 timeout
[ ] Optional: run prod-pipeline against Oracle URL (see below)
```

---

## Verify OCR on Oracle (HTTP benchmark)

After deploy, from dev machine:

```powershell
cd web
npm run benchmark:prod-cold -- http://ORACLE_VM_IP
```

**Expected:** Uses local modes if UI/API receives `fast`/`balanced`/`thorough`.  
Note: `benchmark-prod-cold.ts` `PROD_CANDIDATES` currently tests `vercel-*` presets — **agent should add a second candidate set** or env flag for VPS:

```typescript
// scripts/lib/prod-pipeline.ts — suggested addition
export const VPS_CANDIDATES = [
  { id: "fast", kind: "single", ocrMode: "fast" },
  { id: "balanced", kind: "single", ocrMode: "balanced" },
  { id: "thorough", kind: "single", ocrMode: "thorough" },
];
```

Run with `OCR_DEPLOY=vps` or separate script `benchmark-vps-cold.ts`.

Manual API test:

```powershell
curl -X POST "http://ORACLE_VM_IP/api/parse-tax-return?format=json" `
  -F "file=@../Documents/KC Fudge LLC_2024 Business Tax Return_2024-12-31.pdf" `
  -F "ocrMode=thorough"
```

Should **not** return 422 timeout on 75-page PDF.

---

## Redeploy after code changes

Same command — re-run `push-to-vm.ps1`. Or on VM:

```bash
ssh -i ~/.ssh/oracle_rsa ubuntu@ORACLE_VM_IP
cd /opt/reportgen
docker compose up -d --build
docker compose logs -f app
```

---

## Troubleshooting (agent)

| Symptom | Fix |
|---------|-----|
| SSH timeout | Public IP / port 22 in Oracle security list |
| Browser timeout | Port **80** ingress rule |
| UI shows `vercel-fast` modes | Rebuild without `VERCEL=1`; check `NEXT_PUBLIC_VERCEL` at build |
| OCR OOM | Set `FREE_OCR_WORKERS=1` in `.env.production`; restart compose |
| Build fails on ARM | Use **aarch64** Ubuntu image, not x86 |
| `install-on-vm.sh` not found | Ensure `deploy/oracle/install-on-vm.sh` exists in tarball (added 2026-06-15) |
| Slow OCR | Expected 3–8 min on 75 pg for local modes |

---

## Hetzner (same stack)

No Hetzner-specific scripts yet. Use **identical** flow:

1. Ubuntu 22.04/24.04 VM, 2+ vCPU, 4+ GB RAM
2. Install Docker
3. Copy `web/` to `/opt/reportgen`
4. `docker compose up -d --build`
5. Open ports 80/443

Agent can parameterize `push-to-vm.ps1` with `-VmIp` for any SSH host.

---

## Files reference

| File | Role |
|------|------|
| `deploy/oracle/push-to-vm.ps1` | Windows → VM upload + install trigger |
| `deploy/oracle/install-on-vm.sh` | VM-side Docker install + compose up |
| `deploy/oracle/.env.production.example` | VPS env template |
| `deploy/oracle/Caddyfile` | `:80 { reverse_proxy app:3000 }` |
| `Dockerfile` | Node 20 + OCR deps, `npm run build` |
| `docker-compose.yml` | app + Caddy |
| `docs/DEPLOY_ORACLE.md` | Human-readable Oracle console steps |

---

## Optional: HTTPS

User adds DNS A record → VM IP, edits `Caddyfile`:

```
reportgen.example.com {
    reverse_proxy app:3000
}
```

Redeploy compose; Caddy obtains Let's Encrypt cert.

---

## Success criteria

- [ ] `http://ORACLE_VM_IP/tax` loads with **Fast / Balanced / Thorough** (not vercel-*)
- [ ] 2024 75-page PDF completes in **Thorough** without timeout
- [ ] Primary accuracy **≥ 95%** on 2024 (ideally 100%; see `AGENT_HANDOFF_LOCAL_OCR_TESTING.md` for variance)
- [ ] Redeploy is one command (`push-to-vm.ps1`)
