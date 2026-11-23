@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "NODO=node"
if exist "%~dp0node.exe" set "NODO=%~dp0node.exe"
title Lector facial - prueba y configuracion
"%NODO%" lector.mjs
echo.
pause
