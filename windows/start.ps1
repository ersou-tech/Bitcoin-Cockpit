# BTC RADAR - lancador do Windows.
$ErrorActionPreference = 'Stop'
$pasta = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $pasta

$porta = if ($env:PORT) { [int]$env:PORT } else { 8899 }

$versao = (& node -v) 2>$null
if (-not $versao -or [int]($versao -replace 'v(\d+)\..*', '$1') -lt 22) {
  Write-Host "Node 22 ou maior e necessario (encontrado: $versao)."
  Write-Host "Baixe em https://nodejs.org"
  exit 1
}

$ocupada = Get-NetTCPConnection -LocalPort $porta -State Listen -ErrorAction SilentlyContinue
if (-not $ocupada) {
  Start-Process -WindowStyle Hidden -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $pasta
  Start-Sleep -Seconds 2
}
Start-Process "http://127.0.0.1:$porta"
