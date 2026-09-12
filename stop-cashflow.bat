@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title CashFlow - Dung Database & Ung Dung

echo ====================================================
echo             DUNG CASHFLOW LOCAL
echo ====================================================
echo.

set "PROJECT_DIR=C:\Users\thien\github\CashFlow"
if exist "%~dp0package.json" (
    set "PROJECT_DIR=%~dp0"
)
cd /d "!PROJECT_DIR!"

echo Dang tat container database PostgreSQL...
docker compose down
if %ERRORLEVEL% EQU 0 (
    echo.
    echo [v] Da tat database thanh cong.
) else (
    echo.
    echo [!] Khong the tat database container hoac Docker chua chay.
)
echo.
pause