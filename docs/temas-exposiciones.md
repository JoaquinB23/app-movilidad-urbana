# Temas de exposiciones

Los tres temas elegidos son los que Programación IV ya exige, así que cada uno
tiene código, tests y evidencia en el repo:

1. Condiciones de carrera y control de concurrencia.
2. Idempotencia y deduplicación.
3. Health checks y autorrecuperación.

Por tema: la decisión, dónde está en el código, el comando que lo demuestra y la
evidencia (salida real de una corrida del 2026-11-26 contra PostgreSQL 16 +
PostGIS en Docker).

---

## 1. Condiciones de carrera y control de concurrencia

### Decisión

Todas las operaciones que cambian quién tiene un viaje toman **bloqueos de fila
en el mismo orden global: viaje → chofer → oferta** (`SELECT ... FOR UPDATE`),
revalidan el estado **después** de bloquear y se apoyan en **índices únicos
parciales** como última red (una asignación abierta por viaje y por chofer).
Cuando hay que repartir trabajo entre procesos (elegir candidato, vencer
ofertas, detectar choferes inactivos) se usa `FOR UPDATE SKIP LOCKED`: quien
encuentra una fila tomada la saltea en vez de esperarla. Detalle y alternativas
descartadas en `docs/adr/ADR-006-asignar-con-bloqueos-ordenados.md` y
`docs/adr/ADR-005-reasignacion-variante-h.md`.

| Carrera | Qué protege | Resultado definido |
|---|---|---|
| 50 choferes aceptan el mismo viaje | Lock del viaje + índice único de asignación por viaje | Un ganador; 49 `OFERTA_NO_VIGENTE` |
| Un chofer acepta dos viajes a la vez | Lock del chofer + índice único por chofer | Un ganador; el otro `CHOFER_OCUPADO` |
| Cancelación simultánea a la aceptación | Ambas bloquean primero el viaje: se serializan | Siempre `cancelado_pasajero`: o nunca hubo asignación, o la asignación quedó cerrada. Nunca un chofer ocupado sin viaje |
| Variante H: el worker reasigna justo cuando el chofer vuelve a reportar | Revalidación del umbral **dentro** de la transacción con el viaje bloqueado | Exactamente una asignación abierta: la del chofer original o la del nuevo |
| Dos viajes compiten por un único candidato | `FOR UPDATE SKIP LOCKED` al elegir candidato | Uno se queda con el chofer; el otro `SIN_CANDIDATOS` y conserva el suyo |

### Dónde está

- `src/dominio/viajes/casos-de-uso/aceptar-oferta.js`
- `src/dominio/viajes/casos-de-uso/transicionar-viaje.js` (cancelaciones y fin)
- `src/dominio/reasignacion/reasignar-viaje.js`
- `src/infra/db/repo-reasignacion-pg.js` (`SKIP LOCKED`)
- `migraciones/103_asignaciones_viaje.sql` (índices únicos parciales)

### Cómo se demuestra

```powershell
node --env-file=.env --test --test-concurrency=1 tests/concurrencia/
```

### Evidencia

```
✔ 50 aceptaciones simultáneas del mismo viaje persisten un único ganador (627.6072ms)
✔ un chofer no puede aceptar simultáneamente ofertas de dos viajes distintos (87.7682ms)
✔ cancelacion simultanea a la aceptacion: 50 rondas, siempre uno de los dos resultados definidos (4011.4179ms)
✔ carrera de H: reasignación y reporte del chofer simultáneos; nunca dos choferes ni ninguno (1456.5314ms)
✔ rechazar-continuar y worker simultáneos: queda exactamente una asignación abierta (88.6815ms)
✔ dos viajes compiten por un único candidato: SKIP LOCKED lo entrega a exactamente uno (83.3107ms)
```

Los tests verifican el **dato final en la base** (cuántas asignaciones abiertas
hay, en qué estado quedó el viaje, si el chofer quedó libre), no solo que no
hubo error.

---

## 2. Idempotencia y deduplicación

### Decisión

Toda operación que crea o cobra acepta `Idempotency-Key`. La clave se reserva
con `INSERT ... ON CONFLICT DO NOTHING` sobre `(usuario_id, clave)` **dentro de
la misma transacción** que el efecto (`claves_idempotencia`, migración 001):

- **Mismo pedido repetido** (red cortada, doble click): la PK hace esperar al
  reintento hasta que la primera transacción confirma, y le devuelve la
  respuesta original. No se crea un segundo viaje ni un segundo cobro.
- **Misma clave con otro cuerpo**: `409 CLAVE_REUTILIZADA` (se compara un
  sha256 del cuerpo).
- **Dos pedidos distintos con claves distintas** para el mismo efecto (cobrar
  dos veces el mismo viaje): lo frena una restricción de negocio en la base
  (`cobros_un_cobro_por_viaje`), no la clave. Resultado: `409 YA_COBRADO`.

Además hay deduplicación por **clave natural** donde existe: la telemetría de
ubicaciones se deduplica por `(chofer_id, timestamp)` sin `Idempotency-Key`
(`migraciones/200_ubicaciones.sql`), porque un reintento del mismo reporte
tiene exactamente esa clave.

### Dónde está

- `src/infra/db/idempotencia-pg.js` (reserva y respuesta guardada)
- `src/dominio/viajes/casos-de-uso/solicitar-viaje.js` (`POST /viajes`)
- `src/dominio/viajes/casos-de-uso/registrar-cobro.js` (`POST /viajes/:id/cobro`)
- `migraciones/105_cobros.sql` (un cobro por viaje)

### Cómo se demuestra

```powershell
node --env-file=.env --test tests/integracion/aceptar-oferta.test.js tests/concurrencia/cancelacion-y-cobro.test.js
```

### Evidencia

```
✔ 50 reintentos conservan en PostgreSQL un solo viaje, oferta y respuesta (110.3142ms)
✔ 50 cobros simultaneos con la misma Idempotency-Key: un solo cobro y la misma respuesta (233.1691ms)
✔ 50 cobros simultaneos con claves distintas: un cobro y 49 YA_COBRADO (272.291ms)
```

Y por HTTP, en `tests/integracion/ciclo-completo-http.test.js`: el reintento del
cobro con la misma clave devuelve **exactamente** el mismo status y cuerpo
(`201`), y otra clave para el mismo viaje responde `409 YA_COBRADO`.

---

## 3. Health checks y autorrecuperación

### Decisión

- `GET /health`: el proceso está vivo (no toca la base).
- `GET /ready`: la base responde **y** todas las migraciones del repo están
  aplicadas. Si no, `503 NO_LISTO`.
- En Docker Compose la API corre con `restart: unless-stopped` y un
  `healthcheck` sobre `/ready`; arranca aplicando las migraciones.
- Apagado ordenado con SIGTERM: deja de aceptar conexiones, termina las que
  están en curso, corta los SSE tras un tiempo límite, escribe la cola del
  historial en la base y cierra el pool (`src/servidor.js`).
- El pool de PostgreSQL tiene listener de `error`: si la base se cae, la API
  **no** se cae; `/ready` pasa a 503 y vuelve a 200 cuando la base vuelve.

### Dónde está

- `src/composicion.js` (`/health`, `/ready`)
- `src/servidor.js` (apagado ordenado)
- `src/infra/db/pool-pg.js` (listener de `error`)
- `docker-compose.yml` (servicio `api`, perfil `app`) y `Dockerfile`

### Cómo se demuestra

```powershell
docker compose --profile app up -d --build
docker exec movilidad-api node -e "process.kill(1, 'SIGTERM')"   # muere el proceso
docker stop movilidad-db; curl.exe -i http://localhost:3000/ready  # 503
docker start movilidad-db                                          # /ready vuelve a 200
node --env-file=.env --test tests/integracion/pool-caida-base.test.js
```

### Evidencia

Corrida completa en `docs/evidencia-recuperacion.md`. Resumen:

| Falla | Qué pasó |
|---|---|
| Muere el proceso de la API | Log `apagando` → `apagado completo`; Compose la reinicia (RestartCount 0 → 1) y vuelve a `healthy` |
| Se cae la base | `/health` 200, `/ready` **503**; al volver la base, `/ready` 200 en ~2 s **sin reiniciar la API** |

```
✔ una conexion ociosa terminada por la base no tira el proceso y el pool sigue sirviendo (262.9866ms)
```

Al preparar esta evidencia apareció una falla real: la primera vez que se cayó
la base, la API se cayó con ella (un `error` del pool sin listener terminaba el
proceso). Se corrigió y quedó el test de arriba para que no vuelva.
