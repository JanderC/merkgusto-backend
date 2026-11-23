# Lector facial: guía para el día de la instalación

Equipo: Hikvision DS-K1T321MFWX, firmware V3.9.2 · IP prevista 192.168.1.20

## Cómo queda

```
Lector facial ──red del gimnasio──► PC del gimnasio (PUENTE.bat) ──internet──► Railway
```

- El **lector decide** si abre, con las fechas que le cargó el sistema. No espera a internet.
- Sin internet, la PC guarda las entradas y las sube al volver. Las renovaciones hechas
  mientras tanto llegan al lector cuando vuelve la conexión.
- Con la PC apagada el lector sigue decidiendo, pero nadie le corrige el reloj ni recibe
  sus eventos. Mantén la PC encendida en horario de atención.

## Qué llevar

- Esta carpeta completa (USB o laptop). No hay que instalar nada.
- Contraseña de admin del lector.
- Cable de red. Para este equipo es mejor cable que Wi-Fi.
- Un celular, por si hay que tomar una foto.
- Acceso a Railway.
- Quien instaló la cerradura o el torniquete, o su teléfono.

## Orden

### 0. Antes de tocar el software (5 min)

1. El lector enciende y en su menú aparece la IP. Déjala fija.
2. La PC está en la misma red y con la hora correcta.
3. La cerradura tiene su propia fuente. No la alimentes del lector; revisa en la etiqueta
   o el manual cuánta corriente soporta el relé.
4. La puerta se puede abrir desde adentro sin luz y sin sistema.

### 1. Diagnóstico (2 min)

Abre `LECTOR.bat`, opción 1. No cambia nada. Deja un `informe-diagnostico-*.txt`.

### 2. Firewall de Windows (una vez)

PowerShell **como administrador**:

```powershell
New-NetFirewallRule -DisplayName "Lector facial Merkgusto" -Direction Inbound -Protocol TCP -LocalPort 5055 -RemoteAddress 192.168.1.20 -Action Allow
```

Si la IP del lector es otra, cámbiala en el comando.

### 3. Prueba real (10 min)

`LECTOR.bat`, opción 2. Con una persona de prueba verifica: foto, rostro, entra al día,
no entra vencido, entra renovado, apertura desde la PC y corte de luz. Al final la borra.

**Si algo dice FALLA, no sigas al paso 4.** Pásale el informe a Claude.

### 4. Conectar con el sistema

1. La versión nueva del backend tiene que estar desplegada.
2. Haz un respaldo en Ajustes › Respaldos.
3. `LECTOR.bat`, opción 3. Te muestra dos variables para Railway.
4. Pégalas en Railway y espera el redespliegue.
5. Abre `PUENTE.bat`. Debe decir `sistema: conectado` y `lector: conectado`.
6. Panel › Lector facial: debe decir «En línea».
7. Con **un cliente real con plan**: tómale la foto con el lector, espera «sincronizado»,
   que pase, y mira que aparezca en Entradas.
8. Solo entonces toca «Sincronizar todos».

Las fotos tomadas mientras el sistema estaba en modo simulado no son reales. El sistema
no las manda al lector: salen con error en la cola y hay que repetirlas.

### 5. Que corra solo, por debajo

1. Haz doble clic en `INSTALAR-PUENTE.bat` y acepta el permiso de administrador.
2. Desde ese momento el puente:
   - arranca solo al prender la PC, sin ventana y aunque nadie inicie sesión;
   - se vuelve a abrir solo si se cierra;
   - impide que la PC se duerma mientras esté conectada a la corriente.
3. Ya no abras `PUENTE.bat`.
4. `ESTADO-PUENTE.bat` muestra si está corriendo y sus últimos mensajes, que también quedan en `puente.log`.
5. Para quitarlo: `QUITAR-PUENTE.bat`.

## Si algo falla

| Lo que ves | Qué hacer |
|---|---|
| Red: no responde | Otra red o IP. Mira la IP en el menú del lector o con SADP. |
| Contraseña rechazada | No insistas: al quinto intento se bloquea unos 30 min. Pruébala una vez en `http://192.168.1.20`. |
| No llega el evento, pero la puerta abre | Firewall (paso 2) o la red de Windows está como Pública. |
| La orden de abrir pasa y no abre | Cableado, fuente o tipo de cerradura. No es el sistema. |
| Nadie entra después de un apagón | Reloj del lector. Abre `PUENTE.bat`: lo corrige en unos 20 segundos. |
| Foto rechazada | De frente, buena luz, sin gorra ni lentes, una sola cara, menos de 200 KB. |
| No reconoce bien | Evita sol directo o luz detrás de la persona; distancia de 0,3 a 1,5 m. |
| `sistema: la clave del puente no coincide` | Repite la opción 3 y vuelve a copiar la variable. |
| El lector «se cae» a ratos | Mira `ESTADO-PUENTE.bat`. Si dice `SIN CONEXIÓN con 192.168.1.20`, casi siempre es otro aparato con la misma IP: reserva la IP del lector en el router. |
| `el servidor no tiene el puente activado` | Falta `BIOMETRIC_MODE=puente` o desplegar la versión nueva. |

## Límites que debes conocer

- Caben **500 rostros**. «Sincronizar todos» solo carga a quienes tienen plan. Los que vencen
  se quedan ocupando espacio hasta que se desactiven.
- La huella no hace falta: el sistema funciona con rostro.
- Dos copias del puente a la vez se pelean los pedidos. Usa una sola PC.

## Cómo volver atrás

En Railway pon `BIOMETRIC_MODE=disabled` y cierra el puente. La recepción sigue registrando
entradas a mano. No vuelvas a `mock` con clientes reales: marca como cargados rostros que
no están en ningún lector.
