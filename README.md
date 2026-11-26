# app-movilidad-urbana

Plataforma de viajes urbanos en tiempo real (TP Programación IV · UTN FRRe ·
comisión 1 · grupo 8 · variante **H: reasignación ante fallas**).

Un pasajero pide un viaje, el sistema busca choferes disponibles cerca, les
ofrece el viaje y el primero que acepta lo toma; ambos siguen el estado y la
posición en tiempo real por SSE. Si el chofer asignado deja de reportar
ubicación o rechaza continuar, el viaje se reasigna solo.

Stack: Node.js 22 (ESM), Express 5, PostgreSQL 16 + PostGIS 3.4 (Docker
Compose), `node:test`.

## Arranque desde un clon limpio

Requisitos: Node.js 22 o superior y Docker.

```bash
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
# editar .env: DB_PASSWORD, JWT_SECRETO (32+ caracteres) y SEED_PASSWORD
npm ci
docker compose up -d          # PostgreSQL + PostGIS (crea también movilidad_test)
npm run setup                 # migraciones + usuarios del seed
npm run dev                   # API en http://localhost:3000
```

`npm run setup` deja un usuario conocido por rol, todos con la contraseña de
`SEED_PASSWORD`:

| Rol | Email | Nota |
|---|---|---|
| pasajero | `pasajero1@movilidad.invalid` | |
| pasajero | `pasajero2@movilidad.invalid` | para probar acceso a un viaje ajeno |
| chofer | `chofer1@movilidad.invalid` | habilitado |
| chofer | `chofer2@movilidad.invalid` | sin habilitar (para la demo del administrador) |
| operador | `operador1@movilidad.invalid` | |
| administrador | `admin1@movilidad.invalid` | |

Frontend de pasajero y chofer (React + Vite), en otra terminal:

```bash
npm run web:install           # una vez
npm run web:dev               # http://localhost:5173 (pasajero y chofer en pestañas distintas)
```

La API también corre dentro de Compose: `docker compose --profile app up -d --build`
(aplica migraciones al arrancar y se reinicia sola; ver
`docs/evidencia-recuperacion.md`).

Si falta o es inválida una variable de entorno, el servidor no arranca y dice
cuál (`src/config/index.js`).

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | API con recarga automática |
| `npm start` | API (producción) |
| `npm test` | **toda** la suite: dominio, integración, seguridad y concurrencia (necesita la base de test) |
| `npm run e2e` | pruebas E2E con Playwright (levanta API y frontend contra la base de test); reporte con `npx playwright show-report` |
| `npm run lint` | ESLint, incluida la regla que impide que `src/dominio` importe infraestructura |
| `npm run migrate` | aplica las migraciones pendientes |
| `npm run seed` | usuarios por rol |
| `npm run carga:seed` | 500 choferes y 50 pasajeros de carga (`-- --borrar` los quita) |
| `npm run carga:simulador` | 500 choferes enviando ubicación cada 2 s (`ACEPTAR_OFERTAS=1` para que acepten viajes) |
| `npm run carga:autocannon -- --health` | carga sobre un endpoint (`--health`, `--ready`, `--ubicacion`) |

Los tests de integración y concurrencia usan `DATABASE_URL_TEST`, que tiene
que apuntar a una base **distinta** de `DATABASE_URL` (Compose crea
`movilidad_test`); si son iguales, los tests se niegan a correr.

## Roles y permisos

Autenticación por JWT (`Authorization: Bearer <token>`, HS256) y contraseñas
con argon2id. Decisiones en `docs/adr/ADR-004-autenticacion-autorizacion.md`.

| Ruta | pasajero | chofer | operador | administrador |
|---|---|---|---|---|
| `POST /auth/registro/pasajero`, `POST /auth/registro/chofer` (el chofer queda **sin habilitar**) | público | público | público | público |
| `POST /auth/login` (rate limit propio) | público | público | público | público |
| `GET /me` | ✔ | ✔ | ✔ | ✔ |
| `POST /viajes/estimacion`, `POST /viajes` (con `Idempotency-Key`) | ✔ | ✖ | ✖ | ✖ |
| `GET /viajes/:id` | ✔ (dueño) | ✔ (asignado) | ✔ | ✔ |
| `GET /viajes/:id/eventos` | ✔ (dueño) | ✔ (si lo tuvo) | ✔ | ✔ |
| `GET /choferes/me/ofertas`, `POST /ofertas/:id/aceptar`, `/rechazar` | ✖ | ✔ (propias) | ✖ | ✖ |
| `POST /viajes/:id/en-camino`, `/iniciar`, `/finalizar` | ✖ | ✔ (asignado) | ✖ | ✖ |
| `POST /viajes/:id/cancelar` | ✔ (dueño) | ✔ (asignado) | ✖ | ✖ |
| `POST /viajes/:id/cobro` (con `Idempotency-Key`) | ✔ (dueño) | ✖ | ✖ | ✖ |
| `GET /pasajeros/me/viajes` / `GET /choferes/me/viajes` | ✔ (propios) | ✔ (propios) | ✖ | ✖ |
| `GET /operador/viajes`, `POST /operador/viajes/:id/cancelar` (con motivo) | ✖ | ✖ | ✔ | solo `GET` |
| `PUT /choferes/me/disponibilidad`, `POST /choferes/me/ubicacion` (rate limit por chofer) | ✖ | ✔ (habilitado) | ✖ | ✖ |
| `GET /viajes/:id/estado`, `/seguimiento` (SSE), `/recorrido` | ✔ (dueño) | ✔ (asignado) | ✖ | ✖ |
| `POST /viajes/:id/rechazar-continuar` (dispara la reasignación) | ✖ | ✔ (solo el asignado) | ✖ | ✖ |
| `GET /viajes/:id/asignaciones` (historial de choferes con motivo) | ✔ (dueño) | ✖ | ✔ | ✔ |
| `GET /admin/choferes`, `PATCH /admin/choferes/:id/habilitacion` | ✖ | ✖ | ✖ | ✔ |
| `GET\|PUT /admin/tarifas`, `/admin/zonas`, `/admin/parametros` | ✖ | ✖ | ✖ | ✔ |
| `GET /metricas` (JSON: latencias, lag del event loop, memoria) | ✖ | ✖ | ✖ | ✔ |
| `GET /health`, `GET /ready`, `GET /metrics` (Prometheus) | público | público | público | público |

- **dueño / asignado / propias** = autorización **por recurso** verificada en
  el servidor. Viajes, ofertas y asignaciones responden **404** ante un recurso
  ajeno, igual que ante uno inexistente, para no confirmar que existe (helper
  `autorizarRecurso`, `src/dominio/identidad/autorizacion.js`). El seguimiento
  de ubicaciones responde **403** ante un viaje ajeno; está documentado como
  hallazgo en `tests/seguridad/ubicaciones-privacidad.test.js`.
- El seguimiento solo lo ven los participantes actuales: tras una
  reasignación, el chofer reemplazado pierde el stream (`acceso_revocado`).
- `PUT /admin/parametros` edita, entre otros, `tiempo_limite_oferta_s` y
  `umbral_reasignacion_s` (variante H). El catálogo de parámetros es cerrado.
- `GET /metrics` exige `Authorization: Bearer` si se define `METRICAS_TOKEN`.

## Estructura

```
src/dominio/      reglas de negocio y puertos (sin Express, sin pg)
src/infra/        adaptadores: db (PostgreSQL), http (Express), memoria (tests), seguridad
src/workers/      reasignación (variante H) y retención del historial
src/composicion.js  único lugar que crea e inyecta adaptadores
src/servidor.js     escucha, arranca workers y apaga de forma ordenada
src/config/         configuración validada desde variables de entorno
migraciones/      SQL numerado: 001 base, 1xx viajes, 2xx ubicaciones, 3xx identidad
tests/            dominio, integracion, seguridad, concurrencia
web/              frontend de pasajero y chofer (React + Vite)
e2e/              pruebas E2E con Playwright (dos sesiones)
scripts/carga/    seed de carga, simulador de choferes, autocannon y mediciones
scripts/k6/       solicitud de viajes y tiempo hasta la asignación
observabilidad/   Grafana Alloy y dashboard
docs/             ADR, mediciones, modelo, API, evidencia de recuperación
```

## Observabilidad

- Logs JSON (pino) con el id de pedido propagado por `AsyncLocalStorage`; el
  mismo id vuelve en `X-Request-Id` y en todo cuerpo de error.
- `GET /metrics` en formato Prometheus: duración por patrón de ruta, lag del
  event loop, memoria, CPU, cola del historial y pool de PostgreSQL.
- Grafana Cloud: completar `GRAFANA_CLOUD_*` en `.env` y
  `docker compose --profile observabilidad up -d alloy`; importar
  `observabilidad/grafana/dashboard-movilidad.json`.

## Mediciones y carga

El informe está en `docs/mediciones.md`, con hipótesis, entorno, comandos
exactos y resultados de tres corridas por escenario. La versión ingenua y la
final se eligen sin tocar código: `HISTORIAL_MODO=directo|cola` y
`GEO_ESTRATEGIA=ingenua|postgis`.

## Integración continua

`.github/workflows/ci.yml` corre en cada PR: lint, `npm audit` de producción,
toda la suite contra PostGIS real, análisis estático de seguridad (CodeQL) y
las pruebas E2E con Playwright (con el reporte como artefacto).

## Dependencias y `npm audit`

`npm audit --omit=dev` no reporta vulnerabilidades (la CI falla si aparece una
alta o crítica). Quedan **3 moderadas solo en desarrollo**, en `autocannon`
(vía `hyperid` → `uuid`): se usa únicamente para generar carga en la máquina
de quien mide, no se instala en producción, y la corrección exige saltar a
autocannon 9 (versión mayor). Se revisará al actualizar las herramientas de
medición.

## Documentación

- `docs/adr/`: decisiones (módulos, persistencia, autenticación, asignación,
  reasignación, búsqueda geográfica, tarea pesada, SSE).
- `docs/api.md`: todas las rutas, errores, eventos del SSE y tarifa estimada vs final.
- `docs/demo.http`: colección de requests de la demo.
- `docs/temas-exposiciones.md`: concurrencia, idempotencia y autorrecuperación, con evidencia.
- `docs/mediciones.md`: informe de medición.
- `docs/evidencia-recuperacion.md`: recuperación ante fallas en Compose.
- `docs/modelo.md`: entidades, máquina de estados e invariantes.
- `docs/ataque.md`: bitácora del ataque cruzado (se completa en la semana de ataque).
