@echo off
echo.
echo  Orgo AI — Chemical Structure Analyzer
echo  =======================================
echo.
echo  Your local IP addresses (for iPhone access):
ipconfig | findstr /C:"IPv4 Address"
echo.
echo  Open http://localhost:8000  on this computer
echo  Open http://<your-IP>:8000  on your iPhone (same Wi-Fi)
echo.
echo  Press Ctrl+C to stop the server.
echo.
uvicorn app:app --host 0.0.0.0 --port 8000 --reload
