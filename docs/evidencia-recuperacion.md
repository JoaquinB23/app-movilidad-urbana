# Evidencia de recuperación de la app en Docker Compose

Qué se demuestra: la API corriendo en Compose se recupera sola de dos fallas
distintas, sin intervención manual, y el estado se ve desde afuera con
`/health` (proceso vivo) y `/ready` (base alcanzable y migraciones aplicadas).

Corrida del 2026-11-26 en Windows 11 + Docker Desktop, imagen `movilidad-api`
construida desde el `Dockerfile` del repo, `postgis/postgis:16-3.4`.

## Cómo levantarlo

```powershell
Copy-Item .env.example .env       # completar DB_PASSWORD, JWT_SECRETO, SEED_PASSWORD
docker compose --profile app up -d --build
docker compose ps                 # movilidad-api (healthy), movilidad-db (healthy)
```

Al arrancar, el contenedor de la API aplica las migraciones y recién después
escucha. Compose lo marca `healthy` cuando `GET /ready` responde 200.

## Falla 1: muere el proceso de la API

```powershell
docker inspect -f '{{.RestartCount}}' movilidad-api           # 0
docker exec movilidad-api node -e "process.kill(1, 'SIGTERM')"
docker logs movilidad-api | Select-String apagando, 'apagado completo'
docker inspect -f '{{.RestartCount}} {{.State.Health.Status}}' movilidad-api
```

Resultado observado:

| Momento | RestartCount | Estado | `/ready` |
|---|---|---|---|
| Antes | 0 | healthy | `{"estado":"listo"}` |
| Tras el SIGTERM | — | log `apagando` → `apagado completo` (apagado ordenado) | — |
| Después | 1 | healthy | `{"estado":"listo"}` |

La política `restart: unless-stopped` vuelve a levantar el contenedor; el
apagado previo fue ordenado (cerró conexiones, drenó la cola del historial y
cerró el pool).

## Falla 2: se cae la base de datos

```powershell
docker stop movilidad-db
curl.exe -i http://localhost:3000/ready     # 503 NO_LISTO
curl.exe -i http://localhost:3000/health    # 200 {"estado":"ok"}
docker start movilidad-db
# repetir /ready hasta que responda 200
docker inspect -f '{{.RestartCount}}' movilidad-api
```

Resultado observado:

| Momento | `/health` | `/ready` | Reinicios de la API |
|---|---|---|---|
| Base caída | 200 `ok` | **503** `NO_LISTO` | 1 (sin cambios) |
| Base de vuelta | 200 `ok` | 200 `listo` en ~2 s | 1 (sin cambios) |

La API **no se reinicia**: el pool descarta las conexiones muertas (queda en el
log `se perdio una conexion ociosa con PostgreSQL`) y abre otras cuando la
base vuelve.

### Falla encontrada al preparar esta evidencia

La primera corrida de la falla 2 tumbó la API (RestartCount pasó de 0 a 2):
cuando la base cerraba una conexión ociosa del pool, el driver `pg` emitía
`error` en el `Pool` sin listener y Node terminaba el proceso. Se corrigió en
`src/infra/db/pool-pg.js` (listener de `error` que lo registra) y lo cubre
`tests/integracion/pool-caida-base.test.js`, que mata una conexión ociosa con
`pg_terminate_backend` y verifica que el proceso sigue y el pool vuelve a
servir.

También se agregó `start_period` al healthcheck de la base: en un clon limpio,
el primer arranque de PostGIS tarda y Compose marcaba la base `unhealthy`
antes de que la API pudiera arrancar.
