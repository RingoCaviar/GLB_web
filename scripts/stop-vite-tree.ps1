param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 65535)]
  [int]$Port,
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, [int]::MaxValue)]
  [int]$TargetPid
)

$ErrorActionPreference = 'Stop'
$vitePath = Join-Path (Split-Path -Parent $PSScriptRoot) 'node_modules\vite\bin\vite.js'
$viteArgument = [regex]::Escape($vitePath)
$viteCommand = '^\s*(?:"[^"]+"|\S+)\s+(?:"' + $viteArgument + '"|' + $viteArgument + ')(?:\s|$)'
$target = Get-CimInstance Win32_Process -Filter "ProcessId = $TargetPid"
if ($target.Name -ne 'node.exe' -or $target.CommandLine -notmatch $viteCommand) { exit 3 }

$systemDirectory = [Environment]::SystemDirectory
$listenerPattern = "^\s*TCP\s+\S+:${Port}\s+\S+\s+LISTENING\s+${TargetPid}\s*$"
$listeners = & (Join-Path $systemDirectory 'netstat.exe') -ano -p tcp
if ($LASTEXITCODE -ne 0 -or -not ($listeners -match $listenerPattern)) { exit 3 }

& (Join-Path $systemDirectory 'taskkill.exe') /PID $TargetPid /T /F *> $null
if ($LASTEXITCODE -ne 0) { exit 1 }
exit 0
