$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot

function Test-PortListening {
    param([int]$Port)

    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return $null -ne $listener
}

function Test-HttpOk {
    param([string]$Url)

    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 400
    }
    catch {
        return $false
    }
}

function Start-TerminalCommand {
    param(
        [string]$WorkingDirectory,
        [string]$Command
    )

    Start-Process powershell -ArgumentList @(
        "-NoExit",
        "-Command",
        "Set-Location -Path '$WorkingDirectory'; $Command"
    ) | Out-Null
}

Write-Host "Generating dbt docs..."
Set-Location -Path "$repoRoot\vineskills_analytics"
dbt docs generate

if ((Test-PortListening -Port 8000) -and (Test-HttpOk -Url "http://127.0.0.1:8000/docs")) {
    Write-Host "FastAPI already running on port 8000. Skipping startup."
}
else {
    Write-Host "Starting FastAPI (Swagger)..."
    Start-TerminalCommand -WorkingDirectory $repoRoot -Command "uvicorn api:app --reload --host 127.0.0.1 --port 8000"
}

if ((Test-PortListening -Port 8081) -and (Test-HttpOk -Url "http://127.0.0.1:8081")) {
    Write-Host "DBT docs already running on port 8081. Skipping startup."
}
else {
    Write-Host "Starting DBT docs server..."
    Start-TerminalCommand -WorkingDirectory "$repoRoot\vineskills_analytics" -Command "dbt docs serve --host 127.0.0.1 --port 8081"
}

if ((Test-PortListening -Port 8080) -and (Test-HttpOk -Url "http://127.0.0.1:8080/web/")) {
    Write-Host "Dashboard web server already running on port 8080. Skipping startup."
}
else {
    Write-Host "Starting dashboard web server..."
    Start-TerminalCommand -WorkingDirectory $repoRoot -Command "py -m http.server 8080 --bind 127.0.0.1"
}

Start-Sleep -Seconds 3

Write-Host "Opening pages in your browser..."
Start-Process "http://127.0.0.1:8000/docs"
Start-Process "http://127.0.0.1:8081"
Start-Process "http://127.0.0.1:8080/web/"

Write-Host "All services started."
