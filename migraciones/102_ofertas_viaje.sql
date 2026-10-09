-- Migración 102: ofertas enviadas a choferes candidatos para un viaje.
CREATE TABLE ofertas_viaje (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  viaje_id UUID NOT NULL,
  chofer_id UUID NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente',
  orden INTEGER NOT NULL,
  expira_en TIMESTAMPTZ NOT NULL,
  creada_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  respondida_en TIMESTAMPTZ,

  CONSTRAINT ofertas_viaje_pk PRIMARY KEY (id),
  CONSTRAINT ofertas_viaje_viaje_fk FOREIGN KEY (viaje_id)
    REFERENCES viajes (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT ofertas_viaje_chofer_fk FOREIGN KEY (chofer_id)
    REFERENCES choferes (usuario_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT ofertas_viaje_estado_valido CHECK (
    estado IN ('pendiente', 'aceptada', 'rechazada', 'vencida', 'cancelada')
  ),
  CONSTRAINT ofertas_viaje_orden_positivo CHECK (orden >= 1),
  CONSTRAINT ofertas_viaje_viaje_chofer_unique UNIQUE (viaje_id, chofer_id)
);

COMMENT ON CONSTRAINT ofertas_viaje_pk ON ofertas_viaje IS
  'Garantiza que cada oferta tenga un identificador único.';
COMMENT ON CONSTRAINT ofertas_viaje_viaje_fk ON ofertas_viaje IS
  'Garantiza que toda oferta corresponda a un viaje existente.';
COMMENT ON CONSTRAINT ofertas_viaje_chofer_fk ON ofertas_viaje IS
  'Garantiza que toda oferta esté dirigida a un chofer existente.';
COMMENT ON CONSTRAINT ofertas_viaje_estado_valido ON ofertas_viaje IS
  'Restringe el estado de la oferta a los cinco estados válidos del dominio.';
COMMENT ON CONSTRAINT ofertas_viaje_orden_positivo ON ofertas_viaje IS
  'Garantiza que la posición de cada candidato en la lista empiece en uno.';
COMMENT ON CONSTRAINT ofertas_viaje_viaje_chofer_unique ON ofertas_viaje IS
  'Impide enviar más de una oferta al mismo chofer para un mismo viaje.';

-- Invariante: un viaje puede tener como máximo una oferta aceptada.
CREATE UNIQUE INDEX ofertas_viaje_una_aceptada_por_viaje_idx
  ON ofertas_viaje (viaje_id)
  WHERE estado = 'aceptada';
-- Invariante operativa: permite localizar las ofertas por estado y vencimiento.
CREATE INDEX ofertas_viaje_estado_expira_en_idx
  ON ofertas_viaje (estado, expira_en);
