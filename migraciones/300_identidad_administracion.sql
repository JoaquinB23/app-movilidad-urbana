-- Migración 300: módulo de identidad, administración y reasignación (Persona C).
-- Convención del repo (docs/modelo.md): A usa 1xx, B 2xx, C 3xx.
--
-- Las tablas `usuarios` y `choferes` ya existen (001_base.sql). Esta migración
-- agrega la configuración administrable (tarifas, zonas, parámetros) y deja
-- constancia de que el invariante central de la reasignación (una sola
-- asignación abierta por viaje y por chofer) ya está garantizado por los
-- índices únicos parciales de 103_asignaciones_viaje.sql:
--   * asignaciones_viaje_una_abierta_por_viaje_idx  (viaje_id)  WHERE hasta IS NULL
--   * asignaciones_viaje_una_abierta_por_chofer_idx (chofer_id) WHERE hasta IS NULL

-- PARAMETROS
-- Invariante: cada parámetro operativo tiene una única fila (clave PK).
-- Se guarda como JSONB para admitir números, strings u objetos sin migrar
-- el esquema por cada parámetro nuevo.
CREATE TABLE IF NOT EXISTS parametros (
  clave           VARCHAR(64) PRIMARY KEY,
  valor           JSONB        NOT NULL,
  descripcion     TEXT         NULL,
  actualizado_en  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  actualizado_por UUID         NULL REFERENCES usuarios (id) ON DELETE SET NULL
);

COMMENT ON TABLE parametros IS
  'Parámetros operativos editables por el administrador (PUT /admin/parametros).';

-- Valores iniciales. ON CONFLICT DO NOTHING: re-ejecutar la migración no pisa
-- lo que un administrador ya haya cambiado.
INSERT INTO parametros (clave, valor, descripcion) VALUES
  ('tiempo_limite_oferta_s', '30'::jsonb,
   'Segundos que una oferta a un chofer permanece vigente antes de expirar.'),
  ('umbral_reasignacion_s', '60'::jsonb,
   'Segundos sin reporte de ubicación del chofer asignado antes de que el worker reasigne el viaje (variante H).'),
  ('radio_busqueda_m', '5000'::jsonb,
   'Radio en metros para buscar choferes candidatos al reasignar.')
ON CONFLICT (clave) DO NOTHING;

-- TARIFAS
-- Invariante: fila única (singleton). La tarifa vigente se edita por PUT
-- /admin/tarifas; el historial de cambios queda en los logs/auditoría, no acá.
CREATE TABLE IF NOT EXISTS tarifas (
  id                        SMALLINT    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  bajada_bandera_centavos   INTEGER     NOT NULL CHECK (bajada_bandera_centavos >= 0),
  precio_km_centavos        INTEGER     NOT NULL CHECK (precio_km_centavos >= 0),
  precio_minuto_centavos    INTEGER     NOT NULL CHECK (precio_minuto_centavos >= 0),
  actualizado_en            TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_por           UUID        NULL REFERENCES usuarios (id) ON DELETE SET NULL
);

INSERT INTO tarifas (id, bajada_bandera_centavos, precio_km_centavos, precio_minuto_centavos)
VALUES (1, 150000, 80000, 10000)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE tarifas IS 'Tarifa vigente (singleton; una sola fila con id=1).';

-- ZONAS
-- Invariante: nombre único; el multiplicador ajusta la tarifa dentro de la zona.
CREATE TABLE IF NOT EXISTS zonas (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre          VARCHAR(100) NOT NULL,
  multiplicador   NUMERIC(4,2) NOT NULL DEFAULT 1.00 CHECK (multiplicador > 0),
  activa          BOOLEAN      NOT NULL DEFAULT true,
  actualizado_en  TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT zonas_nombre_unique UNIQUE (nombre)
);

COMMENT ON TABLE zonas IS 'Zonas tarifarias administrables (GET|PUT /admin/zonas).';

-- Consulta del worker de reasignación (variante H): viajes con asignación
-- abierta cuyo chofer no reporta. El índice parcial por chofer ya existe; este
-- acelera el join asignación abierta -> ubicación actual.
CREATE INDEX IF NOT EXISTS asignaciones_viaje_abiertas_desde_idx
  ON asignaciones_viaje (desde)
  WHERE hasta IS NULL;
