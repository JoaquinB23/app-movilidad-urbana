# ADR-008 · Persistir en PostgreSQL + PostGIS con SQL parametrizado, sin ORM, y migraciones SQL numeradas

**Estado** Implementada.

**Fecha** 26/11/2026. **Participantes** Frente B, responsable de la aplicación, Ubicaciones, Identidad e infraestructura. Pendiente de revisión por el otro integrante.

## Contexto

El problema central del enunciado es de consistencia bajo concurrencia: un viaje con un solo chofer y un chofer con un solo viaje activo, con aceptaciones, cancelaciones y reasignaciones simultáneas. Además hay búsqueda geográfica de choferes cercanos (ADR-001), idempotencia por `Idempotency-Key` y escritura masiva del historial de ubicaciones (ADR-002). Hay que decidir el motor, cómo acceder a los datos desde los adaptadores y cómo versionar el esquema entre dos integrantes que agregan tablas en paralelo.

## Opciones consideradas

**Acceso a datos**

- **ORM (Prisma, Sequelize, TypeORM).** Da migraciones generadas, tipos y menos SQL a mano. Pero los mecanismos de los que depende la corrección del sistema quedan detrás de la abstracción o fuera de su soporte: `SELECT ... FOR UPDATE` en un orden definido, `FOR UPDATE SKIP LOCKED`, índices únicos **parciales** (`WHERE hasta IS NULL`), operadores de PostGIS (`ST_DWithin`, KNN `<->`) e `INSERT ... SELECT FROM unnest` para escribir lotes. Terminaríamos con SQL crudo en los lugares críticos y el ORM en el resto, dos formas de hacer lo mismo.
- **Query builder (Knex).** Menos abstracción que un ORM y buen soporte de transacciones, pero agrega una API a aprender para expresar lo que el SQL ya expresa, y las mismas partes de PostGIS y bloqueos se escriben con `raw`.
- **Driver `pg` con SQL parametrizado escrito a mano.** Control total sobre bloqueos, índices y planes; el SQL que se revisa es el que corre. A cambio, el mapeo de filas a objetos es manual y la protección contra inyección depende de usar siempre parámetros.

**Versionado del esquema**

- **Migraciones generadas por una herramienta** (con `up`/`down`). Cómodas, pero atadas al ORM o la herramienta elegida.
- **Archivos SQL numerados aplicados por un runner propio** (`migrar.js`), cada uno en su transacción y registrados en `schema_migraciones`, con rangos por módulo (`1xx` Viajes, `2xx` Ubicaciones, `3xx` Identidad y reasignación).

## Decisión

- **PostgreSQL 16 + PostGIS 3.4** en Docker Compose. Las invariantes de negocio que no pueden romperse viven en la base como restricciones: índices únicos parciales de una asignación abierta por viaje y por chofer (migración 103), una oferta aceptada por viaje (102), email único sin distinguir mayúsculas (001), clave natural `(chofer_id, timestamp)` en el historial (200) y `CHECK` de estados y rangos. Los adaptadores traducen la violación (`23505`) a un error de dominio, así no hay carrera de "consultar y después insertar".
- **Driver `pg` sin ORM**, con **SQL siempre parametrizado** (`$1`, `$2`…), nunca valores interpolados (regla del `AGENTS.md`). Los adaptadores viven en `src/infra/db/` y devuelven objetos del dominio, no filas.
- **Transacciones por caso de uso** con `crearTransaccionPg`: un solo cliente del pool, `BEGIN`/`COMMIT`/`ROLLBACK`, y los repositorios que el caso de uso necesita construidos sobre ese cliente. Los errores de PostgreSQL (`40P01` deadlock, `40001`, `23505`) se traducen a códigos de dominio, nunca se exponen crudos al cliente.
- **Migraciones SQL numeradas**, aplicadas en orden por `src/infra/db/migrar.js` con un advisory lock (dos procesos no migran a la vez) y una transacción por archivo. `GET /ready` responde 503 mientras falte aplicar alguna.
- **Pool con listener de `error`**: si la base cierra una conexión ociosa, se registra y el pool abre otra; sin ese listener el proceso terminaba (ver `docs/evidencia-recuperacion.md`).

## Consecuencias

- Los mecanismos de concurrencia se leen directamente en el código: `SQL_BUSCAR_VIAJE_PARA_ACTUALIZAR`, `SQL_ELEGIR_CANDIDATO` (`FOR UPDATE ... SKIP LOCKED`), los índices parciales. Los tests de concurrencia verifican el dato final en la base.
- Cada adaptador real tiene su par en memoria para los tests de dominio; mantener ambos alineados es trabajo extra, mitigado por los tests de integración que corren contra PostgreSQL real en la CI.
- No hay migraciones `down`: un cambio se revierte con una migración nueva. Es deliberado; deshacer en producción con datos reales rara vez es un `DROP`.
- La protección contra inyección SQL depende de una regla de equipo; la respaldan el test de inyección y el análisis de CodeQL en la CI.

## Qué nos haría cambiar de decisión

Si el modelo creciera mucho en entidades CRUD sin requisitos de concurrencia, evaluaríamos un query builder para esas partes, manteniendo SQL a mano en asignación, reasignación y ubicaciones. Si la escritura de ubicaciones superara lo que una sola instancia de PostgreSQL sostiene aun con lotes, moveríamos el historial crudo a un almacenamiento orientado a series de tiempo y dejaríamos en PostgreSQL solo la última posición.
