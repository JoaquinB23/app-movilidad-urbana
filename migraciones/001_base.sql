-- Migración 001: base de datos para plataforma de viajes
-- Convención: 001_base.sql = base; 1xx_ = módulo de viajes; 2xx_ = ubicaciones; 3xx_ = identidad y reasignación.
-- Esta migración establece entidades compartidas mínimas para soportar identidad, habilitación y claves de idempotencia.

-- Habilita PostGIS para trabajar con geometrías/operadores espaciales si se requiere en el futuro.
-- Invariante: el motor debe contar con funciones ST_* disponibles cuando se use PostGIS.
CREATE EXTENSION IF NOT EXISTS postgis;

-- USUARIOS
-- Invariante: cada usuario tiene un email único en la plataforma (comparación case-insensitive).
-- Invariante: el rol solo puede tomar uno de los valores permitidos: pasajero, chofer, operador, administrador.
CREATE TABLE IF NOT EXISTS usuarios (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email        VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  nombre       VARCHAR(255) NOT NULL,
  rol          VARCHAR(20)  NOT NULL,
  activo       BOOLEAN      NOT NULL DEFAULT true,
  creado_en    TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT usuarios_email_en_minusculas  CHECK (email = lower(email)),
  CONSTRAINT usuarios_rol_valido
    CHECK (rol IN ('pasajero', 'chofer', 'operador', 'administrador'))
);

-- Garantiza unicidad case-insensitive para email.
CREATE UNIQUE INDEX IF NOT EXISTS usuarios_email_lower_idx ON usuarios (lower(email));

COMMENT ON TABLE  usuarios IS 'Usuarios de la plataforma (pasajero/chofer/operador/administrador).';
COMMENT ON COLUMN usuarios.email IS 'Correo electrónico único (se almacena en minúsculas).';
COMMENT ON COLUMN usuarios.rol   IS 'Rol del usuario: pasajero, chofer, operador, administrador.';

-- CHOFERES
-- Invariante: un chofer existe solo como extensión de un usuario (FK a usuarios).
-- Invariante: la coherencia entre chofer y rol del usuario se valida en la capa de aplicación/casos de uso
--             (no se fuerza a nivel DB para evitar acoplar reglas de negocio a migraciones).
-- Invariante: patente única entre todos los choferes.
-- Invariante: habilitado_por referencia a un usuario (nullable hasta que sea habilitado).
CREATE TABLE IF NOT EXISTS choferes (
  usuario_id        UUID         PRIMARY KEY,
  patente           VARCHAR(10)  NOT NULL,
  vehiculo_marca    VARCHAR(100) NOT NULL,
  vehiculo_modelo   VARCHAR(100) NOT NULL,
  vehiculo_color    VARCHAR(50)  NOT NULL,
  habilitado        BOOLEAN      NOT NULL DEFAULT false,
  habilitado_por    UUID         NULL,
  habilitado_en     TIMESTAMPTZ  NULL,
  disponible        BOOLEAN      NOT NULL DEFAULT false,

  CONSTRAINT choferes_usuario_fk
    FOREIGN KEY (usuario_id) REFERENCES usuarios (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT choferes_habilitado_por_fk
    FOREIGN KEY (habilitado_por) REFERENCES usuarios (id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT choferes_patente_unique UNIQUE (patente)
);

COMMENT ON TABLE  choferes IS 'Datos específicos de choferes.';
COMMENT ON COLUMN choferes.patente IS 'Patente única del vehículo.';
COMMENT ON COLUMN choferes.habilitado IS 'Indica si el chofer está habilitado para operar (no habilitado por defecto).';
COMMENT ON COLUMN choferes.disponible IS 'Flag de disponibilidad para asignación (se mantiene por el dominio/infra).';

-- CLAVES_IDEMPOTENCIA
-- Invariante: una operación idempotente se identifica por (usuario_id, clave).
-- Invariante: solo se guarda respuesta exitosa/resultado para evitar reintentos accidentales.
-- Invariante: hash_pedido permite detectar cambios en el cuerpo entre reintentos.
-- Nota: la misma 'clave' puede usarse en distintos endpoints; considerar agregar 'ruta' a la clave primaria
--       cuando se implemente el middleware de idempotencia para evitar colisiones.
CREATE TABLE IF NOT EXISTS claves_idempotencia (
  usuario_id   UUID        NOT NULL,
  clave        VARCHAR(64) NOT NULL,
  hash_pedido  VARCHAR(64) NULL,
  estado_http  SMALLINT    NULL,
  respuesta    JSONB       NULL,
  creada_en    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT claves_idempotencia_pk
    PRIMARY KEY (usuario_id, clave),
  CONSTRAINT claves_idempotencia_usuario_fk
    FOREIGN KEY (usuario_id) REFERENCES usuarios (id) ON DELETE CASCADE ON UPDATE CASCADE
);

COMMENT ON TABLE  claves_idempotencia IS 'Almacena respuestas para operaciones con Idempotency-Key por usuario.';
COMMENT ON COLUMN claves_idempotencia.clave IS 'Valor de Idempotency-Key enviado por el cliente.';
COMMENT ON COLUMN claves_idempotencia.hash_pedido IS 'Hash del cuerpo del pedido (sha256) para validar reintento idéntico.';
COMMENT ON COLUMN claves_idempotencia.estado_http IS 'Código HTTP devuelto la primera vez que se procesó la operación.';
COMMENT ON COLUMN claves_idempotencia.respuesta IS 'Respuesta serializada devuelta la primera vez (JSONB).';
