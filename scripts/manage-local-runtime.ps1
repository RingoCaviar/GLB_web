param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Install', 'Remove')]
  [string]$Action,
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$runtimeRoot = Join-Path $ProjectRoot '.runtime'
$nodeRoot = Join-Path $runtimeRoot 'node'
$downloadRoot = Join-Path $runtimeRoot '.download'

function Assert-ProjectPath([string]$Path) {
  $projectFull = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\') + '\'
  $targetFull = [IO.Path]::GetFullPath($Path)
  if (-not $targetFull.StartsWith($projectFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝操作项目目录之外的路径：$targetFull"
  }
}

Assert-ProjectPath $runtimeRoot

if ($Action -eq 'Remove') {
  if (Test-Path -LiteralPath $runtimeRoot) {
    Remove-Item -LiteralPath $runtimeRoot -Recurse -Force
  }
  Write-Host '[完成] 项目内 Node.js 运行环境已经删除。'
  exit 0
}

$nodeExe = Join-Path $nodeRoot 'node.exe'
$npmCmd = Join-Path $nodeRoot 'npm.cmd'
if ((Test-Path -LiteralPath $nodeExe) -and (Test-Path -LiteralPath $npmCmd)) {
  $version = & $nodeExe --version
  Write-Host "[提示] 项目内 Node.js 已存在：$version"
  exit 0
}

$architecture = switch ($env:PROCESSOR_ARCHITECTURE) {
  'ARM64' { 'arm64' }
  'AMD64' { 'x64' }
  default { throw "暂不支持此 Windows 架构：$env:PROCESSOR_ARCHITECTURE" }
}

$baseUrl = 'https://nodejs.org/dist/latest-v22.x'
$sumsUrl = "$baseUrl/SHASUMS256.txt"
New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null

Write-Host '[下载] 正在获取 Node.js 22 LTS 官方版本信息……'
$sumsPath = Join-Path $downloadRoot 'SHASUMS256.txt'
Invoke-WebRequest -Uri $sumsUrl -OutFile $sumsPath -UseBasicParsing
$pattern = "^([0-9a-f]{64})  (node-v[0-9.]+-win-$architecture\.zip)$"
$match = Get-Content -LiteralPath $sumsPath | Select-String -Pattern $pattern | Select-Object -First 1
if (-not $match) { throw '官方校验清单中没有找到适合本机的 Windows ZIP。' }

$expectedHash = $match.Matches[0].Groups[1].Value
$archiveName = $match.Matches[0].Groups[2].Value
$archivePath = Join-Path $downloadRoot $archiveName
Write-Host "[下载] $archiveName"
Invoke-WebRequest -Uri "$baseUrl/$archiveName" -OutFile $archivePath -UseBasicParsing

$actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $expectedHash) { throw 'Node.js 安装包 SHA-256 校验失败，已停止安装。' }
Write-Host '[校验] SHA-256 校验通过，正在解压……'

$extractRoot = Join-Path $downloadRoot 'extract'
if (Test-Path -LiteralPath $extractRoot) { Remove-Item -LiteralPath $extractRoot -Recurse -Force }
Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot -Force
$extracted = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
if (-not $extracted) { throw 'Node.js 安装包内容不完整。' }
if (Test-Path -LiteralPath $nodeRoot) { Remove-Item -LiteralPath $nodeRoot -Recurse -Force }
Move-Item -LiteralPath $extracted.FullName -Destination $nodeRoot
Remove-Item -LiteralPath $downloadRoot -Recurse -Force

if (-not ((Test-Path -LiteralPath $nodeExe) -and (Test-Path -LiteralPath $npmCmd))) {
  throw '项目内 Node.js 安装后检查失败。'
}
$installedVersion = & $nodeExe --version
Write-Host "[完成] Node.js $installedVersion 已安装到：$nodeRoot"
Write-Host '[说明] 没有修改系统 PATH，也不会影响其他项目。'
