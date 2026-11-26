-- Migración 105: cobro simulado de un viaje finalizado.
--
-- Invariante central: un viaje se cobra UNA sola vez. Lo garantiza el índice
-- único sobre viaje_id, no una consulta previa: dos cobros simultáneos del
-- mismo viaje no pueden insertar dos filas aunque usen Idempotency-Key
-- distintas. El reintento con la MISMA clave lo resuelve la tabla
-- claves_idempotencia (001): devuelve la respuesta original sin cobrar de nuevo.

CREATE TABLE cobros (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  viaje_id UUID NOT NULL,
  pasajero_id UUID NOT NULL,
  importe_centavos INTEGER NOT NULL,
  estado TEXT NOT NULL DEFAULT 'aprobado',
  medio TEXT NOT NULL DEFAULT 'simulado',
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT cobros_pk PRIMARY KEY (id),
  CONSTRAINT cobros_viaje_fk FOREIGN KEY (viaje_id)
    REFERENCES viajes (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT cobros_pasajero_fk FOREIGN KEY (pasajero_id)
    REFERENCES usuarios (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT cobros_importe_no_negativo CHECK (importe_centavos >= 0),
  CONSTRAINT cobros_estado_valido CHECK (estado IN ('aprobado')),
  CONSTRAINT cobros_un_cobro_por_viaje UNIQUE (viaje_id)
);

COMMENT ON TABLE cobros IS
  'Registro del cobro simulado de un viaje finalizado. Un viaje se cobra una sola vez.';
COMMENT ON CONSTRAINT cobros_un_cobro_por_viaje ON cobros IS
  'Garantiza que un viaje no se cobre dos veces, ni siquiera con claves de idempotencia distintas.';

-- Historial del pasajero: sus viajes ordenados por fecha (ya existe
-- viajes_pasajero_creado_en_idx). Historial del chofer: por asignaciones.
CREATE INDEX asignaciones_viaje_chofer_desde_idx ON asignaciones_viaje (chofer_id, desde DESC);
