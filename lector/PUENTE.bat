@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "NODO=node"
if exist "%~dp0node.exe" set "NODO=%~dp0node.exe"
title Puente del lector - NO CERRAR
:otra
"%NODO%" puente.mjs
if %errorlevel%==2 goto fin
echo El puente se detuvo. Reintento en 10 segundos...
timeout /t 10 >nul
goto otra
:fin
pause
