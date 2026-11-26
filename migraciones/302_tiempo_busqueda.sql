-- Migración 302: búsqueda continua de chofer.
--
-- Si al pedir un viaje no hay choferes disponibles (o todos rechazan o dejan
-- vencer la oferta), el viaje NO pasa enseguida a "sin choferes": queda
-- "solicitado" (buscando) y el worker de búsqueda se lo ofrece al primer
-- chofer que aparezca. Recién cuando pasan tiempo_busqueda_s desde el pedido
-- sin encontrar a nadie, el viaje pasa a sin_choferes (enunciado 6.5: el
-- estado "sin choferes disponibles" sigue existiendo).
--
-- Por defecto 0 = APAGADA: el viaje pasa a sin_choferes en cuanto se agota
-- la lista, exactamente como piden el enunciado (6.5) y el contrato de
-- POST /viajes del acuerdo de trabajo. El administrador la prende con
-- PUT /admin/parametros {"tiempo_busqueda_s": 300} (busqueda "al estilo Uber").

INSERT INTO parametros (clave, valor, descripcion) VALUES
  ('tiempo_busqueda_s', '0'::jsonb,
   'Segundos que un viaje sigue buscando chofer antes de pasar a sin_choferes (0 = no esperar).')
ON CONFLICT (clave) DO NOTHING;
