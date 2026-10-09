-- Migracion 200: modulo de ubicaciones.
--
-- Depende de tablas creadas por migraciones 1xx (otro modulo):
--   * choferes (id text PK, habilitado boolean, disponible boolean)
--   * viajes   (id text PK)
-- Los ids se manejan como TEXT para coincidir con el resto del modelo.
--
-- Ejecutar con el runner de migraciones del proyecto (aplica en orden).

-- Ultima posicion conocida de cada chofer. Una fila por chofer (PK), por eso el
-- UPSERT de actualizarActual es natural.
--
-- La columna es `geography(Point,4326)`, no `geometry`:
--   * el radio de ST_DWithin queda en METROS sobre elipsoide;
--   * es apta para el indice GiST espacial.
CREATE TABLE IF NOT EXISTS ubicaciones_actuales (
  chofer_id  TEXT PRIMARY KEY REFERENCES choferes (id) ON DELETE CASCADE,
  geom       GEOGRAPHY(Point, 4326) NOT NULL,
  timestamp  TIMESTAMPTZ NOT NULL
);

-- Indice espacial: es lo que hace que la version PostGIS no recorra la tabla.
CREATE INDEX IF NOT EXISTS idx_ubicaciones_actuales_geom
  ON ubicaciones_actuales USING GIST (geom);

-- Historial crudo de posiciones. Append-only.
CREATE TABLE IF NOT EXISTS historial_ubicaciones (
  id         BIGSERIAL PRIMARY KEY,
  viaje_id   TEXT REFERENCES viajes (id) ON DELETE SET NULL,
  chofer_id  TEXT NOT NULL REFERENCES choferes (id) ON DELETE CASCADE,
  geom       GEOGRAPHY(Point, 4326) NOT NULL,
  timestamp  TIMESTAMPTZ NOT NULL
);

-- Idempotencia del tracking por CLAVE NATURAL: (chofer_id, timestamp) es unico.
-- Si el cliente reintenta el mismo POST (red caida, retry del simulador), el
-- UNIQUE ignora la fila duplicada con ON CONFLICT DO NOTHING. No hace falta
-- Idempotency-Key: la telemetria tiene una clave natural a diferencia de un
-- pago. Dos ubicaciones validas del mismo chofer jamás comparten el milisegundo.
CREATE UNIQUE INDEX IF NOT EXISTS uq_historial_ubicaciones_chofer_ts
  ON historial_ubicaciones (chofer_id, timestamp);

-- Consulta principal de GET /viajes/:id/recorrido (filtra por viaje y ordena).
CREATE INDEX IF NOT EXISTS idx_historial_ubicaciones_viaje_ts
  ON historial_ubicaciones (viaje_id, timestamp);

-- La retencion purga por antiguedad: este indice la hace barata.
CREATE INDEX IF NOT EXISTS idx_historial_ubicaciones_ts
  ON historial_ubicaciones (timestamp);

-- Politica de retencion (documentada en docs/ y disparada por el job del
-- proyecto): se conservan N dias de historial crudo y se purga el resto. Se
-- implementa como funcion para que el job solo la invoque y sea auditable.
CREATE OR REPLACE FUNCTION purgar_historial_ubicaciones(dias INTEGER)
RETURNS BIGINT AS $$
DECLARE
  borrados BIGINT;
BEGIN
  IF dias IS NULL OR dias <= 0 THEN
    RAISE EXCEPTION 'dias debe ser positivo';
  END IF;
  DELETE FROM historial_ubicaciones WHERE timestamp < NOW() - (dias || ' days')::INTERVAL;
  GET DIAGNOSTICS borrados = ROW_COUNT;
  RETURN borrados;
END;
$$ LANGUAGE plpgsql;
