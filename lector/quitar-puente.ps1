$ErrorActionPreference = 'Stop'
$dirLog = Split-Path -Parent $MyInvocation.MyCommand.Path
Start-Transcript -Path (Join-Path $dirLog 'instalar.log') -Append | Out-Null
trap { Write-Host ''; Write-Host ('ERROR: ' + $_) -ForegroundColor Red; Write-Host 'Copia este mensaje (o el archivo instalar.log) y pasaselo a Claude.'; Stop-Transcript | Out-Null; break }
$tarea = 'Merkgusto - Puente del lector'
if (Get-ScheduledTask -TaskName $tarea -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $tarea -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $tarea -Confirm:$false
}
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*puente.mjs*' -or $_.CommandLine -like '*vigilante.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Write-Host 'Puente quitado. Ya no arranca solo. Para usarlo en ventana abre PUENTE.bat.' -ForegroundColor Yellow
Stop-Transcript | Out-Null
