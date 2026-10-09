-- Migracion 200: modulo de ubicaciones (Persona B).
--
-- Depende de tablas creadas por migraciones previas:
--   * choferes (usuario_id UUID PK, habilitado boolean, disponible boolean)  -> 001
--   * viajes   (id UUID PK)                                                   -> 101
-- Convencion del repo (docs/modelo.md): A usa 1xx, B 2xx, C 3xx.
-- Los ids de chofer y viaje son UUID (coinciden con usuarios.id y viajes.id).
--
-- Ejecutar con el runner del proyecto: npm run migrate (migrar.js, en orden
-- alfabetico y dentro de una transaccion por archivo).

-- Ultima posicion conocida de cada chofer. Una fila por chofer (PK), por eso el
-- UPSERT de actualizarActual es natural.
--
-- La columna es `geography(Point,4326)`, no `geometry`:
--   * el radio de ST_DWithin queda en METROS sobre elipsoide;
--   * es apta para el indice GiST espacial.
CREATE TABLE IF NOT EXISTS ubicaciones_actuales (
  chofer_id  UUID PRIMARY KEY REFERENCES choferes (usuario_id) ON DELETE CASCADE,
  geom       GEOGRAPHY(Point, 4326) NOT NULL,
  timestamp  TIMESTAMPTZ NOT NULL
);

-- Indice espacial: es lo que hace que la version PostGIS no recorra la tabla.
CREATE INDEX IF NOT EXISTS idx_ubicaciones_actuales_geom
  ON ubicaciones_actuales USING GIST (geom);

-- Historial crudo de posiciones. Append-only. Nombre alineado con docs/modelo.md.
CREATE TABLE IF NOT EXISTS ubicaciones_historial (
  id         BIGSERIAL PRIMARY KEY,
  viaje_id   UUID REFERENCES viajes (id) ON DELETE SET NULL,
  chofer_id  UUID NOT NULL REFERENCES choferes (usuario_id) ON DELETE CASCADE,
  geom       GEOGRAPHY(Point, 4326) NOT NULL,
  timestamp  TIMESTAMPTZ NOT NULL
);

-- Idempotencia del tracking por CLAVE NATURAL: (chofer_id, timestamp) es unico.
-- Si el cliente reintenta el mismo POST (red caida, retry del simulador), el
-- UNIQUE ignora la fila duplicada con ON CONFLICT DO NOTHING. No hace falta
-- Idempotency-Key: la telemetria tiene una clave natural a diferencia de un
-- pago. Dos ubicaciones validas del mismo chofer jamás comparten el milisegundo.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ubicaciones_historial_chofer_ts
  ON ubicaciones_historial (chofer_id, timestamp);

-- Consulta principal de GET /viajes/:id/recorrido (filtra por viaje y ordena).
CREATE INDEX IF NOT EXISTS idx_ubicaciones_historial_viaje_ts
  ON ubicaciones_historial (viaje_id, timestamp);

-- La retencion purga por antiguedad: este indice la hace barata.
CREATE INDEX IF NOT EXISTS idx_ubicaciones_historial_ts
  ON ubicaciones_historial (timestamp);

-- Politica de retencion (documentada en docs/ y disparada por el job del
-- proyecto): se conservan N dias de historial crudo y se purga el resto. Se
-- implementa como funcion para que el job solo la invoque y sea auditable.
CREATE OR REPLACE FUNCTION purgar_ubicaciones_historial(dias INTEGER)
RETURNS BIGINT AS $$
DECLARE
  borrados BIGINT;
BEGIN
  IF dias IS NULL OR dias <= 0 THEN
    RAISE EXCEPTION 'dias debe ser positivo';
  END IF;
  DELETE FROM ubicaciones_historial WHERE timestamp < NOW() - (dias || ' days')::INTERVAL;
  GET DIAGNOSTICS borrados = ROW_COUNT;
  RETURN borrados;
END;
$$ LANGUAGE plpgsql;