# API

Base: `http://localhost:3000`. Cuerpos en JSON. Importes en **centavos
enteros**. Ids en UUID. Las rutas autenticadas piden
`Authorization: Bearer <jwt>` (se obtiene en `POST /auth/login`).

La colección de requests de la demo está en `docs/demo.http` (formato `.http`,
se abre con la extensión REST Client de VS Code o con JetBrains).

## Convenciones

**Formato de error** (todas las rutas):

```json
{ "error": { "codigo": "VIAJE_NO_ENCONTRADO", "mensaje": "El viaje solicitado no fue encontrado.", "idCorrelacion": "6f1c…" } }
```

`idCorrelacion` es el mismo valor que el encabezado `X-Request-Id` de la
respuesta y que aparece en los logs. Si el cliente manda un `X-Request-Id`
válido, se respeta.

| Status | Cuándo |
|---|---|
| 400 | Entrada inválida (`DATOS_INVALIDOS`, `JSON_INVALIDO`). Los esquemas son estrictos: un campo no declarado es 400 |
| 401 | Sin token o token inválido (`NO_AUTENTICADO`, `CREDENCIALES_INVALIDAS`) |
| 403 | El rol no alcanza para la ruta (`ROL_NO_AUTORIZADO`) |
| 404 | Recurso inexistente **o ajeno**: misma respuesta, para no confirmar que existe |
| 409 | Conflicto de estado (`TRANSICION_INVALIDA`, `OFERTA_NO_VIGENTE`, `CHOFER_OCUPADO`, `YA_COBRADO`, `CLAVE_REUTILIZADA`…) |
| 413 | Cuerpo mayor a `LIMITE_CUERPO_BYTES` |
| 422 | `VIAJE_FUERA_DE_LIMITE`: el viaje supera la distancia máxima cotizable |
| 429 | Rate limit (login por IP; ubicación por chofer). Con encabezados `RateLimit-*` |
| 503 | `/ready`: base caída o migraciones pendientes |

**Idempotencia**: `POST /viajes` y `POST /viajes/:id/cobro` exigen
`Idempotency-Key` (1 a 64 caracteres). Repetir el pedido con la misma clave
devuelve la respuesta original sin repetir el efecto; la misma clave con otro
cuerpo es `409 CLAVE_REUTILIZADA`.

## Infraestructura

| Método y ruta | Acceso | Respuesta |
|---|---|---|
| `GET /health` | público | `200 {"estado":"ok"}` |
| `GET /ready` | público | `200 {"estado":"listo"}` o `503 NO_LISTO` |
| `GET /metrics` | público (o Bearer `METRICAS_TOKEN`) | Métricas en formato Prometheus |
| `GET /metricas` | administrador | JSON: latencias p50/p95/p99, lag del event loop (ms), memoria (MB). `?reiniciar=1` abre una ventana nueva |

## Identidad

| Método y ruta | Acceso | Cuerpo → Respuesta |
|---|---|---|
| `POST /auth/registro/pasajero` | público | `{email, password, nombre}` → `201` perfil |
| `POST /auth/registro/chofer` | público | `{email, password, nombre, vehiculo:{patente, marca, modelo, color}}` → `201` perfil (queda **sin habilitar**) |
| `POST /auth/login` | público, rate limit | `{email, password}` → `200 {token, usuario}` |
| `GET /me` | autenticado | perfil propio |

## Administración (rol administrador)

| Método y ruta | Cuerpo → Respuesta |
|---|---|
| `GET /admin/choferes?habilitado=true\|false` | `{choferes:[…]}` |
| `PATCH /admin/choferes/:id/habilitacion` | `{habilitado}` → chofer |
| `GET\|PUT /admin/tarifas` | `{bajadaBanderaCentavos, precioKmCentavos, precioMinutoCentavos}` |
| `GET\|PUT /admin/zonas` | `{nombre, multiplicador, activa}` |
| `GET\|PUT /admin/parametros` | catálogo cerrado: `tiempo_limite_oferta_s`, `umbral_reasignacion_s`, `radio_busqueda_m`, `tarifa_minima_centavos`, `distancia_maxima_m`, `max_candidatos` |

## Viajes

### Pedido

| Método y ruta | Acceso | Cuerpo → Respuesta |
|---|---|---|
| `POST /viajes/estimacion` | pasajero | `{origen:{lat,lng}, destino:{lat,lng}}` → `200 {distanciaMetros, duracionSegundos, precioCentavos}` |
| `POST /viajes` | pasajero, `Idempotency-Key` | mismo cuerpo → `201 {id, estado}`. `estado` es `solicitado` (se ofreció a un chofer) o `sin_choferes` |
| `GET /viajes/:id` | dueño, chofer asignado, operador, administrador | `{id, estado}` |
| `GET /viajes/:id/eventos` | dueño, cualquier chofer que haya tenido el viaje, operador, administrador | `{eventos:[{evento, actor, desde, hacia, motivo, en}]}` |

### Ofertas (chofer)

| Método y ruta | Respuesta |
|---|---|
| `GET /choferes/me/ofertas` | `{ofertas:[{id, viajeId, expiraEn}]}`: solo propias, pendientes y vigentes |
| `POST /ofertas/:id/aceptar` | `{viajeId, ofertaId, estado:"asignado"}`. `409 OFERTA_NO_VIGENTE` si otro ganó o venció; `409 CHOFER_OCUPADO` si ya tiene un viaje |
| `POST /ofertas/:id/rechazar` | `{viajeId, estado}`: se ofrece al siguiente candidato o el viaje pasa a `sin_choferes` |

Cada oferta vence a los `tiempo_limite_oferta_s` segundos. El vencimiento lo
hace un worker del servidor (`src/workers/vencimiento-ofertas.js`), así que
ocurre **aunque el chofer haya cerrado la app**: pasa al siguiente candidato y,
si no queda ninguno, el viaje queda en `sin_choferes`.

### Ciclo de vida

| Método y ruta | Acceso | Transición |
|---|---|---|
| `POST /viajes/:id/en-camino` | chofer asignado | `asignado → chofer_en_camino` |
| `POST /viajes/:id/iniciar` | chofer asignado | `chofer_en_camino → en_curso` |
| `POST /viajes/:id/finalizar` | chofer asignado | `en_curso → finalizado`; calcula la tarifa final |
| `POST /viajes/:id/cancelar` | pasajero dueño (`cancelado_pasajero`) o chofer asignado (`cancelado_chofer`) | cuerpo opcional `{motivo}` |
| `POST /operador/viajes/:id/cancelar` | operador | `{motivo}` obligatorio; cualquier estado no terminal → `cancelado_pasajero` |

Respuesta: `{id, estado, tarifaFinalCentavos, motivoCierre}`. Una transición
que no está en la tabla de la máquina de estados es
`409 TRANSICION_INVALIDA`. Al llegar a un estado terminal se cierra la
asignación (el chofer queda libre) y se cancelan las ofertas pendientes.

### Tarifa: estimada vs final

Las dos salen de la **misma función**, `calcularTarifa`
(`src/dominio/viajes/tarifa.js`): tarifa base + distancia × precio por km +
duración × precio por minuto, con tarifa mínima y distancia máxima, en enteros
(centavos) y con redondeo half-up por componente.

| | Distancia | Duración |
|---|---|---|
| Estimación | Línea recta origen → destino (haversine) | Esa distancia a 30 km/h |
| Final | **Recorrida**: polilínea de las ubicaciones del chofer desde que inició el viaje (PostGIS `ST_Length`) | **Real**: de `iniciar` a `finalizar` |

La diferencia entre las dos se explica entonces por el recorrido real (desvíos,
calles en vez de línea recta) y por el tiempo real (tránsito, esperas). Si no
hay al menos dos ubicaciones del viaje, la final usa la distancia estimada. La
distancia final se acota a la máxima cotizable: un viaje ya hecho no puede
fallar al cobrarse por un desvío.

### Cobro (simulado)

| Método y ruta | Acceso | Respuesta |
|---|---|---|
| `POST /viajes/:id/cobro` | pasajero dueño, `Idempotency-Key` | `201 {cobroId, viajeId, importeCentavos, estado:"aprobado"}` |

`409 VIAJE_NO_FINALIZADO` si el viaje no terminó; `409 YA_COBRADO` si ya se
cobró con otra clave. El reintento con la misma clave devuelve el mismo `201`.

### Historiales y panel del operador

| Método y ruta | Acceso | Respuesta |
|---|---|---|
| `GET /pasajeros/me/viajes?limite=20` | pasajero | `{viajes:[resumen]}`, más recientes primero |
| `GET /choferes/me/viajes?limite=20` | chofer | `{viajes:[resumen]}`: todo viaje en el que tuvo una asignación (incluso si se lo reasignaron) |
| `GET /operador/viajes?estado=&limite=` | operador, administrador | viajes no terminales, más antiguos primero |

Resumen: `{id, estado, origen, destino, tarifaEstimadaCentavos, tarifaFinalCentavos, motivoCierre, creadoEn, actualizadoEn}`.

## Ubicaciones y seguimiento

| Método y ruta | Acceso | Cuerpo → Respuesta |
|---|---|---|
| `PUT /choferes/me/disponibilidad` | chofer habilitado | `{disponible}` → `{choferId, disponible}` |
| `POST /choferes/me/ubicacion` | chofer disponible, rate limit por chofer | `{lat, lng, timestamp}` → `202 {encolado:true}` |
| `GET /viajes/:id/estado` | pasajero dueño, chofer asignado | snapshot: `{viajeId, estado, rol, posicionContraparte}` |
| `GET /viajes/:id/seguimiento` | pasajero dueño, chofer asignado | stream SSE |
| `GET /viajes/:id/recorrido` | pasajero dueño, chofer asignado | `{viajeId, recorrido:[{lat,lng,timestamp}]}` |

Un viaje ajeno responde **403** en estas rutas (hallazgo documentado en
`tests/seguridad/ubicaciones-privacidad.test.js`).

### Eventos del SSE (`GET /viajes/:id/seguimiento`)

| `event:` | `data:` | Quién lo recibe |
|---|---|---|
| `snapshot` | `{viajeId, estado, rol, posicionContraparte}` | al conectarse |
| `estado` | `{viajeId, estado}` | pasajero y chofer, en cada transición |
| `posicion` | `{choferId, lat, lng, timestamp}` | **solo el pasajero** |
| `reasignado` | `{viajeId, estado}` | pasajero (variante H) |
| `acceso_revocado` | `{viajeId}` | el chofer reemplazado; después se cierra el stream |

Cada evento tiene `id:`. Si la conexión se corta, el cliente reconecta con
`Last-Event-ID` y recibe lo que se perdió; además el primer evento de cada
conexión es un `snapshot` con el estado actual, así que nunca queda
desactualizado. El frontend lee el stream con `fetch` y el mismo Bearer que el
resto de la API (`web/src/api.js`).

## Reasignación (variante H)

| Método y ruta | Acceso | Respuesta |
|---|---|---|
| `POST /viajes/:id/rechazar-continuar` | chofer asignado | `{motivo}` → `{viajeId, estado, choferAnteriorId, choferNuevoId}` |
| `GET /viajes/:id/asignaciones` | pasajero dueño, operador, administrador | historial de choferes con `motivoFin` |

Además, un worker reasigna solo los viajes cuyo chofer no reporta ubicación
hace más de `umbral_reasignacion_s` (ver ADR-005).
