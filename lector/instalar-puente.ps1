# Instala el puente como tarea de Windows: arranca al prender la PC, sin ventana,
# y se reinicia solo si se cierra. Lo ejecuta INSTALAR-PUENTE.bat (como administrador).
$ErrorActionPreference = 'Stop'
$dirLog = Split-Path -Parent $MyInvocation.MyCommand.Path
Start-Transcript -Path (Join-Path $dirLog 'instalar.log') -Append | Out-Null
trap { Write-Host ''; Write-Host ('ERROR: ' + $_) -ForegroundColor Red; Write-Host 'Copia este mensaje (o el archivo instalar.log) y pasaselo a Claude.'; Stop-Transcript | Out-Null; break }
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$tarea = 'Merkgusto - Puente del lector'

if (-not (Test-Path (Join-Path $dir 'lector.config.json'))) {
  Write-Host 'Falta configurar: abre LECTOR.bat y elige la opcion 3 primero.' -ForegroundColor Red
  exit 1
}
$nodo = Join-Path $dir 'node.exe'
if (-not (Test-Path $nodo)) { $nodo = (Get-Command node -ErrorAction Stop).Source }

# Cierra el puente que este abierto en ventana (PUENTE.bat) para no tener dos
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*puente.mjs*' -or $_.CommandLine -like '*vigilante.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*PUENTE.bat*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
if (Get-ScheduledTask -TaskName $tarea -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $tarea -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $tarea -Confirm:$false
}

# El vigilante abre el puente y lo reabre si se cierra
$accion = New-ScheduledTaskAction -Execute $nodo -Argument '"vigilante.mjs"' -WorkingDirectory $dir
$alPrender = New-ScheduledTaskTrigger -AtStartup
$cuenta = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$ajustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $tarea -Action $accion -Trigger $alPrender -Principal $cuenta -Settings $ajustes `
  -Description 'Conecta el lector facial con el sistema de Merkgusto Gym' | Out-Null

# Permiso para que el lector le avise las entradas (puerto 5055)
$ip = (Get-Content (Join-Path $dir 'lector.config.json') -Raw | ConvertFrom-Json).lector.ip
if (-not (Get-NetFirewallRule -DisplayName 'Lector facial Merkgusto' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'Lector facial Merkgusto' -Direction Inbound -Protocol TCP -LocalPort 5055 -RemoteAddress $ip -Action Allow | Out-Null
}

# La PC no debe dormirse con el cable de corriente puesto
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0

Start-ScheduledTask -TaskName $tarea
Start-Sleep -Seconds 15
$estado = (Get-ScheduledTask -TaskName $tarea).State
Write-Host ''
Write-Host "Puente instalado. Estado: $estado" -ForegroundColor Green
Write-Host 'Arranca solo al prender la PC y se reinicia si se cierra. No hace falta abrir PUENTE.bat.'
Write-Host ''
Write-Host 'Ultimas lineas del registro:'
$log = Join-Path $dir 'puente.log'
if (Test-Path $log) { Get-Content $log -Tail 8 -Encoding UTF8 }
Stop-Transcript | Out-Null
