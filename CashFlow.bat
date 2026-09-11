@echo off
chcp 65001 >nul
title CashFlow - Quan Ly Tai Chinh Ca Nhan

echo ====================================================
echo             KHOI DONG CASHFLOW LOCAL
echo ====================================================
echo.

set "PROJECT_DIR=C:\Users\thien\github\CashFlow"
if exist "%~dp0package.json" (
    set "PROJECT_DIR=%~dp0"
)
cd /d "%PROJECT_DIR%"

:: 1. Kiem tra Docker
echo [1/4] Kiem tra Docker Desktop...
docker info >nul 2>&1
if %ERRORLEVEL% EQU 0 goto DOCKER_READY

echo [!] Docker chua chay. He thong dang tu dong khoi dong Docker Desktop...
if exist "C:\Program Files\Docker\Docker\Docker Desktop.exe" (
    start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
) else if exist "C:\Program Files\Docker\Docker\frontend\Docker Desktop.exe" (
    start "" "C:\Program Files\Docker\Docker\frontend\Docker Desktop.exe"
) else (
    echo Khong tim thay Docker Desktop trong thu muc mac dinh.
    echo Vui long mo Docker Desktop thu cong roi chay lai file nay!
    pause
    exit /b 1
)

echo Cho Docker Desktop khoi dong xong (co the mat 15-30 giay)...
set /a WAIT_COUNT=0

:WAIT_DOCKER
timeout /t 3 /nobreak >nul
docker info >nul 2>&1
if %ERRORLEVEL% EQU 0 goto DOCKER_READY

set /a WAIT_COUNT+=3
if %WAIT_COUNT% GEQ 90 goto DOCKER_TIMEOUT
echo ... dang cho Docker Engine san sang [%WAIT_COUNT%s]
goto WAIT_DOCKER

:DOCKER_TIMEOUT
echo.
echo [!] Docker Desktop khoi dong qua lau hoac can xac nhan tren man hinh.
echo Vui long kiem tra Docker Desktop da sang mau xanh (Engine running) roi thu lai.
pause
exit /b 1

:DOCKER_READY
echo [v] Docker da san sang!
echo.

:: 2. Khoi dong PostgreSQL Container
echo [2/4] Khoi dong Database PostgreSQL qua Docker...
docker compose up -d
if %ERRORLEVEL% NEQ 0 (
    echo [!] Khong the khoi dong container PostgreSQL. Vui long kiem tra lai Docker!
    pause
    exit /b 1
)
echo [v] Container Database PostgreSQL dang chay tren port 5439.
echo.

:: 3. Kiem tra Database Migration
echo [3/4] Kiem tra va dong bo Database (Prisma Migrate)...
call npx prisma migrate deploy
if %ERRORLEVEL% NEQ 0 (
    echo [!] Loi khi kiem tra database migration.
    pause
    exit /b 1
)
echo [v] Database da san sang.
echo.

:: 4. Mo trinh duyet va chay ung dung
echo [4/4] Khoi dong ung dung CashFlow...
echo Trinh duyet se tu dong mo tai http://localhost:3000 trong giay lat...
start "" /min cmd /c "timeout /t 5 /nobreak >nul & start http://localhost:3000"

echo.
echo ====================================================
echo   CASHFLOW DANG CHAY TAI: http://localhost:3000
echo.
echo   * QUAN TRONG: Vui long GIU NGUYEN cua so nay!
echo     (Dong cua so nay se tat ung dung CashFlow)
echo   * Neu trinh duyet chua hien giao dien moi, hay
echo     nhan to hop phim Ctrl + F5 (hoac Ctrl + Shift + R)
echo ====================================================
echo.

call npm run dev