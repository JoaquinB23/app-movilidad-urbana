# Política de retención del historial de ubicaciones

Módulo Ubicaciones. Aplica a `ubicaciones_historial` (la tabla cruda de
posiciones). NO aplica a `ubicaciones_actuales`, que guarda solo la última
posición por chofer (una fila, se sobrescribe).

## Qué se conserva

- **Ubicaciones de viajes Activos**: se conservan hasta que el viaje finaliza
  (necesarias por evidencia y para GET /recorrido después del viaje).
- **Historial crudo**: límite temporal de **RETENCION_DIAS = 90 días** desde el
  `timestamp` de la posición. Pasado ese plazo no hay razón de negocio para
  mantenerlo y acumularlo en disco no tiene techo.

## Mecanismo

Un *job* periódico del proceso (en `composicion.js`) ejecuta:

```sql
SELECT purgar_ubicaciones_historial(90);  -- devuelve cuántas filas borró
```

Definido en `migraciones/200_ubicaciones.sql` como función PLpgSQL. Ventajas de
la función: el job solo la invoca, es auditable (devuelve el conteo) y el
`DELETE ... WHERE timestamp < NOW() - interval` usa el índice
`idx_ubicaciones_historial_ts`, así que no es un barrido completo.

## Garantías

- La purga es **por antigüedad**, no por viaje: un viaje de hace 200 días deja
  de estar disponible en /recorrido (✓ comportamiento documentado, no un bug).
- La purga es **transaccional** en una sola sentencia: si el job muere a mitad de
  nada, PostgreSQL aplica el DELETE atómicamente o no lo aplica.
- El job corre con baja prioridad y retry: si la base está ocupada, el siguiente
  tick lo reintenta (no compite con los pedidos en horario de carga).
- `RETENCION_DIAS` sale de variable de entorno con default 90 (configuración
  centralizada, bloque 3).

## Costo estimado

- 500 choferes × 1/2 s ⇒ ~250 filas/s ⇒ ~21,6 M filas/día. Con timestamp ~8 B +
  punteros, el cálculo del DELETE por rango de índice es barato; el borrado en
  sí es el típico costo de I/O que se programa fuera de horas pico y por
  lotes acotados (`DELETE ... LIMIT 100000` en un loop si fuera necesario; se
  deja documentado como ajuste si las métricas lo piden).