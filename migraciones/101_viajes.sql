-- Migración 101: viajes solicitados por pasajeros.
CREATE TABLE viajes (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  pasajero_id UUID NOT NULL,
  estado TEXT NOT NULL DEFAULT 'solicitado',
  origen_lat DOUBLE PRECISION NOT NULL,
  origen_lng DOUBLE PRECISION NOT NULL,
  destino_lat DOUBLE PRECISION NOT NULL,
  destino_lng DOUBLE PRECISION NOT NULL,
  distancia_estimada_m INTEGER NOT NULL,
  duracion_estimada_s INTEGER NOT NULL,
  tarifa_estimada_centavos INTEGER NOT NULL,
  tarifa_final_centavos INTEGER,
  motivo_cierre TEXT,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT viajes_pk PRIMARY KEY (id),
  CONSTRAINT viajes_pasajero_fk FOREIGN KEY (pasajero_id)
    REFERENCES usuarios (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT viajes_estado_valido CHECK (
    estado IN (
      'solicitado', 'asignado', 'chofer_en_camino', 'en_curso',
      'finalizado', 'cancelado_pasajero', 'cancelado_chofer', 'sin_choferes'
    )
  ),
  CONSTRAINT viajes_origen_lat_rango CHECK (origen_lat BETWEEN -90 AND 90),
  CONSTRAINT viajes_origen_lng_rango CHECK (origen_lng BETWEEN -180 AND 180),
  CONSTRAINT viajes_destino_lat_rango CHECK (destino_lat BETWEEN -90 AND 90),
  CONSTRAINT viajes_destino_lng_rango CHECK (destino_lng BETWEEN -180 AND 180),
  CONSTRAINT viajes_distancia_no_negativa CHECK (distancia_estimada_m >= 0),
  CONSTRAINT viajes_duracion_no_negativa CHECK (duracion_estimada_s >= 0),
  CONSTRAINT viajes_tarifa_estimada_no_negativa CHECK (tarifa_estimada_centavos >= 0),
  CONSTRAINT viajes_tarifa_final_no_negativa CHECK (
    tarifa_final_centavos IS NULL OR tarifa_final_centavos >= 0
  )
);

COMMENT ON CONSTRAINT viajes_pk ON viajes IS
  'Garantiza que cada viaje tenga un identificador único.';
COMMENT ON CONSTRAINT viajes_pasajero_fk ON viajes IS
  'Garantiza que todo viaje pertenezca a un usuario pasajero existente.';
COMMENT ON CONSTRAINT viajes_estado_valido ON viajes IS
  'Restringe el estado del viaje a los ocho estados válidos del dominio.';
COMMENT ON CONSTRAINT viajes_origen_lat_rango ON viajes IS
  'Garantiza que la latitud del origen esté entre -90 y 90 grados.';
COMMENT ON CONSTRAINT viajes_origen_lng_rango ON viajes IS
  'Garantiza que la longitud del origen esté entre -180 y 180 grados.';
COMMENT ON CONSTRAINT viajes_destino_lat_rango ON viajes IS
  'Garantiza que la latitud del destino esté entre -90 y 90 grados.';
COMMENT ON CONSTRAINT viajes_destino_lng_rango ON viajes IS
  'Garantiza que la longitud del destino esté entre -180 y 180 grados.';
COMMENT ON CONSTRAINT viajes_distancia_no_negativa ON viajes IS
  'Evita distancias estimadas negativas.';
COMMENT ON CONSTRAINT viajes_duracion_no_negativa ON viajes IS
  'Evita duraciones estimadas negativas.';
COMMENT ON CONSTRAINT viajes_tarifa_estimada_no_negativa ON viajes IS
  'Evita tarifas estimadas negativas expresadas en centavos.';
COMMENT ON CONSTRAINT viajes_tarifa_final_no_negativa ON viajes IS
  'Permite una tarifa final aún no definida, pero nunca un importe negativo.';

-- Invariante: los viajes recientes de un pasajero se consultan ordenados por fecha.
CREATE INDEX viajes_pasajero_creado_en_idx
  ON viajes (pasajero_id, creado_en DESC);
-- Invariante: permite filtrar viajes por estado sin recorrer toda la tabla.
CREATE INDEX viajes_estado_idx ON viajes (estado);
