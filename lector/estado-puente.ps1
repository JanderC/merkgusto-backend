# Muestra si el puente está corriendo. Funciona sin permisos de administrador:
# la tarea es de la cuenta del sistema y una ventana normal no puede verla, pero sí ver
# que el puente escucha al lector y leer su registro.
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$puerto = 5055
$cfg = Join-Path $dir 'lector.config.json'
if (Test-Path $cfg) {
  try {
    $leido = (Get-Content $cfg -Raw -ErrorAction Stop | ConvertFrom-Json).puertoLocal
    if ($leido) { $puerto = [int]$leido }
  } catch {}
}

$escucha = Get-NetTCPConnection -LocalPort $puerto -State Listen -ErrorAction SilentlyContinue
if ($escucha) {
  Write-Host "PUENTE CORRIENDO (escucha al lector en el puerto $puerto)" -ForegroundColor Green
} else {
  Write-Host 'EL PUENTE NO ESTA CORRIENDO.' -ForegroundColor Red
  Write-Host 'Si acabas de prender la PC espera 1 minuto. Si sigue asi, abre INSTALAR-PUENTE.bat.'
}

$log = Join-Path $dir 'puente.log'
if (Test-Path $log) {
  $ultima = (Get-Item $log).LastWriteTime
  Write-Host ''
  Write-Host "Registro (ultima anotacion: $ultima):"
  Get-Content $log -Tail 25 -Encoding UTF8
}
