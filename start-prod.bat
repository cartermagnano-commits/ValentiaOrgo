@echo off
REM Orgo AI production launcher. See README "Production mode" for the contract.
REM
REM Configuration comes from the environment or .env (app.py loads it):
REM   SUPABASE_URL or SUPABASE_JWT_SECRET   required — token verification;
REM                                         the backend REFUSES to start without one
REM   ANTHROPIC_API_KEY / OPENAI_API_KEY    optional — enables Hosted engine mode
REM   HOSTED_DAILY_REQUESTS                 optional — hosted quota (default 200)
echo.
echo  Orgo AI - production mode
echo  =========================
echo.

set ORGO_ENV=prod

if not exist "frontend\node_modules" (
    echo  Installing frontend dependencies...
    cd frontend
    call npm install || exit /b 1
    cd ..
)

echo  Building frontend (npm run build)...
cd frontend
call npm run build || exit /b 1
cd ..

echo.
echo  Backend API  : http://127.0.0.1:8000  (loopback only — reached via the Next.js proxy)
echo  Web app      : http://localhost:3000  (put your reverse proxy / TLS in front of this)
echo.
echo  NOTE: run exactly ONE backend worker — rate-limit buckets, hosted-quota
echo  counters, and verify tokens live in process memory.
echo.

REM Backend: loopback bind, no --reload, single worker (the default).
start "Orgo AI - API (prod)" cmd /k python -m uvicorn app:app --host 127.0.0.1 --port 8000

REM Frontend: production server on :3000 in this window.
cd frontend
call npm start
