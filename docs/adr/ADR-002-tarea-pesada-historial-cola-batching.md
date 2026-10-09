# ADR-002: Tarea pesada — escritura del historial de ubicaciones (cola + batching)

- Estado: Aceptada
- Fecha: 2026-10
- Módulo: Ubicaciones (Persona B)

## Contexto

El enunciado exige al menos una tarea pesada con versión ingenua y versión que
no degrada el servicio. En este módulo es la **persistencia del historial de
posiciones**: 500 choferes × 1 ubicación/2 s ≈ 250 INSERT/s, sostenidos por
minutos. Además cada POST de ubicación también actualiza `ubicaciones_actuales`
(UPSERT).

## Versión ingenua (la mala, a propósito de medirse)

```js
// por cada request → un INSERT
await consulta(INSERT_HISTORIAL, [viajeId, choferId, lng, lat, fecha]);
```

- Bloquea el camino crítico del request: la latencia de /ubicacion incluye el
  round-trip a la base, y con muchos requests simultáneos la cola de conexiones
  crece.
- No aprovecha PostgreSQL: un INSERT por fila paga parseo + WAL + fsync por
  sentencia. A 250/s la base hace 250 transacciones de una fila.

## Alternativas consideradas (bloque 7, §3.3)

1. **Chunking (partir en pedazos en un mismo hilo)** — No aplica: no hay un
   cómputo grande que dividir, hay I/O de base. Descartada.

2. **Streams** — Procesar un flujo de ubicaciones "de a chorro" sin acumular.
   Aparenta encajar, pero no batcha entre requests distintos y complica el ciclo
   de vida (¿cuándo se cierra el flujo? ¿qué pasa en SIGTERM?). Descartada.

3. **worker_threads** — Mover el INSERT a otro hilo. El cuello NO es CPU (hacer
   JSON y calcular coordenadas es barato); es el round-trip a la base, que un
   worker no mejora. Habría que igual mover la carga de WriteStream/pool de
   PostgreSQL. Descartada por relación coste/beneficio.

4. **Cola en memoria + flush por lotes** — Elegida.

## Decisión

`POST /choferes/me/ubicacion` hace, dentro del request, lo mínimo:

1. valida + verifica chofer disponible;
2. UPSERT de `ubicaciones_actuales` (una fila, es lo que SI debe estar al día);
3. **ENCOLA** el registro del historial en la `ColaHistorial` (O(1), no bloquea);
4. publica al SSE del viaje activo si existe.

Un worker (intervalo o umbral de `maxLote`) hace flush **en lotes** con un solo
INSERT multi-fila:

```sql
INSERT INTO historial_ubicaciones (viaje_id, chofer_id, geom, timestamp)
SELECT ... FROM unnest($1::text[], $2::text[], $3::float8[], $4::float8[], $5::timestamptz[])
AS lote(viaje_id, chofer_id, lng, lat, ts)
ON CONFLICT (chofer_id, timestamp) DO NOTHING;
```

- Un INSERT de 200 filas ≈ 200× más barato en WAL/fsync que 200 INSERT sueltos.
- Con `ON CONFLICT DO NOTHING` el historial queda **idempotente por clave natural
  `(chofer_id, timestamp)`**: un retry del cliente (red caída, reintento del
  simulador) no duplica filas. Según §6 la idempotencia se exige en "operaciones
  que crean o cobran"; aquí el POST es telemetría de un sender propio de nuestro
  sistema y tiene clave natural, lo que exime de mantener la tabla de
  Idempotency-Key (que crecería sin límite con 250 eventos/s). La decisión se
  aclara acá para defenderla en la defensa.
- La cola en memoria implica riesgo de pérdida si el proceso muere entre flush y
  flush: se acepta para telemetría (la posición es efímera y se reenvía cada 2 s).
- `drenar()` fuerza el flush en SIGTERM (apagado ordenado) y en tests.

## Consecuencias

- La latencia percibida de POST /ubicacion ya no depende del INSERT pesado.
- El UPSERT sigue siendo síncrono (es "estado presente"), el historial es "crudo
  histórico" y tolera atraso.
- La medición compara la versión ingenua (INSERT por request) contra esta, con
  hipótesis numérica antes de medir (docs/mediciones.md).