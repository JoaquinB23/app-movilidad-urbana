# ADR-005 · Reasignar con un caso de uso único que bloquea el viaje, revalida el umbral y elige candidato con SKIP LOCKED

## Estado

Implementada.

## Fecha y participantes

17/11/2026, actualizada el 26/11/2026. Frente B, responsable de la variante H. Pendiente de revisión por el otro integrante.

## Contexto

Un viaje asignado puede quedar huérfano en la práctica: el chofer deja de
reportar ubicación (se quedó sin batería, sin señal, apagó la app) o rechaza
continuar. La variante H exige reasignar el viaje **sin que el pasajero lo
vuelva a pedir**, con dos disparadores:

- un **worker** que detecta choferes asignados sin reporte hace más del
  umbral configurable (`umbral_reasignacion_s`, `PUT /admin/parametros`);
- `POST /viajes/:id/rechazar-continuar` cuando el chofer asignado rechaza.

La carrera propia de H: el worker decide reasignar **en el mismo instante** en
que el chofer original vuelve a reportar. El resultado exigido: nunca dos
choferes asignados al mismo viaje, y nunca ninguno.

## Decisión

### Caso de uso único

`reasignarViaje({ viajeId, motivo, exigirInactividadS?, radioBusquedaM? })`
(`src/dominio/reasignacion/reasignar-viaje.js`). El worker y el endpoint de
rechazo llaman al MISMO código; difieren solo en el motivo y en que el worker
pasa `exigirInactividadS` para revalidar el umbral.

Dentro de **una** transacción:

1. Bloquea el **viaje** (`SELECT ... FOR UPDATE`) y valida su estado
   (`asignado` / `chofer_en_camino`).
2. Bloquea el **chofer** saliente (mismo orden global viaje → chofer que
   `aceptarOferta`: sin deadlocks entre módulos).
3. **Revalida el umbral dentro de la transacción** (solo worker): si el chofer
   reportó mientras se esperaba el lock, se aborta (`VIAJE_NO_REASIGNABLE`).
   Acá se decide la carrera de H, con el viaje bloqueado.
4. Elige candidato con `SELECT ... FOR UPDATE SKIP LOCKED`: chofer habilitado,
   disponible, sin asignación abierta, distinto del saliente, con ubicación
   dentro del radio, el más cercano al origen. SKIP LOCKED hace que dos
   reasignaciones simultáneas jamás elijan el mismo chofer: el que está
   bloqueado por otra transacción simplemente se saltea.
5. **Cierra** la asignación vigente (`hasta = now()`, `motivo_fin`) y **abre**
   la nueva en la misma transacción. El chofer anterior queda libre (hay test
   de que no queda ocupado).
6. Vuelve el viaje a `asignado` y registra el evento `reasignar`
   (actor `sistema`, con motivo) en `viajes_eventos`.

La red de seguridad final son los índices únicos parciales de la migración 103
(una sola asignación abierta por viaje y por chofer): aunque un bug saltara
los locks, la DB rechaza el segundo `INSERT`.

### Worker

`src/workers/reasignacion.js`. Cada ciclo: lee el umbral y el radio de
`parametros`, **detecta** en una transacción corta con
`SELECT ... FOR UPDATE SKIP LOCKED` sobre los viajes (dos instancias del
worker nunca procesan el mismo viaje) y llama a `reasignarViaje` por cada
detectado. `SIN_CANDIDATOS` y `VIAJE_NO_REASIGNABLE` son resultados esperables
(reintenta el próximo ciclo), no errores. Un flag de reentrada evita ciclos
superpuestos y ningún error voltea el proceso.

### Seguimiento después de reasignar

Después del commit, `reasignarViaje` publica `reasignado` en el canal del
viaje (sin ids de choferes). Cada stream SSE revalida contra la base quién
participa ahora: el chofer reemplazado recibe `acceso_revocado` y se le cierra
el stream, y las posiciones de chofer solo le llegan al pasajero. Sin esto, el
chofer anterior seguía conectado y recibía las posiciones del chofer nuevo
(`tests/seguridad/seguimiento-tras-reasignar.test.js`).

### Sin candidatos: el viaje conserva su chofer

Si no hay candidato, la asignación vigente NO se cierra. Cerrarla dejaría al
pasajero sin nadie y la máquina de estados no tiene vuelta de `asignado` a
`solicitado`. El worker reintenta en el próximo ciclo.

## Alternativas descartadas

- **Advisory locks de PostgreSQL**: funcionan, pero duplican el mecanismo que
  los row locks ya dan gratis sobre las filas que de verdad se modifican, y se
  pueden filtrar si una conexión muere sin liberarlos.
- **Cola de trabajos (tipo pg-boss / BullMQ)**: infraestructura extra para un
  problema que un `SELECT ... SKIP LOCKED` resuelve; la detección ES la cola.
- **Marcar el viaje con un estado intermedio `reasignando`**: tocaría la
  máquina de estados del módulo de viajes (Persona A) y agregaría un estado
  visible sin valor para el pasajero; el lock de fila da la misma exclusión
  sin estado nuevo.
- **Resolver la carrera "última escritura gana" sin revalidar**: podría cerrar
  la asignación de un chofer que sí volvió; la revalidación del umbral dentro
  de la transacción decide con información fresca y bloqueada.

## Resultado documentado (tests)

`tests/concurrencia/reasignacion-carrera.test.js`:

- la carrera reasignación vs. reporte simultáneo deja **siempre exactamente
  una** asignación abierta (20 rondas), del chofer original o del nuevo;
- dos reasignaciones simultáneas del mismo viaje: una sola abierta;
- dos viajes compitiendo por un único candidato: SKIP LOCKED lo entrega a
  exactamente uno, el otro queda `SIN_CANDIDATOS` con su chofer;
- el chofer reemplazado nunca queda con una asignación abierta.

## Qué nos haría cambiar de decisión

- Si con varias instancias de la API el worker de cada una compitiera por los
  mismos viajes y el `SKIP LOCKED` no alcanzara para repartir el trabajo sin
  esperas, pasaríamos a un único worker con elección de líder (advisory lock
  de sesión) en lugar de uno por instancia.
- Si el umbral configurado en producción resultara tan bajo que una pérdida
  breve de señal disparara reasignaciones innecesarias, agregaríamos un
  período de gracia con aviso al chofer antes de reasignar.
