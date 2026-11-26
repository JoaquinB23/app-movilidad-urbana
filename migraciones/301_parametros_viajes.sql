-- Migración 301: parámetros que la tarifa y la búsqueda de candidatos del
-- módulo de viajes necesitan y que la 300 no sembró. Con esto, TODOS los
-- valores que usan estimarViaje y solicitarViaje viven en la base y se editan
-- por PUT /admin/parametros (catálogo cerrado en src/infra/http/rutas/admin.js).
--
-- Solo agrega filas; no cambia el schema. ON CONFLICT DO NOTHING: no pisa un
-- valor que un administrador ya haya cambiado.

INSERT INTO parametros (clave, valor, descripcion) VALUES
  ('tarifa_minima_centavos', '200000'::jsonb,
   'Importe mínimo de un viaje en centavos; la tarifa nunca queda por debajo.'),
  ('distancia_maxima_m', '50000'::jsonb,
   'Distancia máxima en metros que se cotiza; un viaje más largo se rechaza (422).'),
  ('max_candidatos', '5'::jsonb,
   'Cantidad máxima de choferes candidatos que se consideran al solicitar un viaje.')
ON CONFLICT (clave) DO NOTHING;
