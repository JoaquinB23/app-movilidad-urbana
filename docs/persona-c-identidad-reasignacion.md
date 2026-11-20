# Persona C: identidad, administración, seguridad y variante H

Resumen de lo implementado, para tener contexto rápido del módulo. El detalle
de decisiones está en los ADR:

- `docs/adr/ADR-004-autenticacion-autorizacion.md` (argon2, JWT, middlewares,
  autorización por recurso)
- `docs/adr/ADR-005-reasignacion-variante-h.md` (worker, carrera de H,
  alternativas descartadas)

La tabla de roles/permisos está en el `README.md`.

## Archivos del módulo

| Pieza | Archivo |
|---|---|
| Migración (parametros, tarifas, zonas) | `migraciones/300_identidad_administracion.sql` |
| Servicios de identidad (registro/login/perfil/habilitación) | `src/dominio/identidad/servicios.js` |
| Errores de identidad | `src/dominio/identidad/errores.js` |
| Helper de autorización por recurso (reutilizable) | `src/dominio/identidad/autorizacion.js` |
| Caso de uso único `reasignarViaje(viajeId, motivo)` | `src/dominio/reasignacion/reasignar-viaje.js` |
| Errores de reasignación | `src/dominio/reasignacion/errores.js` |
| Hasher argon2id (costo por env) | `src/infra/seguridad/hasher-argon2.js` |
| Tokens JWT (HS256 fijo) | `src/infra/seguridad/tokens-jwt.js` |
| Middlewares `crearAutenticar` / `requerirRol` | `src/infra/http/autenticacion.js` |
| Rutas `/auth/*` y `GET /me` | `src/infra/http/rutas/auth.js` |
| Rutas `/admin/*` (choferes, tarifas, zonas, parámetros) | `src/infra/http/rutas/admin.js` |
| Rutas `POST /viajes/:id/rechazar-continuar` y `GET /viajes/:id/asignaciones` | `src/infra/http/rutas/reasignacion.js` |
| Worker de reasignación (variante H) | `src/workers/reasignacion.js` |
| Repos PG (usuarios, administración, reasignación) | `src/infra/db/repo-usuarios-pg.js`, `repo-administracion-pg.js`, `repo-reasignacion-pg.js` |
| Adaptadores en memoria para tests | `src/infra/memoria/repositorio-usuarios-memoria.js`, `repositorio-administracion-memoria.js` |
| Tests de seguridad (HTTP, sin DB) | `tests/seguridad/identidad-http.test.js` |
| Tests de concurrencia (PG real) | `tests/concurrencia/reasignacion-carrera.test.js` |

## Rutas

- `POST /auth/registro/pasajero` y `POST /auth/registro/chofer` (con datos del
  vehículo; el chofer queda **no habilitado**).
- `POST /auth/login` (rate limit propio) y `GET /me`.
- `PATCH /admin/choferes/:id/habilitacion`, `GET /admin/choferes` (solo admin).
- `GET|PUT /admin/tarifas`, `/admin/zonas`, `/admin/parametros` — incluye
  `tiempo_limite_oferta_s` y `umbral_reasignacion_s` (variante H). El catálogo
  de parámetros es CERRADO: una clave nueva se agrega por migración, el PUT
  solo edita valores.
- `POST /viajes/:id/rechazar-continuar` — solo el chofer asignado; dispara el
  mismo caso de uso de reasignación que el worker.
- `GET /viajes/:id/asignaciones` — historial de choferes con motivo; lo ven el
  pasajero del viaje, operador y admin (recurso ajeno → 404).

## Decisiones clave (versión corta)

- **argon2id** con costo por variables de entorno (`ARGON2_*`): alto en
  producción, bajo en tests. Login verifica siempre un hash (real o señuelo):
  mismo 401 y mismo tiempo exista o no el email.
- **JWT HS256 stateless** (`{ sub, rol }`, issuer/audience/expiración fijos);
  la verificación fija el algoritmo (nunca `alg: none`).
- **Autorización en tres capas**: `autenticar` (401), `requerirRol` (403) y
  `autorizarRecurso` por recurso (404 ante id ajeno, para no confirmar
  existencia).
- **zod `.strict()`** en todos los cuerpos: campos no declarados → 400
  (neutraliza `__proto__` / `constructor.prototype`). SQL siempre
  parametrizado.
- **Variante H**: detección con `SELECT ... FOR UPDATE SKIP LOCKED`,
  revalidación del umbral DENTRO de la transacción (ahí se decide la carrera
  "reasignación vs. chofer que vuelve a reportar"), candidato con
  `SKIP LOCKED`, cierre y apertura de asignación en la misma transacción.
  Nunca dos choferes ni ninguno; el chofer anterior queda libre. Sin
  candidatos, el viaje conserva su chofer y el worker reintenta.

## Cambios fuera de la carpeta propia

- `src/infra/db/transaccion-pg.js`: se agregó el repo `reasignacion` a la
  transacción compartida (aditivo) y se actualizó su test.
- `src/infra/db/repo-asignaciones-pg.js`: método `listarPorViaje` (historial).
- `package.json`: `npm test` corre con `--test-concurrency=1` porque los
  archivos de test comparten la base de test y en paralelo se pisaban los
  fixtures (TRUNCATE de unos sobre los escenarios de otros).

## Cómo correr los tests

- Seguridad (sin DB): `node --test tests/seguridad/identidad-http.test.js`
- Concurrencia: necesitan `DATABASE_URL_TEST` (base distinta de la principal).
  `docker compose up -d` prepara `movilidad_test` en el mismo PostgreSQL que la
  base principal (puerto host 5432 por defecto), usando un volumen separado
  lógicamente:

  ```bash
  docker compose up -d
  ```

  Las migraciones se aplican solas la primera vez que corre la suite. Si el
  volumen PostgreSQL ya existía antes de agregar esta inicialización, crear la
  base de pruebas una vez con
  `docker exec movilidad-db createdb -U movilidad -T template_postgis movilidad_test`.
- Todo: `npm test` (201 tests al momento de escribir esto).

## Pendiente de integración

`src/composicion.js` y `src/servidor.js` siguen siendo stubs compartidos del
proyecto: falta componer ahí hasher + tokens + `crearAutenticar`, montar las
rutas de auth/admin/reasignación junto a las de los otros módulos, unificar
los `MAPEO_HTTP_*` en el handler global de errores y arrancar/parar el worker
(`crearWorkerReasignacion(...).iniciar()` / `.detener()`).
