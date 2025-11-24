# PowerShell script to check Redis and start OCR worker
# Run: .\scripts\start-redis-and-worker.ps1

Write-Host "🔍 Checking Redis Status..." -ForegroundColor Cyan

# Check if Redis/Memurai is running
$redisRunning = $false

# Check for Memurai service
try {
    $memurai = Get-Service -Name "Memurai" -ErrorAction SilentlyContinue
    if ($memurai -and $memurai.Status -eq 'Running') {
        Write-Host "✅ Memurai (Redis) is running" -ForegroundColor Green
        $redisRunning = $true
    }
} catch {
    # Memurai not installed
}

# Check if Redis is accessible via redis-cli
if (-not $redisRunning) {
    try {
        $result = redis-cli ping 2>&1
        if ($result -match "PONG") {
            Write-Host "✅ Redis is running and accessible" -ForegroundColor Green
            $redisRunning = $true
        }
    } catch {
        # redis-cli not found or Redis not running
    }
}

if (-not $redisRunning) {
    Write-Host "❌ Redis is not running!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please install Redis/Memurai:" -ForegroundColor Yellow
    Write-Host "1. Download Memurai (Windows): https://www.memurai.com/get-memurai" -ForegroundColor Yellow
    Write-Host "2. Or install Redis via WSL/Docker" -ForegroundColor Yellow
    Write-Host "3. See: scripts/setup-redis-windows.md for detailed instructions" -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

Write-Host ""
Write-Host "🚀 Starting OCR Worker..." -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop the worker" -ForegroundColor Yellow
Write-Host ""

# Start the worker
npm run worker

