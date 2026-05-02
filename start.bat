@echo off
setlocal enabledelayedexpansion
title Driven - Server
color 0B

cd /d "%~dp0"

REM Load .env if present
if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
    set "key=%%A"
    if "!key:~0,1!" neq "#" set "%%A=%%B"
  )
)
if "%PORT%"=="" set PORT=3000

echo ============================================================
echo    DRIVEN - Starting server on port %PORT%
echo ============================================================
echo.

REM Sanity checks
where node >nul 2>&1
if %errorLevel% NEQ 0 (
  echo [!] Node.js not found. Run setup.bat first.
  pause & exit /b 1
)

where ngrok >nul 2>&1
if %errorLevel% NEQ 0 (
  if exist "%~dp0bin\ngrok.exe" (
    set "PATH=%~dp0bin;%PATH%"
  ) else (
    echo [!] ngrok not found. Run setup.bat first.
    pause & exit /b 1
  )
)

REM Start the Node server in a new window
start "Driven Server" cmd /k "cd /d %~dp0 && node server.js"

REM Give server a moment
timeout /t 2 /nobreak >nul

REM Start ngrok tunnel
echo.
echo [*] Starting ngrok tunnel on port %PORT%...
echo      The ngrok window will display your public URL.
echo      Share it with anyone who should have access.
echo.

start "Driven ngrok" cmd /k "ngrok http %PORT%"

REM Poll the local ngrok API to fetch and print the public URL
echo [*] Waiting for ngrok tunnel...
set TRIES=0
:wait_ngrok
set /a TRIES+=1
timeout /t 2 /nobreak >nul
:: FIXED SYNTAX BELOW: Escaped pipes and corrected PowerShell quote nesting
for /f "delims=" %%u in ('powershell -NoProfile -Command "try { (Invoke-RestMethod http://127.0.0.1:4040/api/tunnels).tunnels ^| Where-Object { $_.proto -eq 'https' } ^| Select-Object -First 1 -ExpandProperty public_url } catch { '' }"') do set "NGURL=%%u"

if "%NGURL%"=="" (
  if %TRIES% LSS 15 goto wait_ngrok
  echo [!] Could not auto-detect ngrok URL. Check the ngrok window.
  goto end
)

echo.
echo ============================================================
echo    PUBLIC URL: %NGURL%
echo    LOCAL URL:  http://localhost:%PORT%
echo ============================================================
echo.
echo    Anyone visiting %NGURL% can sign up and use Driven.
echo    To invite users to a server, click the upload icon in the
echo    channel header to generate an invite link.
echo.

REM Copy public URL to clipboard
echo %NGURL%| clip
echo [+] Public URL copied to clipboard.
echo.

:end
echo Close this window or press any key to leave the server running.
echo (The server and ngrok windows will keep running until you close them.)
pause >nul
endlocal