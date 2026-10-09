// Adaptador REAL (version final) de ServicioGeo sobre PostGIS.
//
// Por que es el bueno: filtra y ordena EN LA BASE usando un indice GiST.
//   - ST_DWithin(geography, geography, metros) usa el indice espacial, asi que
//     no recorre toda la tabla: descarta por bounding box y luego refina.
//   - El operador KNN `<->` con ORDER BY + LIMIT permite a PostGIS devolver los
//     mas cercanos sin calcular la distancia de todos.
//
// Decision clave (defendida en el ADR geografico): la columna se guarda como
// `geography(Point,4326)`, NO como `geometry`. Con `geometry` puro, ST_DWithin
// interpretaria el radio en grados y el indice GiST se usaria distinto; con
// `geography` el radio va en METROS sobre elipsoide, que es lo que queremos.
//
// SQL PARAMETRIZADO: nada se concatena; los valores van como $1..$4.
// Orden de parametros: [lng, lat, radioMetros, limite]. Ojo: PostGIS usa
// (x=lng, y=lat). El chofer se une por `usuario_id` (PK de choferes en 001).

import { validarPunto, validarRadio, validarLimite } from '../../dominio/ubicaciones/geo.js';

export const SQL_CANDIDATOS_POSTGIS = `
  SELECT u.chofer_id,
         ST_Y(u.geom::geometry) AS lat,
         ST_X(u.geom::geometry) AS lng,
         ST_Distance(
           u.geom,
           ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
         ) AS distancia
  FROM ubicaciones_actuales u
  JOIN choferes c ON c.usuario_id = u.chofer_id
  WHERE c.disponible = true
    AND c.habilitado = true
    AND ST_DWithin(
      u.geom,
      ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
      $3
    )
  ORDER BY u.geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
  LIMIT $4
`;

export function crearServicioGeoPostgis({ consulta }) {
  if (typeof consulta !== 'function') {
    throw new Error("El adaptador PostGIS de ServicioGeo requiere 'consulta'.");
  }

  return {
    async buscarCandidatos({ lat, lng, radioMetros, limite }) {
      // Validacion de dominio ANTES de tocar la base: falla rapido y evita
      // mandar basura a PostGIS.
      const centro = validarPunto({ lat, lng });
      validarRadio(radioMetros);
      validarLimite(limite);

      const { rows } = await consulta(SQL_CANDIDATOS_POSTGIS, [
        centro.lng,
        centro.lat,
        radioMetros,
        limite,
      ]);

      return rows.map((fila) => ({
        choferId: fila.chofer_id,
        lat: Number(fila.lat),
        lng: Number(fila.lng),
        distanciaMetros: Math.round(Number(fila.distancia)),
      }));
    },
  };
}
