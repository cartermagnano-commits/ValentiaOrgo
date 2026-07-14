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

echo  [2/2] Starting servers...
echo.
echo  Backend API  : http://localhost:8000  (FastAPI / chemistry engine)
echo  Web app      : http://localhost:3000  (Next.js — open this one)
echo.
echo  Your local IP addresses (for iPhone access^):
ipconfig | findstr /C:"IPv4 Address"
echo.
echo  Open http://localhost:3000  on this computer
echo  Open http://^<your-IP^>:3000  on your iPhone (same Wi-Fi^)
echo.

REM Start the FastAPI backend in its own window (chemistry API on :8000)
start "Orgo AI - API" cmd /k python -m uvicorn app:app --host 0.0.0.0 --port 8000

REM Run the Next.js web app in this window (dev server on :3000)
cd frontend
call npm run dev
