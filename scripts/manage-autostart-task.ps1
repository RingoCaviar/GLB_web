param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Install', 'Status', 'Remove')]
  [string]$Action,
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [int]$Port = 5173,
  [string]$OutputLog = '.glb-viewer-output.log',
  [string]$ErrorLog = '.glb-viewer-error.log',
  [string]$PidFile = '.glb-viewer.pid',
  [string]$StopRequestFile = '.glb-viewer-stop-requested'
)

$ErrorActionPreference = 'Stop'
$taskName = 'GLB Web 局域网服务'
$taskPath = '\GLB Web\'
$projectFull = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')
$runnerPath = Join-Path $projectFull 'scripts\run-vite-task.mjs'
$vitePath = Join-Path $projectFull 'node_modules\vite\bin\vite.js'
$localNode = Join-Path $projectFull '.runtime\node\node.exe'

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-Elevated {
  $arguments = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', ('"{0}"' -f $PSCommandPath),
    '-Action', $Action,
    '-ProjectRoot', ('"{0}"' -f $projectFull),
    '-Port', $Port,
    '-OutputLog', ('"{0}"' -f $OutputLog),
    '-ErrorLog', ('"{0}"' -f $ErrorLog),
    '-PidFile', ('"{0}"' -f $PidFile),
    '-StopRequestFile', ('"{0}"' -f $StopRequestFile)
  )
  $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Verb RunAs -Wait -PassThru
  exit $process.ExitCode
}

function Get-ExistingTask {
  return Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue
}

function Get-TaskProjectRoot($Task) {
  return ($Task.Actions | Select-Object -First 1).WorkingDirectory
}

function Test-TaskBelongsToProject($Task) {
  $registeredRoot = Get-TaskProjectRoot $Task
  if (-not $registeredRoot) { return $false }
  return [IO.Path]::GetFullPath($registeredRoot).Equals($projectFull, [StringComparison]::OrdinalIgnoreCase)
}

if ($Action -in @('Install', 'Remove') -and -not (Test-IsAdministrator)) {
  Write-Host '[提示] 安装或删除开机自启动需要管理员权限，即将请求授权。'
  Invoke-Elevated
}

if ($Action -eq 'Status') {
  $task = Get-ExistingTask
  if (-not $task) {
    Write-Host '[未安装] 尚未配置开机自启动任务。'
    exit 1
  }
  $info = Get-ScheduledTaskInfo -TaskName $taskName -TaskPath $taskPath
  $registeredRoot = Get-TaskProjectRoot $task
  $stateText = switch ($task.State) {
    'Running' { '正在运行' }
    'Ready' { '等待下次启动' }
    'Disabled' { '已禁用' }
    default { [string]$task.State }
  }
  Write-Host "[已安装] $taskPath$taskName"
  Write-Host "[状态] $stateText"
  if ($info.LastRunTime -gt [datetime]'2000-01-01') {
    Write-Host "[上次运行] $($info.LastRunTime)"
    Write-Host ('[上次结果] 0x{0:X8}' -f ($info.LastTaskResult -band 0xffffffffL))
  }
  Write-Host '[触发方式] Windows 启动后延迟 30 秒'
  Write-Host "[项目目录] $registeredRoot"
  if (-not (Test-TaskBelongsToProject $task)) {
    Write-Host "[注意] 该同名任务不属于当前项目：$projectFull"
    exit 2
  }
  exit 0
}

if ($Action -eq 'Remove') {
  $task = Get-ExistingTask
  if (-not $task) {
    Write-Host '[提示] 开机自启动任务尚未安装，无需删除。'
    exit 0
  }
  if (-not (Test-TaskBelongsToProject $task)) {
    $registeredRoot = Get-TaskProjectRoot $task
    throw "拒绝删除其他项目的同名任务：$registeredRoot"
  }
  Stop-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Confirm:$false
  Write-Host '[完成] 开机自启动任务已经删除。'
  exit 0
}

if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) {
  throw "缺少计划任务运行脚本：$runnerPath"
}
if (-not (Test-Path -LiteralPath $vitePath -PathType Leaf)) {
  throw '项目依赖尚未安装，请先在启动器中安装运行环境与依赖。'
}

$nodePath = if (Test-Path -LiteralPath $localNode -PathType Leaf) {
  $localNode
} else {
  (Get-Command node.exe -ErrorAction Stop).Source
}

$existingTask = Get-ExistingTask
if ($existingTask) {
  if (-not (Test-TaskBelongsToProject $existingTask)) {
    $existingRoot = Get-TaskProjectRoot $existingTask
    throw "同名任务已经属于其他项目：$existingRoot"
  }
  Stop-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Confirm:$false
}

$argumentList = @(
  ('"{0}"' -f $runnerPath),
  $Port,
  ('"{0}"' -f $OutputLog),
  ('"{0}"' -f $ErrorLog),
  ('"{0}"' -f $PidFile),
  ('"{0}"' -f $StopRequestFile)
) -join ' '
$taskAction = New-ScheduledTaskAction -Execute $nodePath -Argument $argumentList -WorkingDirectory $projectFull
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT30S'
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)
$description = "开机后启动 GLB Web 局域网服务。项目目录：$projectFull"

Register-ScheduledTask `
  -TaskName $taskName `
  -TaskPath $taskPath `
  -Action $taskAction `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description $description | Out-Null

Write-Host '[完成] 已安装开机自启动任务。'
Write-Host '[触发方式] Windows 启动后延迟 30 秒，以 SYSTEM 身份运行。'
Write-Host '[恢复策略] 异常退出后每分钟重试一次，最多重试 3 次。'
Write-Host '[说明] 本次安装不会立即启动服务；可用启动器手动启动，或重启电脑验证。'
