import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const outputDirectory = resolve(process.cwd(), 'dist');
const launcher = `@echo off
set "PORT=5173"
cd /d "%~dp0"
echo.
echo Starting static deployment server on port %PORT%...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0static-server.ps1" -Port %PORT%
pause
`;

const server = String.raw`param(
  [ValidateRange(1, 65535)]
  [int] $Port = 5173
)

$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$rootPrefix = $root.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$contentTypes = @{
  '.css' = 'text/css; charset=utf-8'; '.glb' = 'model/gltf-binary'; '.html' = 'text/html; charset=utf-8'
  '.js' = 'text/javascript; charset=utf-8'; '.json' = 'application/json; charset=utf-8'; '.svg' = 'image/svg+xml'
  '.webp' = 'image/webp'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'
  '.hdr' = 'application/octet-stream'; '.wasm' = 'application/wasm'
}

function Send-Response($stream, [int] $status, [string] $reason, [string] $contentType, [string] $filePath, [bool] $sendBody) {
  $length = if ($filePath) { (Get-Item -LiteralPath $filePath).Length } else { 0 }
  $newline = [Environment]::NewLine
  $header = "HTTP/1.1 $status $reason" + $newline + "Content-Type: $contentType" + $newline + "Content-Length: $length" + $newline + "Connection: close" + $newline + $newline
  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
  $stream.Write($headerBytes, 0, $headerBytes.Length)
  if ($sendBody -and $filePath) {
    $file = [System.IO.File]::OpenRead($filePath)
    try { $file.CopyTo($stream) } finally { $file.Dispose() }
  }
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
try { $listener.Start() } catch {
  Write-Error "Could not start port $($Port): $($_.Exception.Message)"
  exit 1
}

Write-Host "Static server started: http://localhost:$Port/"
foreach ($address in [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName())) {
  if ($address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and -not $address.ToString().StartsWith('127.')) {
    Write-Host "LAN address: http://$($address):$Port/"
  }
}
Write-Host 'Allow PowerShell on private networks if Windows Firewall asks. Press Ctrl+C to stop.'

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
      $requestLine = $reader.ReadLine()
      while ($reader.ReadLine()) { }
      if ([string]::IsNullOrWhiteSpace($requestLine)) { continue }
      $parts = $requestLine.Split(' ')
      if ($parts.Count -lt 2 -or $parts[0] -notin @('GET', 'HEAD')) {
        Send-Response $stream 405 'Method Not Allowed' 'text/plain; charset=utf-8' $null $false
        continue
      }
      $requestedPath = [Uri]::UnescapeDataString(($parts[1] -split '\?')[0]).TrimStart('/')
      if ([string]::IsNullOrWhiteSpace($requestedPath)) { $requestedPath = 'index.html' }
      $candidate = [System.IO.Path]::GetFullPath((Join-Path $root ($requestedPath -replace '/', '\\')))
      if (-not $candidate.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        Send-Response $stream 404 'Not Found' 'text/plain; charset=utf-8' $null $false
        continue
      }
      $extension = [System.IO.Path]::GetExtension($candidate).ToLowerInvariant()
      $contentType = if ($contentTypes.ContainsKey($extension)) { $contentTypes[$extension] } else { 'application/octet-stream' }
      Send-Response $stream 200 'OK' $contentType $candidate ($parts[0] -eq 'GET')
    } catch {
      try { Send-Response $stream 500 'Internal Server Error' 'text/plain; charset=utf-8' $null $false } catch { }
    } finally {
      if ($reader) { $reader.Dispose() }
      if ($client) { $client.Close() }
    }
  }
} finally { $listener.Stop() }
`;

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  rm(resolve(outputDirectory, '启动静态服务.ps1'), { force: true }),
  writeFile(resolve(outputDirectory, '启动静态服务.bat'), launcher, 'utf8'),
  writeFile(resolve(outputDirectory, 'static-server.ps1'), server, 'utf8'),
]);
