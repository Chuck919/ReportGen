# Upload web/ to Oracle VM and start (run from repo root on your PC)
#   .\deploy\oracle\push-to-vm.ps1 -VmIp 1.2.3.4 -SshKey $env:USERPROFILE\.ssh\oracle_rsa
param(
  [Parameter(Mandatory = $true)][string]$VmIp,
  [string]$SshKey = "$env:USERPROFILE\.ssh\id_rsa",
  [string]$User = "ubuntu",
  [string]$RemoteDir = "/opt/reportgen"
)

$ErrorActionPreference = "Stop"
$WebRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if (-not (Test-Path "$WebRoot\package.json")) { throw "Web root not found: $WebRoot" }

$Tar = Join-Path $env:TEMP "reportgen-web.tar.gz"
Write-Host "Packing $WebRoot (excluding node_modules, .next)..."
if (Test-Path $Tar) { Remove-Item $Tar -Force }

Push-Location $WebRoot
tar --exclude=node_modules --exclude=.next --exclude=.git -czf $Tar .
Pop-Location

$sshArgs = @("-i", $SshKey, "-o", "StrictHostKeyChecking=accept-new")
$target = "${User}@${VmIp}"

Write-Host "Creating $RemoteDir on VM..."
ssh @sshArgs $target "sudo mkdir -p $RemoteDir && sudo chown -R ${User}:${User} $RemoteDir"

Write-Host "Uploading archive..."
scp @sshArgs $Tar "${target}:${RemoteDir}/reportgen-web.tar.gz"

Write-Host "Extracting and installing..."
$remote = @"
set -e
cd $RemoteDir
tar -xzf reportgen-web.tar.gz
rm reportgen-web.tar.gz
chmod +x deploy/vps/install-on-vm.sh deploy/oracle/install-on-vm.sh
export ENV_TEMPLATE=deploy/vps/.env.production.example
export OPEN_UFW=0
sudo bash deploy/oracle/install-on-vm.sh
"@
ssh @sshArgs $target $remote

Write-Host ""
Write-Host "Shareable URL: http://$VmIp"
Write-Host "Logs on VM:    ssh -i `"$SshKey`" $target 'cd $RemoteDir && docker compose logs -f app'"
