@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Estado del puente del lector
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0estado-puente.ps1"
echo.
pause
