# ADR-004 · Autenticar con JWT stateless y argon2id, y autorizar por rol y por recurso con 404

## Estado

Implementada.

## Fecha y participantes

17/11/2026, actualizada el 26/11/2026. Frente B, responsable de Identidad. Pendiente de revisión por el otro integrante.

## Contexto

La plataforma tiene cuatro roles (pasajero, chofer, operador, administrador) y
tres niveles de control de acceso distintos que suelen confundirse:

1. **Autenticación**: ¿quién es el que llama?
2. **Autorización por rol**: ¿su rol alcanza para esta ruta? (`/admin/*` es
   solo de administradores).
3. **Autorización por recurso**: ¿este actor puede ver ESTE viaje? (un
   pasajero autenticado y con rol correcto igual no puede mirar el viaje de
   otro pasajero cambiando el id de la URL).

## Decisión

### Contraseñas: argon2id con costo por variables de entorno

- `argon2id` (ganador del Password Hashing Competition, resistente a GPU y a
  side-channels) vía el paquete `argon2`. El hash embebe sal y parámetros.
- El costo se configura por entorno (`ARGON2_MEMORIA_KIB`,
  `ARGON2_ITERACIONES`, `ARGON2_PARALELISMO`): alto en producción, bajo en
  tests para que la suite sea rápida sin tocar código.
- En el login se verifica **siempre** un hash (el real o uno señuelo) para que
  el tiempo de respuesta no revele si el email existe (timing attack), y el
  error es el mismo (`CREDENCIALES_INVALIDAS`, 401) exista o no la cuenta.

**Alternativas descartadas**: `bcrypt` (límite de 72 bytes, menos resistente a
GPU), `scrypt` nativo de Node (sin formato de hash estándar autodescriptivo,
habría que versionar parámetros a mano).

### Sesiones: JWT stateless (HS256)

- `jsonwebtoken` firmando `{ sub, rol }` con `JWT_SECRETO` (mínimo 32 chars),
  `issuer` y `audience` fijos y expiración (`JWT_EXPIRACION`, default 8 h).
- La verificación fija `algorithms: ['HS256']`: nunca se acepta `alg: none` ni
  downgrade de algoritmo.
- Stateless: ninguna consulta a la DB por request autenticada; el payload
  lleva lo único que las rutas necesitan (`id`, `rol`).

**Alternativas descartadas**: sesiones en DB/Redis (estado compartido y una
consulta extra por request; la revocación inmediata no es requisito del TP),
RS256 (pares de claves sin necesidad: emisor y verificador son el mismo
proceso).

**Trade-off asumido**: un JWT emitido no se puede revocar hasta que expira;
deshabilitar un chofer no mata su token, pero sí su capacidad de operar
(los casos de uso revalidan `habilitado` en la DB).

### Middlewares y helper (contrato para los otros módulos)

- `crearAutenticar({ tokens })` → middleware que exige `Authorization: Bearer`
  y deja `req.actor = { id, rol }`. Token ausente, vencido o con firma
  inválida: **el mismo 401**, sin distinguir el motivo.
- `requerirRol(...roles)` → 403 `ROL_NO_AUTORIZADO` cuando la identidad es
  válida pero el permiso no alcanza.
- `autorizarRecurso({ actor, recurso, reglas })`
  (`src/dominio/identidad/autorizacion.js`) → helper **por recurso**
  reutilizable: `reglas` mapea rol → predicado sobre el recurso. Si el recurso
  no existe **o** el actor no pasa su regla, lanza `NO_ENCONTRADO` (404, no
  403): responder 403 a un id ajeno confirmaría que el id existe y habilita
  enumeración.

### Validación de entrada

Todos los cuerpos pasan por esquemas zod `.strict()`: cualquier campo no
declarado se rechaza con 400, lo que de paso neutraliza prototype pollution
(`__proto__`, `constructor.prototype`). Todas las consultas SQL usan
parámetros posicionales (`$1`), nunca concatenación. Ambas cosas tienen tests
en `tests/seguridad/identidad-http.test.js`.

## Consecuencias

- Los demás módulos no implementan seguridad propia: reciben `autenticar`
  inyectado y usan `requerirRol` / `autorizarRecurso`.
- Si la composición olvida el rate limit del login o la autenticación, las
  rutas no arrancan (dependencias obligatorias en el constructor: fallar
  cerrado).
- El registro de chofer crea usuario + vehículo en una transacción y nace
  **no habilitado**; solo `PATCH /admin/choferes/:id/habilitacion` lo habilita.

## Qué nos haría cambiar de decisión

- Si la revocación inmediata pasara a ser requisito (deshabilitar a alguien y
  que su sesión muera en el acto), agregaríamos una lista de tokens revocados
  consultada en `autenticar`, o pasaríamos a sesiones en la base.
- Si otro servicio tuviera que verificar los tokens sin conocer el secreto,
  cambiaríamos HS256 por RS256 con la clave pública publicada.
- Si `argon2id` con el costo elegido llevara el login por encima de un tiempo
  aceptable en el hardware de despliegue, bajaríamos el costo por variable de
  entorno antes que cambiar de algoritmo.
