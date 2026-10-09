# Guía de defensa — Módulo Ubicaciones (Persona B)

Texto para estudiar la implementación y defenderla ante la evaluación. Explica
**qué se hizo, por qué exactamente así, y qué decidir si te preguntan algo más**.

Arquitectura del proyecto: **hexagonal**. Todo lo del módulo vive en 3 capas:

```
src/dominio/ubicaciones/  -> reglas puras y puertos (SIN express, SIN pg)
src/infra/                -> adaptadores concretos (memoria, PostGIS, HTTP, cola, bus)
src/composicion.js        -> (del proyecto, NO tocado) el que junta todo con "inyección"
tests/                    -> tests de dominio + de seguridad HTTP
migraciones/              -> schema (200_ubicaciones.sql)
scripts/carga/            -> simulador de choferes + autocannon (mediciones)
docs/                     -> ADRs, retención, mediciones, esta guía
```

Idea central: **el dominio no sabe de express ni de PostgreSQL**. La capa web
traduce errores de dominio a HTTP, y la composición inyecta los adaptadores. Eso
es lo que permite testear todo el flujo sin servidor ni base.

---

## 1. Qué problema resuelve el módulo

- Ubicaciones de choferes (última posición, historial, búsqueda geográfica).
- Seguimiento en tiempo real del viaje (SSE) con reconexión sin perder frames.
- Tarea pesada obligatoria (historial) con versión ingenua vs versión final.
- Métricas y scripts de carga para demostrar las mediciones del bloque 7.

---

## 2. Mapa de archivos (para ubicarte rápido)

| Archivo | Rol |
|---|---|
| `src/dominio/ubicaciones/geo.js` | Fórmula y validación geográfica PURA |
| `src/dominio/ubicaciones/candidatos.js` | Regla única de "qué es un candidato válido" + orden/desempate |
| `src/dominio/ubicaciones/servicios.js` | Casos de uso (orquestan puertos) |
| `src/dominio/ubicaciones/puertos.js` | Contratos (JSDoc) + `verificar*` en runtime |
| `src/dominio/ubicaciones/errores.js` | Errores de dominio con `codigo` estable |
| `src/infra/db/servicio-geo-postgis.js` | Adaptador FINAL (GiST + KNN) |
| `src/infra/db/servicio-geo-ingenuo.js` | Adaptador INGENUO (trae todo, calcula en JS) |
| `src/infra/memoria/servicio-geo-memoria.js` | Adaptador memoria (tests) |
| `src/infra/db/repositorio-ubicaciones-pg.js` | UPSERT + historial por lote (`unnest`) |
| `src/infra/memoria/repositorio-ubicaciones-memoria.js` | Igual en memoria, réplica de idempotencia |
| `src/infra/memoria/cola-historial-memoria.js` | Cola + flush por lotes (tarea pesada) |
| `src/infra/memoria/bus-eventos-memoria.js` | Bus con log acotado (Last-Event-ID) |
| `src/infra/memoria/registro-metricas-memoria.js` | Percentiles nearest-rank |
| `src/infra/http/rutas/ubicaciones.js` | Rutas express + zod estricto + `MAPEO_HTTP` |
| `src/infra/http/metricas.js` | Middleware de latencia + lag de event loop |
| `migraciones/200_ubicaciones.sql` | Tablas, índices GiST, función de purga |
| `scripts/carga/simulador-choferes.js` | 500 choferes enviando cada 2 s |
| `scripts/carga/carga-autocannon.js` | Carga de fuego (`--health`, `--ubicacion`) |
| `tests/dominio/*.test.js` + `tests/seguridad/ubicaciones-http.test.js` | 158 tests |

---

## 3. Reglas de dominio (los "por qué" que tenés que poder decir)

### 3.1 `geo.js` — matemática pura, sin dependencias

- Dominio habla en **grados WGS84** y **metros**. No conoce `geometry`/`geography`.
- Fórmula: **Haversine** (esfera). Para radio urbano de pocos km el error vs
  elipsoide es < 0,5 %: no justifica complejidad. Es **determinista**, por eso se
  puede testear sin base.
- Constante `RADIO_MEDIO_TIERRA_METROS = 6371008.8` (radio medio IUGG), en un solo
  lugar para cambiarla sin tocar el resto.
- `validarPunto` devuelve SIEMPRE un objeto nuevo → no se expone memoria interna.
- `distanciaHaversineMetros` hace clamp `Math.min(1, sqrt(h))` para evitar que
  `asin` reciba `1+ε` y devuelva `NaN` (defensa numérica).
- `validarRadio`: número finito > 0 (admite decimales). `validarLimite`: entero > 0.

> Nota para la defensa: **los adaptadores pueden diferir en metros de borde** —
> Haversine es esfera, PostGIS `geography` es elipsoide. Por eso los tests de
> integración usan tolerancia, no igualdad exacta.

### 3.2 `candidatos.js` — UNA regla para los tres adaptadores

`seleccionarCandidatos` es la regla de negocio compartida por PostGIS, ingenuo y
memoria:
- PostGIS filtra y ordena **en la base**; ingenuo trae todos y llama a esta
  función; memoria la usa sobre su mapa. Así el resultado no puede divergir.
- El **filtro por radio** usa la distancia sin redondear (para no incluir/excluir
  por 1 m de error de redondeo), y la **salida** se redondea a entero (resultado
  determinista y comparable).
- El borde exacto (`distancia == radio`) **es válido** (igual que "distanciaMaxima" en tarifa).
- **Orden determinista**: por distancia y, a igualdad, por `choferId`
  (`localeCompare`). Esto evita *flakiness* en tests con empates.
- Acepta candidatos como `{choferId, lat, lng}` o `{id, ubicacion:{lat,lng}}`.

### 3.3 `servicios.js` — los cuatro casos de uso

- **`cambiarDisponibilidadChofer`**: el chofer debe existir Y estar `habilitado`;
  si está inhabilitado o no existe → `ErrorNoEncontrado` (NO revelas cuál de los
  dos es; seguridad por no filtración de existencia).
- **`registrarUbicacionChofer`** (el corazón): valida punto → verifica chofer
  disponible → **UPSERT** de posición actual → busca viaje activo → **ENCOLA**
  historial → publica a SSE del viaje si hay viaje activo. El request devuelve
  apenas encoló (202).
- **`autorizarSeguimiento`**: regla de autorización por recurso — solo el pasajero
  dueño ve al chofer; solo el chofer asignado ve al pasajero. Cualquier otro:
  `RECURSO_AJENO`. Tabla `ROLES_SEGUIMIENTO` documenta quién ve qué.
- **`construirSeguimiento`** (snapshot): según rol expone la posición de la
  contraparte, nunca la propia. La "posición del pasajero" es el **origen del
  viaje** (el pasajero no reporta ubicación por esta API): límite documentado.

### 3.4 `errores.js`

- Base `ErrorDominio` con `codigo` estable para que la capa web traduzca sin
  inspeccionar mensajes.
- Jerarquía: `ErrorDatosInvalidos` ← `ErrorCoordenadaInvalida`.
- Se define una base **propia** (no se importa la de viajes) a propósito: los
  módulos de dominio no se acoplan entre sí; la composición conoce a los dos.

---

## 4. Puertos (`puertos.js`) — el "qué", nunca el "cómo"

Puertos definidos: `ServicioGeo`, `RepositorioUbicaciones`, `RepositorioChoferes`,
`RepositorioViajes` (solo lectura), `BusEventos`, `ColaHistorial`,
`RegistroMetricas` (+ `NOMBRES_PUERTOS`).

Truco defendible: **JS + JSDoc + verificación en runtime**. En vez de TypeScript
(decisión del equipo: JavaScript), cada puerto tiene una función `verificarX` que
valida al arrancar que el adaptador implementa los métodos. **Un adaptador mal
cableado falla al levantar, no en medio de un request** ("fail closed").

---

## 5. Búsqueda geográfica — los 3 adaptadores y por qué

| Adaptador | Idea | Uso |
|---|---|---|
| **PostGIS** (final) | `geography(Point,4326)` + GiST + `ST_DWithin` + KNN `<->` + `LIMIT` | Producción |
| **Ingenuo** (a propósito mala) | `SELECT` trae TODOS los disponibles y calcula Haversine en JS | Sólo para medir el delta |
| **Memoria** | recibe `listarCandidatos` inyectado y aplica la misma regla | Tests / arranque sin base |

### 5.1 Por qué `geography` y no `geometry` (pregunta clásica de defensa)

- Con `geometry` puro, `ST_DWithin` interpreta el radio en **grados** → depende de
  la latitud. Con `geography` el radio va en **metros sobre el elipsoide**, que es
  la unidad del dominio.
- `geography` es apta para el índice **GiST**.
- El plan (que validamos) es: `Index Scan using idx_ubicaciones_actuales_geom` con
  `Index Cond: (geom && _st_expand(...))` y `Order By: (geom <-> ...)` → PostGIS
  descarta por bounding-box y entrega los más cercanos sin calcular la distancia
  de todos (KNN).

### 5.2 Orden de parámetros (trampa clásica)

PostGIS usa **(x=lng, y=lat)**. Los parámetros del adaptador son
`[lng, lat, radioMetros, limite]`. Está comentado en el código porque es una fuente
típica de bugs latitudinales.

### 5.3 Por qué es mala la versión ingenua (para defender las mediciones)

1. Transfiere **N filas** a Node (I/O + memoria) aunque pidan 5.
2. El filtro + Haversine en JS **bloquea el event loop** con miles de choferes.
   A propósito **no** se le puso índice ni `LIMIT` en SQL: sería trampa para las
   mediciones.

> ADR-001 documenta las alternativas descartadas: Postgres sin PostGIS (acos/sin
> por fila), geohash por celdas (error de borde, sin KNN sobre string), en memoria
> (bloquea y duplica memoria).

---

## 6. Persistencia — UPSERT, idempotencia y lote

### 6.1 `ubicaciones_actuales` (estado presente)

- Una fila por chofer → PK `chofer_id`. `actualizarActual` es **UPSERT atómico**
  `ON CONFLICT (chofer_id) DO UPDATE`. Un `SELECT + UPDATE` tendría condición de
  carrera si dos envíos del mismo chofer llegan juntos; el UPSERT lo resuelve en
  una sola sentencia.

### 6.2 `ubicaciones_historial` (crudo, append-only) — idempotencia

- **UNIQUE `(chofer_id, timestamp)`** + `ON CONFLICT DO NOTHING`.
- Si el cliente reintenta el mismo POST (red caída, retry), **no duplica**.
- Defensa importante: el enunciado exige Idempotency-Key en "operaciones que crean
  o cobran". Este POST es **telemetría de un sender propio**, y tiene **clave
  natural** `(chofer_id, timestamp)`, que juega el rol de la idempotencia **sin**
  mantener una tabla de Idempotency-Key que crecería sin límite con 250 eventos/s.
- Además el simulador manda el mismo `timestamp` en un tick → si reintenta, la DB
  descarta. (Está en ADR-002.)

### 6.3 Historial por lote (`unnest`)

```sql
INSERT INTO ubicaciones_historial (viaje_id, chofer_id, geom, timestamp)
SELECT ... FROM unnest($1::text[], $2::text[], $3::float8[], $4::float8[], $5::timestamptz[])
AS lote(viaje_id, chofer_id, lng, lat, ts)
ON CONFLICT (chofer_id, timestamp) DO NOTHING;
```

- Un INSERT de 200 filas ≈ **200× menos** parseo/WAL/fsync que 200 INSERT sueltos.
- La geometría se arma en la base con `ST_MakePoint(lng, lat)` desde parámetros,
  **nunca** como WKT intercalado en el string (SQL 100 % parametrizado).

---

## 7. Tarea pesada (obligación del bloque 7) — cola + batching

### 7.1 El problema numérico

500 choferes × 1 ubicación / 2 s → **~250 INSERT/s sostenidos** en el historial.
Si eso va dentro del request (versión ingenua):

- la latencia de `/ubicacion` incluye el round-trip a la DB;
- la base paga una transacción de una fila por envío.

### 7.2 La solución final

`POST /choferes/me/ubicacion` dentro del request hace lo **mínimo**:

1. valida + verifica chofer disponible;
2. UPSERT de `ubicaciones_actuales` (esto SÍ debe estar al día);
3. **ENCOLA** el historial en `ColaHistorial` (O(1));
4. publica al SSE del viaje activo si existe → responde **202**.

Un worker (intervalo configurable o umbral `maxLote=200`) hace flush por lotes
con `agregarHistorialEnLote` (el `unnest` de 6.3).

### 7.3 Diseño de la cola (detalles que demuestran cuidado)

- `flush()` toma el buffer y lo **vuelve `[]` ANTES** del `await`, y guarda la
  promesa en `enFlush`: así un `encolar` que llega durante el flush no pierde el
  lote (nada queda huérfano).
- `drenar()` espera el flush en curso y vacía todo lo pendiente (se usa en
  **SIGTERM** para apagado ordenado y en tests).
- El temporizador hace `unref()`: no mantiene vivo el proceso solo por la cola.
- Un lote que falla (`catch(() => 0)`) no tumba la cola; lo siguiente lo vuelve a
  intentar.
- `detener()` limpia el intervalo.

### 7.4 Versiones descartadas (para defender el descarte)

- **Chunking**: no hay cómputo grande que dividir, hay I/O de base.
- **Streams**: no batcha entre requests distintos y complica el ciclo de vida
  (¿cuándo se cierra? ¿qué pasa en SIGTERM?).
- **worker_threads**: el cuello NO es CPU (JSON + coordenadas es barato), es el
  round-trip a la base; un worker no mejora eso, y habría que mover igualmente la
  conexión. Coste/beneficio malo.

### 7.5 Riesgo aceptado (ser honesto en la defensa)

Cola en memoria = **se pierde lo no flusheado si el proceso muere**. Se acepta
porque es telemetría: la posición es efímera y se reenvía cada 2 s. Lo crítico
(UPSERT de posición actual) es síncrono.

---

## 8. Capa HTTP (`rutas/ubicaciones.js`)

### 8.1 zod estricto = requisito + seguridad

- Todos los esquemas usan `.strict()`: **cualquier campo no declarado → 400**.
- Eso cubre el requisito de "campos no declarados se rechazan" Y de paso mata el
  **prototype pollution** (`__proto__`, `constructor.prototype`) → hay tests que lo
  demuestran.
- `esquemaTimestamp` acepta millis de epoch (int ≥ 0) o un string con fecha
  parseable (refine con `Date.parse`).
- `validar()` traduce issues de zod a un `ErrorDatosInvalidos` con los mensajes
  resumidos → el handler global de errores tiene UN solo formato.

### 8.2 Formato de error + `MAPEO_HTTP`

```
{ "error": { codigo, mensaje, idCorrelacion } }
```

`MAPEO_HTTP` es el contrato del módulo para el middleware global:

| codigo | HTTP |
|---|---|
| DATOS_INVALIDOS / COORDENADA_INVALIDA | 400 |
| NO_ENCONTRADO | 404 |
| RECURSO_AJENO / ROL_NO_AUTORIZADO | 403 |
| CHOFER_NO_DISPONIBLE / TRANSICION_INVALIDA | 409 |

### 8.3 Rutas

| Ruta | Quién | Qué hace |
|---|---|---|
| `PUT /choferes/me/disponibilidad` | chofer | setea disponibilidad (valida habilitado) |
| `POST /choferes/me/ubicacion` | chofer + **rate limit propio** | encola + UPSERT + SSE → **202** |
| `GET /viajes/:id/estado` | pasajero/chofer del viaje | snapshot del seguimiento |
| `GET /viajes/:id/seguimiento` | pasajero/chofer del viaje | **SSE** |
| `GET /viajes/:id/recorrido` | pasajero/chofer del viaje | historial del viaje |
| `GET /metricas` | **solo administrador** | percentiles + lag + memoria |

Detalles:
- `exigirRol` chequea `req.actor.rol` (el actor lo pone el middleware de
  autenticación, que en los tests se simula con headers).
- **Fallar cerrado**: `crearRutasUbicaciones` exige TODAS las dependencias; si la
  composición olvida el rate limit o la autenticación, **no arranca**.
- Rate limit inyectado (no hardcodeado) porque estrategia y store los decide la
  composición; el comentario del código exige clavar por **actor** (
  `keyGenerator: (req) => req.actor.id ?? req.ip`) porque detrás de un proxy/NAT
  comparten IP muchos choferes y se bloquearían entre sí.
- 202 en vez de 200 deja explícito que la persistencia pesada es asíncrona.

### 8.4 Autorización ANTES de abrir el stream

En SSE, si el actor no participa del viaje, responde **403 JSON antes del primer
byte** del stream. Un stream ya abierto no cambia de autenticación (el actor quedó
fijado). En `recorrido`, un viaje ajeno → 403; un viaje inexistente → 404 (no
filtras existencia).

---

## 9. Tiempo real — SSE (ADR-003)

Por qué **SSE y no WebSocket**: el canal es unidireccional (servidor→cliente); el
pasajero/chofer NO manda mensajes por este canal (las ubicaciones entran por POST).
WebSocket aporta bidireccionalidad que no usamos y exige protocolo propio,
heartbeat manual y resume manual. SSE trae reconexión nativa con `Last-Event-ID`.

Mecánica del stream:
- `Content-Type: text/event-stream` + `X-Accel-Buffering: no` (para que un proxy
  no bufferize).
- Frame inicial `event: snapshot` con `construirSeguimiento`.
- Heartbeat `: ping` cada **15 s** (`unref`), para detectar peers muertos y
  mantener el puerto del proxy.
- **Timeout duro de 1 h**: un streaming infinito es una fuga de sockets; el cliente
  se reconecta solo.
- **Orden crítico en reconexión**: se SUSCRIBE ANTES de reenviar los pendientes,
  para no perder lo que llegue mientras tanto. El caso borde (evento duplicado)
  lo absorbe el cliente con el `id` y porque las posiciones son idempotentes.
- `Last-Event-ID` se lee del header (fallback en query para testeos).

### 9.1 El bus (`bus-eventos-memoria.js`)

- `publicar(canal, evento)` con **log acotado por canal** (`capacidadPorCanal=500`)
  y contador monótono. Un log infinito sería una fuga de memoria.
- `eventosDesde(canal, ultimoId)`: devuelve lo posterior a un id; si el id es
  corrupto, no revienta la conexión (ignora y devuelve el log).
- Cada suscriptor se aísla en try/catch: uno que falla no rompe a los demás.
- Si el último id es más viejo que la ventana, el snapshot (`/estado`) cubre el gap.

---

## 10. Métricas (`metricas.js` + `registro-metricas-memoria.js`)

- **Percentiles nearest-rank** (no interpola): sobre la muestra ordenada,
  `índice = ceil(p/100 * n) - 1`. Simple, determinista, fácil de defender.
- Capacidad acotada (100 000 muestras): ventana móvil, no histórico infinito.
- Se ordena una **copia** al consultar (no destruye el orden de llegada).
- `monitorEventLoopDelay` (node:perf_hooks) mide el **lag del event loop**:
  `max` y `percentile(99)`. Con la tarea pesada síncrona se dispara; con la cola
  no. Es el instrumento que justifica las hipótesis de mediciones.
- `GET /metricas`: p50/p95/p99/max de latencia aplicando el middleware + lag +
  RSS/heap. Solo rol `administrador`.

---

## 11. Migración (`migraciones/200_ubicaciones.sql`)

- `ubicaciones_actuales (chofer_id PK, geom GEOGRAPHY(Point,4326), timestamp)`
  + índice GiST `idx_ubicaciones_actuales_geom`.
- `ubicaciones_historial (id BIGSERIAL, viaje_id FK SET NULL, chofer_id FK,
  geom, timestamp)` + UNIQUE natural + índices por `(viaje_id, timestamp)` y por
  `timestamp` (para la retención).
- Función `purgar_ubicaciones_historial(dias)` (política de retención de **90 días**,
  ver `docs/ubicaciones-retencion.md`): valida `dias>0` y devuelve cuántas borró.
- Depende de tablas 1xx (`choferes`, `viajes`) que crea otro módulo.

### 11.1 Validación REAL (hecha contra PostGIS 16 en Docker)

Ejecutada en base temporal `movilidad_sqlcheck` (con stubs de `choferes`/`viajes`):

- UPSERT de posición actual → queda 1 fila, gana la última. ✔
- Lote con duplicado `(chofer_id, timestamp)` → descarta el duplicado. ✔
- KNN + `ST_DWithin` + `LIMIT` → candidatos con distancia en metros. ✔
- Con 2 000 filas, `EXPLAIN` muestra `Index Scan using idx_ubicaciones_actuales_geom`. ✔
- `purgar_ubicaciones_historial(90)` borra solo lo anterior; rechaza `dias<=0`. ✔

---

## 12. Seguridad (tests que lo prueban)

- **403 por recurso ajeno**: chofer no asignado o pasajero distinto no ven el
  seguimiento ni el recorrido; operador sin viaje asignado tampoco.
- **404 en vez de 403** para un viaje inexistente (no filtras existencia).
- **zod `.strict()`**: campo no declarado → 400.
- **Prototype pollution**: cuerpo con `__proto__` o `constructor.prototype` → 400
  y no contamina `Object.prototype`.
- **SQL injection**: un id con `'; DROP TABLE ...; --` termina como 404 de
  recurso inexistente (todo es parametrizado).
- **Rate limit propio** de `/ubicacion` → 429 con header informativo.
- **SSE**: chofer no asignado no puede suscribirse (403).

---

## 13. Carga y mediciones

### 13.1 `simulador-choferes.js`

- Genera `CANTIDAD_CHOFERES` (default 500) en un mapa alrededor de Resistencia,
  Chaco, con **deriva suave** (rumbo que cambia de vez en cuando → movimientos
  realistas, no rectas).
- Coincidencia de timestamps por tick (para probar la idempotencia real en la DB).
- `Promise.allSettled`: un fallo puntual no corta el lote.
- Autenticación: si hay `JWT_SECRETO` **firma sus propios JWT** `{sub, rol:'chofer'}`
  con el secreto del servidor; si no, manda `BATCH_TOKEN_HOLDER` tal cual (demo).
- Declara a los choferes disponibles al arrancar (`PUT disponibilidad`) salvo
  `SKIP_DISPONIBILIDAD=1`. **No crea cuentas**: los `sim-chofer-N` deben existir
  (decisión documentada).

### 13.2 `carga-autocannon.js`

- `--health` → mide el endpoint LIVIANO mientras el simulador carga el sistema
  (ahí se ve el impacto de la tarea pesada en la latencia de lo que no debería
  degradarse). `--ubicacion` mide directo el endpoint caliente.
- `DURACION_S` default 30 (mínimo exigido), `CONEXIONES` default 20.

### 13.3 Protocolo de medición (docs/mediciones.md)

- Hipótesis NUMÉRICAS escritas ANTES de medir (5 hipótesis: p95 3×, lag > 50 ms,
  búsqueda 10×, etc.).
- Para conmutar versión ingenua/final se toca **solo `src/composicion.js`**
  (`colaHistorial: null` vs inyectado) — archivo compartido, no de este módulo.
- 3 repeticiones de ≥ 30 s por versión, 10 s de enfriamiento, se informa media +
  peor corrida, y reportes p50/p95/p99 de `/health`, req/s, lag máx/p99 y RSS.
- Entorno aún sin completar; el contenedor quedó arriba en **puerto 5439**
  (5432/5433 ocupados por Postgres locales). Para la app apuntar al contenedor:
  `DB_PUERTO=5439` en `.env`.

---

## 14. Pruebas — qué demuestra cada suite (158 tests)

| Suite | Cubre |
|---|---|
| `tests/dominio/geo.test.js` | validación de rangos, NaN/Infinity, bordes exactos, Haversine, simetría, radio/limite |
| `tests/dominio/candidatos.test.js` | filtro por radio, orden, desempate, límite, formas alternativas, errores |
| `tests/dominio/servicios-ubicaciones.test.js` | disponibilidad, registro OK / no disponible / duplicado, snapshot por rol, SSE del viaje activo, autorización |
| `tests/dominio/adaptadores-memoria.test.js` | repositorios memoria, bus (reconexión, aislamiento de suscriptores), cola (sin pérdida, drenar), métricas, **SQL parametrizado** |
| `tests/seguridad/ubicaciones-http.test.js` | todo el mapa de rutas con Express real: roles, 403/404, zod strict, prototype pollution, SQL injection, 429, idempotencia, SSE con Last-Event-ID, /metricas solo admin |

Comando: **`node --test`** desde la raíz (sin argumentos). Ojo: `node --test
tests/dominio` falla por resolución de módulos; siempre desde la raíz.

---

## 15. Frases cortas para la defensa (cheat-sheet)

- **¿Por qué PostGIS?** → índice GiST + filtro y orden en la base; `geography`
  da metros reales sobre elipsoide; una sola sentencia parametrizada.
- **¿Por qué 3 adaptadores?** → el bloque 7 obliga a medir el delta (ingenuo vs
  final); el de memoria permite testear sin base.
- **¿Por qué cola + batching?** → ~250 INSERT/s; un lote de 200 ≈ 200× menos
  costo de WAL/fsync; el request responde 202 apenas encola.
- **¿Por qué queda síncrono el UPSERT?** → la posición actual es "estado
  presente" (debe estar al día); el historial es "crudo histórico" y tolera atraso.
- **¿Idempotencia?** → clave natural `(chofer_id, timestamp)` + `ON CONFLICT DO
  NOTHING`; telemetría no necesita tabla de Idempotency-Key.
- **¿SSE y no WebSocket?** → unidireccional; reconexión nativa con
  `Last-Event-ID`; cero dependencias nuevas.
- **¿Permitiste perder datos con la cola?** → sí, a propósito: telemetría
  efímera que se reenvía cada 2 s; lo crítico es síncrono y `drenar()` cubre
  SIGTERM.
- **¿Cómo autorizás?** → por recurso, en el dominio, SIEMPRE en el servidor:
  pasajero→chofer, chofer→pasajero, resto→`RECURSO_AJENO` (403 o 404).
- **¿Seguridad?** → zod `.strict()` (campos no declarados = 400, además mata
  prototype pollution), SQL 100 % parametrizado, rate limit por actor, y tests
  que prueban cada ataque.

---

## 16. Notas para no olvidar

- El dominio de este módulo **no importa ni express ni pg** (verificado con grep).
- No se tocaron archivos compartidos: `src/composicion.js`, `src/servidor.js`,
  `package.json`, `README.md`, dominio de viajes.
- Commit de todo módulo: `00125cf` en rama `feat/ubicaciones`.
- Si te preguntan cómo sé que la migración anda: ya la **ejecuté contra PostGIS
  real** (PostgreSQL 16 + PostGIS 3.4, contenedor `movilidad-db`, puerto 5439) y
  el plan usa el índice GiST.
- La app aún NO arranca contra Postgres: falta que `composicion.js` inyecte
  `consulta`, autenticación real, `rateLimitUbicacion` (clave por `req.actor.id`)
  y el job de retención. Eso es del equipo, no de este módulo.

---

## 17. Pendientes del equipo (para coordinarse, no para hacer este módulo)

1. `composicion.js`: cablear `crearRutasUbicaciones` con los adaptadores reales y
   los `verificar*` de `puertos.js`.
2. Migraciones 1xx (`choferes`, `viajes`) + runner que las aplique en orden.
3. `.env` con `DB_PUERTO=5439` si se usa el contenedor PostGIS (host 5432 está
   ocupado por un Postgres local).
4. `docs/mediciones.md`: completar entorno (CPU/RAM/SO), correr las 3 repeticiones
   y llenar las tablas + conclusión contra las hipótesis.
5. Configuración de lint todavía no existe en el repo.