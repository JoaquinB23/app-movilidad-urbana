-- Migración 104: registro append-only de eventos del ciclo de vida de un viaje.
CREATE TABLE viajes_eventos (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  viaje_id UUID NOT NULL,
  evento TEXT NOT NULL,
  actor_tipo TEXT NOT NULL,
  actor_id UUID,
  estado_anterior TEXT,
  estado_nuevo TEXT NOT NULL,
  motivo TEXT,
  en TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT viajes_eventos_pk PRIMARY KEY (id),
  CONSTRAINT viajes_eventos_viaje_fk FOREIGN KEY (viaje_id)
    REFERENCES viajes (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT viajes_eventos_actor_tipo_valido CHECK (
    actor_tipo IN ('pasajero', 'chofer', 'operador', 'sistema')
  )
);

COMMENT ON CONSTRAINT viajes_eventos_pk ON viajes_eventos IS
  'Garantiza que cada evento tenga un identificador único.';
COMMENT ON CONSTRAINT viajes_eventos_viaje_fk ON viajes_eventos IS
  'Garantiza que todo evento refiera a un viaje existente.';
COMMENT ON CONSTRAINT viajes_eventos_actor_tipo_valido ON viajes_eventos IS
  'Restringe el tipo de actor que origina un evento a los cuatro tipos válidos.';
COMMENT ON TABLE viajes_eventos IS
  'Registro append-only: la aplicación nunca hace UPDATE ni DELETE sobre esta tabla.';
COMMENT ON COLUMN viajes_eventos.estado_anterior IS
  'Estado del viaje anterior al evento; puede ser NULL cuando no hay estado previo.';

-- Invariante operativa: permite recuperar la secuencia temporal de eventos de un viaje.
CREATE INDEX viajes_eventos_viaje_en_idx ON viajes_eventos (viaje_id, en);
