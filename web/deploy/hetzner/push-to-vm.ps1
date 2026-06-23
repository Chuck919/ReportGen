# Upload web/ to Hetzner Cloud VM and start (run from web/)
#   .\deploy\hetzner\push-to-vm.ps1 -VmIp 1.2.3.4
#   .\deploy\hetzner\push-to-vm.ps1 -VmIp 1.2.3.4 -SshKey $env:USERPROFILE\.ssh\hetzner_rsa
param(
  [Parameter(Mandatory = $true)][string]$VmIp,
  [string]$SshKey = "$env:USERPROFILE\.ssh\id_rsa",
  [string]$User = "root",
  [string]$RemoteDir = "/opt/reportgen"
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
ssh @sshArgs $target "mkdir -p $RemoteDir"

Write-Host "Uploading archive..."
scp @sshArgs $Tar "${target}:${RemoteDir}/reportgen-web.tar.gz"

Write-Host "Extracting and installing..."
$remote = @"
set -e
cd $RemoteDir
tar -xzf reportgen-web.tar.gz
rm reportgen-web.tar.gz
chmod +x deploy/vps/install-on-vm.sh
export ENV_TEMPLATE=deploy/vps/.env.production.example
export OPEN_UFW=1
bash deploy/vps/install-on-vm.sh
"@
ssh @sshArgs $target $remote

Write-Host ""
Write-Host "Shareable URL: http://$VmIp/tax"
Write-Host "Logs:          ssh -i `"$SshKey`" $target 'cd $RemoteDir && docker compose logs -f app'"
