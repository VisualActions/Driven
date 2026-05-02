@echo off
setlocal enabledelayedexpansion
title Driven - Setup
color 0B

echo ============================================================
echo   DRIVEN - Windows Server Setup
echo ============================================================
echo.

REM --- Admin check (preferred for winget) -----------------------
net session >nul 2>&1
if %errorLevel% NEQ 0 (
  echo [!] You are not running as Administrator.
  echo     Some installs ^(Node, ngrok^) may need elevation.
  echo     Right-click setup.bat -^> "Run as administrator" if anything fails.
  echo.
  pause
)

REM --- Check / install Node.js ----------------------------------
where node >nul 2>&1
if %errorLevel% NEQ 0 (
  echo [*] Node.js not found. Installing via winget...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
  if !errorLevel! NEQ 0 (
    echo [!] winget install failed. Install Node.js manually from https://nodejs.org and re-run setup.bat
    pause
    exit /b 1
  )
  echo [*] Refreshing PATH...
  call :refreshenv
) else (
  for /f "delims=" %%v in ('node -v') do set NODE_VER=%%v
  echo [+] Node.js detected: !NODE_VER!
)

REM --- Verify node is on PATH now --------------------------------
where node >nul 2>&1
if %errorLevel% NEQ 0 (
  echo [!] Node.js still not on PATH. Open a NEW terminal and run setup.bat again.
  pause
  exit /b 1
)

REM --- Check / install ngrok ------------------------------------
where ngrok >nul 2>&1
if %errorLevel% NEQ 0 (
  echo [*] ngrok not found. Installing via winget...
  winget install -e --id Ngrok.Ngrok --accept-source-agreements --accept-package-agreements --silent
  if !errorLevel! NEQ 0 (
    echo [!] winget failed. Falling back to direct download...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "$ErrorActionPreference='Stop'; $u='https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip'; $z='%TEMP%\ngrok.zip'; Invoke-WebRequest $u -OutFile $z; Expand-Archive -Force $z '%~dp0bin'; Remove-Item $z"
    if !errorLevel! NEQ 0 (
      echo [!] Failed to download ngrok. Get it from https://ngrok.com/download
      pause
      exit /b 1
    )
    set "PATH=%~dp0bin;%PATH%"
    echo [+] ngrok extracted to %~dp0bin
  )
  call :refreshenv
) else (
  for /f "delims=" %%v in ('ngrok version 2^>^&1') do set NGROK_VER=%%v
  echo [+] ngrok detected: !NGROK_VER!
)

REM --- Configure ngrok authtoken --------------------------------
echo.
echo ngrok requires an authtoken (free signup at https://dashboard.ngrok.com/get-started/your-authtoken)
ngrok config check >nul 2>&1
if %errorLevel% NEQ 0 (
  set /p NGROK_TOKEN="Paste your ngrok authtoken (or press Enter to skip): "
  if not "!NGROK_TOKEN!"=="" (
    ngrok config add-authtoken !NGROK_TOKEN!
    echo [+] ngrok authtoken saved.
  ) else (
    echo [!] Skipped. You will need to run: ngrok config add-authtoken YOUR_TOKEN
  )
) else (
  echo [+] ngrok already configured.
)

REM --- Install npm dependencies ---------------------------------
echo.
echo [*] Installing npm dependencies (this may take a minute)...
pushd "%~dp0"
call npm install --no-audit --no-fund
if %errorLevel% NEQ 0 (
  echo [!] npm install failed.
  popd
  pause
  exit /b 1
)
popd
echo [+] Dependencies installed.

REM --- Generate JWT secret if missing ---------------------------
if not exist "%~dp0.env" (
  for /f "delims=" %%s in ('powershell -NoProfile -Command "[Convert]::ToBase64String((1..48 ^| ForEach-Object {Get-Random -Maximum 256}))"') do set JWT=%%s
  > "%~dp0.env" echo JWT_SECRET=!JWT!
  >>"%~dp0.env" echo PORT=3000
  echo [+] Generated .env with random JWT_SECRET.
)

REM --- Open firewall port for LAN access ------------------------
netsh advfirewall firewall show rule name="Driven 3000" >nul 2>&1
if %errorLevel% NEQ 0 (
  echo [*] Adding Windows Firewall rule for port 3000 (LAN access)...
  netsh advfirewall firewall add rule name="Driven 3000" dir=in action=allow protocol=TCP localport=3000 >nul
)

echo.
echo ============================================================
echo   SETUP COMPLETE
echo ============================================================
echo.
echo   Run start.bat to launch the server + ngrok tunnel.
echo   Your public URL will be displayed in the ngrok window.
echo.
pause
exit /b 0

:refreshenv
REM Re-read PATH from registry so freshly installed binaries are visible
for /f "tokens=2*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul ^| findstr /R /C:"REG_[A-Z_]*SZ"') do set "MACHINE_PATH=%%B"
for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul ^| findstr /R /C:"REG_[A-Z_]*SZ"') do set "USER_PATH=%%B"
set "PATH=%MACHINE_PATH%;%USER_PATH%"
exit /b 0
