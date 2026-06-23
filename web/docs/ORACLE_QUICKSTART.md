# Oracle Cloud — 15-minute quickstart (£0/month)

Use this before paying for Hetzner. Same Docker deploy as Hetzner.

## 1. Create account + VM

1. https://www.oracle.com/cloud/free/ — sign up (card verification only, not charged for Always Free).
2. **Compute → Instances → Create instance**

| Field | Value |
|-------|--------|
| Name | `reportgen` |
| Image | **Ubuntu 22.04** (aarch64) |
| Shape | **Ampere A1 Flex** — **2 OCPU**, **12 GB RAM** |
| Boot volume | 50 GB |
| Networking | Public IPv4 **checked** |
| SSH key | Paste your public key (see below) |

3. **Networking → Security list → Ingress** — add TCP **22, 80, 443** from `0.0.0.0/0`.

4. Copy **Public IP** when status = Running.

### SSH public key (generated on your PC)

Run if you need it again:

```powershell
Get-Content $env:USERPROFILE\.ssh\oracle_rsa.pub
```

## 2. Deploy from Windows

```powershell
cd "c:\Users\chang\OneDrive\Desktop\Blue Folder\saas\ReportGen\web"

$env:ORACLE_VM_IP = "YOUR_PUBLIC_IP"
.\deploy\oracle\push-to-vm.ps1 -VmIp $env:ORACLE_VM_IP -SshKey $env:USERPROFILE\.ssh\oracle_rsa
```

Open: **http://YOUR_PUBLIC_IP/tax**

## 3. If Oracle fails

- **Out of capacity** — try another Availability Domain or region (Ashburn, Phoenix, Frankfurt).
- **Can't get account** — use Hetzner **Cloud Server** (see `DEPLOY_HETZNER.md`), **not** Web Hosting.
