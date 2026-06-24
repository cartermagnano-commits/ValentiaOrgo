@echo off
echo.
echo  Orgo AI - Chemical Pathway Explorer
echo  =====================================
echo.

if not exist "frontend\node_modules" (
    echo  [1/2] Installing frontend dependencies (first run only^)...
    cd frontend
    call npm install
    cd ..
    echo.
)

echo  [2/2] Building frontend...
cd frontend
call npm run build
if %ERRORLEVEL% neq 0 (
    echo  ERROR: Frontend build failed. Make sure Node.js 18+ is installed.
    pause
    exit /b 1
)
cd ..
echo.

echo  Starting server...
echo.
echo  Your local IP addresses (for iPhone access^):
ipconfig | findstr /C:"IPv4 Address"
echo.
echo  Open http://localhost:8000  on this computer
echo  Open http://<your-IP>:8000  on your iPhone (same Wi-Fi^)
echo.
echo  Press Ctrl+C to stop.
echo.
python -m uvicorn app:app --host 0.0.0.0 --port 8000
