# Upload web/ to OVH VPS and rebuild (run from web/)
#   .\deploy\vps\push-to-vm.ps1 -VmIp 135.148.42.88
#   .\deploy\vps\push-to-vm.ps1 -VmIp 135.148.42.88 -SshKey $env:USERPROFILE\.ssh\ovh_ed25519
param(
  [Parameter(Mandatory = $true)][string]$VmIp,
  [string]$SshKey = "$env:USERPROFILE\.ssh\ovh_ed25519",
  [string]$User = "ubuntu",
  [string]$RemoteDir = "/opt/reportgen-src/web"
)

$ErrorActionPreference = "Stop"
$WebRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if (-not (Test-Path "$WebRoot\package.json")) { throw "Web root not found: $WebRoot" }
if (-not (Test-Path $SshKey)) { throw "SSH key not found: $SshKey" }

$Tar = Join-Path $env:TEMP "reportgen-web.tar.gz"
Write-Host "Packing $WebRoot (excluding node_modules, .next)..."
if (Test-Path $Tar) { Remove-Item $Tar -Force }

Push-Location $WebRoot
tar --exclude=node_modules --exclude=.next --exclude=.git -czf $Tar .
Pop-Location

$sshArgs = @("-i", $SshKey, "-o", "StrictHostKeyChecking=accept-new")
$target = "${User}@${VmIp}"

Write-Host "Creating $RemoteDir on VM..."
ssh @sshArgs $target "sudo mkdir -p $RemoteDir && sudo chown -R ${User}:${User} $(Split-Path $RemoteDir -Parent)"

Write-Host "Uploading archive..."
scp @sshArgs $Tar "${target}:${parent}/reportgen-web.tar.gz"

Write-Host "Extracting and rebuilding..."
$parent = (Split-Path $RemoteDir -Parent) -replace '\\', '/'
$remote = @"
set -e
mkdir -p $RemoteDir
tar -xzf $parent/reportgen-web.tar.gz -C $RemoteDir
rm -f $parent/reportgen-web.tar.gz
cd $RemoteDir
chmod +x deploy/vps/install-on-vm.sh
export ENV_TEMPLATE=deploy/vps/.env.production.example
export OPEN_UFW=0
bash deploy/vps/install-on-vm.sh
"@
ssh @sshArgs $target $remote

Write-Host ""
Write-Host "App: https://reportgen.duckdns.org/tax"
Write-Host "Logs: ssh -i `"$SshKey`" $target 'cd $RemoteDir && sudo docker compose logs -f app'"
