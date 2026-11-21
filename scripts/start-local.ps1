$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

function Stop-WithMessage([string]$Message) {
    Write-Host "`n$Message" -ForegroundColor Red
    exit 1
}
function Test-Url([string]$Url) {
    try { $null = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2; return $true }
    catch { return $false }
}
function Test-Listening([int]$Port) {
    return $null -ne (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1)
}
if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    Stop-WithMessage 'Node.js 24 and npm 11 are required.'
}
$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -ne 24) { Stop-WithMessage 'This project requires Node.js 24.' }
if (-not (Test-Path '.env') -or -not (Test-Path 'infra/docker/.env')) {
    Stop-WithMessage 'Missing .env or infra/docker/.env. Configure these files before starting.'
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Stop-WithMessage 'Docker Desktop is required for PostgreSQL and Redis.'
}
cmd.exe /c "docker info >nul 2>&1"
if ($LASTEXITCODE -ne 0) {
    $dockerPaths = @("$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe", "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe")
    $dockerApp = $dockerPaths | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($dockerApp) { Start-Process -FilePath $dockerApp -WindowStyle Hidden }
    Write-Host 'Waiting for Docker Desktop (up to 2 minutes)...'
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 2
        cmd.exe /c "docker info >nul 2>&1"
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    }
    if (-not $ready) { Stop-WithMessage 'Docker is not ready. Open Docker Desktop, resolve any prompts, and try again.' }
}
Write-Host 'Starting PostgreSQL and Redis...'
docker compose -f infra/docker/docker-compose.yml up -d --wait
if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'Could not start the database and Redis. Check the Docker output above.' }
if (-not (Test-Path 'node_modules/.bin/tsx.cmd')) {
    Write-Host 'Installing project dependencies...'
    npm ci
    if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'Dependency installation failed.' }
}
Write-Host 'Applying database migrations...'
npm exec --workspace @hmn/db -- prisma migrate deploy
if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'Database migration failed. Check the output above.' }
Write-Host 'Generating database client...'
npm run prisma:generate
if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'Database client generation failed. Check the output above.' }
Write-Host 'Building project...'
npm run build
if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'Build failed. See the output above.' }

if (-not (Test-Path 'hbook-v2/.env')) {
    Stop-WithMessage 'Missing hbook-v2/.env. Configure the booking engine environment before starting.'
}
if (-not (Test-Path 'hbook-v2/node_modules/.bin/tsx.cmd')) {
    Write-Host 'Installing booking engine dependencies...'
    npm ci --prefix hbook-v2
    if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'Booking engine dependency installation failed.' }
}
Write-Host 'Applying booking engine migrations...'
npm run db:migrate --prefix hbook-v2
if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'Booking engine migration failed. Check the output above.' }

if (-not (Test-Url 'http://127.0.0.1:3105/health')) {
    if (Test-Listening 3105) { Stop-WithMessage 'Port 3105 is in use by another process.' }
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'npm run dev' -WorkingDirectory (Join-Path (Get-Location).Path 'hbook-v2')
}
$engineReady = $false
for ($i = 0; $i -lt 30; $i++) {
    if (Test-Url 'http://127.0.0.1:3105/health') { $engineReady = $true; break }
    Start-Sleep -Seconds 1
}
if (-not $engineReady) { Stop-WithMessage 'Booking engine did not start. Check the hbook-v2 window for errors.' }

if (-not (Test-Url 'http://127.0.0.1:3001/health')) {
    if (Test-Listening 3001) { Stop-WithMessage 'Port 3001 is in use by another process.' }
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'npm run dev --workspace @hmn/api' -WorkingDirectory (Get-Location).Path
}
$apiReady = $false
for ($i = 0; $i -lt 30; $i++) {
    if (Test-Url 'http://127.0.0.1:3001/health') { $apiReady = $true; break }
    Start-Sleep -Seconds 1
}
if (-not $apiReady) { Stop-WithMessage 'API did not start. Check the API window for errors.' }
if (-not (Test-Listening 3000)) {
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'npm run dev --workspace @hmn/web -- --strictPort' -WorkingDirectory (Get-Location).Path
} elseif (-not (Test-Url 'http://127.0.0.1:3000/')) {
    Stop-WithMessage 'Port 3000 is in use by another process.'
}
$webReady = $false
for ($i = 0; $i -lt 30; $i++) {
    if (Test-Url 'http://127.0.0.1:3000/') { $webReady = $true; break }
    Start-Sleep -Seconds 1
}
if (-not $webReady) { Stop-WithMessage 'Web app did not start. Check the web window for errors.' }
Write-Host '`nProject is running at http://admin.localhost:3000' -ForegroundColor Green
Write-Host 'Booking engine: http://127.0.0.1:3105/health' -ForegroundColor Green
Write-Host 'Keep the booking engine, API and web windows open. Close them to stop the app.'
Start-Process 'http://admin.localhost:3000'

