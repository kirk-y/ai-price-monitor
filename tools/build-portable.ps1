param(
  [string]$OutputRoot = (Join-Path $PSScriptRoot '..\release')
)

$ErrorActionPreference = 'Stop'

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputRootPath = [IO.Path]::GetFullPath($OutputRoot)
$packageMetadata = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$releaseName = "AI-price-monitor-windows-x64-v$($packageMetadata.version)"
$packagePath = Join-Path $outputRootPath $releaseName
$archivePath = Join-Path $outputRootPath "$releaseName.zip"
$archive7zPath = Join-Path $outputRootPath "$releaseName.7z"
$archiveHashPath = Join-Path $outputRootPath "$releaseName.sha256"
$archive7zHashPath = Join-Path $outputRootPath "$releaseName.7z.sha256"
$runtimePath = (Get-Command node -ErrorAction Stop).Source
$sevenZipCommand = Get-Command 7z -ErrorAction SilentlyContinue
$sevenZipCandidates = @(
  if ($sevenZipCommand) { $sevenZipCommand.Source }
  if (${env:ProgramFiles}) { Join-Path ${env:ProgramFiles} '7-Zip\7z.exe' }
  if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} '7-Zip\7z.exe' }
  'D:\Program Files\7-Zip\7z.exe'
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$sevenZipPath = $sevenZipCandidates | Select-Object -First 1

if (-not $runtimePath.EndsWith('node.exe', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Only the Windows Node.js runtime can build this portable package.'
}
if (-not $outputRootPath.StartsWith($projectRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The release output must be inside the project directory.'
}
if (-not (Test-Path (Join-Path $projectRoot 'node_modules'))) {
  throw 'Dependencies are missing. Run npm install before creating a portable package.'
}

New-Item -ItemType Directory -Force -Path $outputRootPath | Out-Null
if (Test-Path $packagePath) {
  Remove-Item -LiteralPath $packagePath -Recurse -Force
}
foreach ($artifact in @($archivePath, $archive7zPath, $archiveHashPath, $archive7zHashPath)) {
  if (Test-Path -LiteralPath $artifact) {
    Remove-Item -LiteralPath $artifact -Force
  }
}

New-Item -ItemType Directory -Force -Path $packagePath | Out-Null

$files = @('server.js', 'store.js', 'scraper.js', 'validation.js', 'package.json', '.env.example')
foreach ($file in $files) {
  Copy-Item -LiteralPath (Join-Path $projectRoot $file) -Destination (Join-Path $packagePath $file)
}

Copy-Item -LiteralPath (Join-Path $projectRoot 'public') -Destination (Join-Path $packagePath 'public') -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot 'node_modules') -Destination (Join-Path $packagePath 'node_modules') -Recurse

$runtimeDirectory = Join-Path $packagePath 'runtime'
New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
Copy-Item -LiteralPath $runtimePath -Destination (Join-Path $runtimeDirectory 'node.exe')

$dataDirectory = Join-Path $packagePath 'data'
New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'data\README.md') -Destination (Join-Path $dataDirectory 'README.md') -ErrorAction SilentlyContinue
Copy-Item -LiteralPath (Join-Path $projectRoot '.env.example') -Destination (Join-Path $packagePath '.env')

$launcher = @(
  '@echo off',
  'setlocal EnableExtensions',
  'chcp 65001 >nul',
  'cd /d "%~dp0"',
  '',
  'set "NODE=%~dp0runtime\node.exe"',
  'if not exist "%NODE%" (',
  '  echo Missing bundled runtime: runtime\node.exe',
  '  pause',
  '  exit /b 1',
  ')',
  '',
  'if not exist "data" mkdir data',
  'if not exist ".env" copy /y ".env.example" ".env" >nul',
  '',
  'for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do (',
  '  if not "%%b"=="" set "%%a=%%b"',
  ')',
  '',
  'if "%PORT%"=="" set "PORT=3000"',
  'if "%HOST%"=="" set "HOST=127.0.0.1"',
  '',
  'start "AI Price Monitor Service" /min "%NODE%" "%~dp0server.js"',
  'timeout /t 1 /nobreak >nul',
  'start "" "http://%HOST%:%PORT%"',
  '',
  'echo AI Price Monitor has started at http://%HOST%:%PORT%',
  'echo Keep the minimized service window running while using the application.',
  'timeout /t 3 /nobreak >nul'
) -join [Environment]::NewLine
Set-Content -LiteralPath (Join-Path $packagePath 'start-price-monitor.bat') -Value $launcher -Encoding ascii

$readme = @(
  'AI Price Monitor - Windows Portable Edition',
  '',
  '1. Double-click the launcher batch file.',
  '2. Your browser opens the monitor automatically.',
  '3. Keep the minimized service window running while using the application.',
  '',
  'Your data is saved in data\stores.db.',
  'To upgrade, replace program files but keep the data folder and .env file.'
) -join [Environment]::NewLine
Set-Content -LiteralPath (Join-Path $packagePath 'README.txt') -Value $readme -Encoding utf8

$manifest = [ordered]@{
  name = 'AI Price Monitor'
  version = $packageMetadata.version
  platform = 'win32-x64'
  nodeVersion = (& $runtimePath --version).Trim()
  builtAt = (Get-Date).ToUniversalTime().ToString('o')
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $packagePath 'version.json') -Encoding utf8

Compress-Archive -LiteralPath $packagePath -DestinationPath $archivePath -CompressionLevel Optimal

if (-not $sevenZipPath) {
  throw '7-Zip was not found. Install 7-Zip or set the 7z command on PATH.'
}
& $sevenZipPath a -t7z -mx=5 $archive7zPath $packagePath | Out-Host
if ($LASTEXITCODE -ne 0) {
  throw "7-Zip failed with exit code $LASTEXITCODE."
}

$archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
Set-Content -LiteralPath $archiveHashPath -Value "$archiveHash  $releaseName.zip" -Encoding ascii
$archive7zHash = (Get-FileHash -LiteralPath $archive7zPath -Algorithm SHA256).Hash
Set-Content -LiteralPath $archive7zHashPath -Value "$archive7zHash  $releaseName.7z" -Encoding ascii

foreach ($artifact in @($archivePath, $archive7zPath, $archiveHashPath, $archive7zHashPath)) {
  if (-not (Test-Path -LiteralPath $artifact) -or (Get-Item -LiteralPath $artifact).Length -eq 0) {
    throw "Release artifact is missing or empty: $artifact"
  }
}

Write-Host "Portable folder: $packagePath"
Write-Host "ZIP archive: $archivePath"
Write-Host "7Z archive: $archive7zPath"
Write-Host "SHA-256: $archiveHash"
Write-Host "7Z SHA-256: $archive7zHash"
