-- Migración 103: historial de asignaciones de choferes a viajes.
CREATE TABLE asignaciones_viaje (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  viaje_id UUID NOT NULL,
  chofer_id UUID NOT NULL,
  desde TIMESTAMPTZ NOT NULL DEFAULT now(),
  hasta TIMESTAMPTZ,
  motivo_fin TEXT,

  CONSTRAINT asignaciones_viaje_pk PRIMARY KEY (id),
  CONSTRAINT asignaciones_viaje_viaje_fk FOREIGN KEY (viaje_id)
    REFERENCES viajes (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT asignaciones_viaje_chofer_fk FOREIGN KEY (chofer_id)
    REFERENCES choferes (usuario_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT asignaciones_viaje_intervalo_valido CHECK (
    hasta IS NULL OR hasta >= desde
  )
);

COMMENT ON CONSTRAINT asignaciones_viaje_pk ON asignaciones_viaje IS
  'Garantiza que cada asignación histórica tenga un identificador único.';
COMMENT ON CONSTRAINT asignaciones_viaje_viaje_fk ON asignaciones_viaje IS
  'Garantiza que toda asignación pertenezca a un viaje existente.';
COMMENT ON CONSTRAINT asignaciones_viaje_chofer_fk ON asignaciones_viaje IS
  'Garantiza que toda asignación pertenezca a un chofer existente.';
COMMENT ON CONSTRAINT asignaciones_viaje_intervalo_valido ON asignaciones_viaje IS
  'Garantiza que el fin de una asignación no sea anterior a su inicio.';
COMMENT ON TABLE asignaciones_viaje IS
  'Cerrar la asignación seteando hasta es parte de finalizar o cancelar el viaje; si no, el chofer quedaría bloqueado.';

-- Invariante: un viaje no puede tener simultáneamente más de un chofer asignado.
CREATE UNIQUE INDEX asignaciones_viaje_una_abierta_por_viaje_idx
  ON asignaciones_viaje (viaje_id)
  WHERE hasta IS NULL;
-- Invariante: un chofer no puede estar asignado simultáneamente a más de un viaje.
CREATE UNIQUE INDEX asignaciones_viaje_una_abierta_por_chofer_idx
  ON asignaciones_viaje (chofer_id)
  WHERE hasta IS NULL;
