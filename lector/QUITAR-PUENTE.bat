@echo off
cd /d "%~dp0"
set "RUTA_PS1=%~dp0quitar-puente.ps1"
echo Quitar el puente: Windows va a pedir permiso de administrador. Acepta con "Si".
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -NoExit -File \"{0}\"' -f $env:RUTA_PS1)"
if errorlevel 1 echo No se pudo abrir como administrador. Clic derecho en este archivo y "Ejecutar como administrador".
timeout /t 5 >nul
