// Adaptador INGENUO de ServicioGeo (la "version mala", a proposito).
//
// Obligatorio por el bloque 7: hay que implementar la version que bloquea para
// poder medirla y compararla contra la final. Esta version trae TODOS los
// choferes disponibles con su ubicacion y calcula la distancia en JavaScript.
//
// Por que es mala:
//   1) Transfiere N filas al proceso Node (I/O + memoria) aunque se pidan 5.
//   2) El filtro y el orden recorren todo en el hilo de JavaScript: con miles de
//      choferes, el calculo de Haversine bloquea el event loop.
// A proposito NO se le agrega indice ni limite en SQL: la comparacion de
// mediciones tiene que ser honesta (seria trampa ponerle LIMIT en la base).

import { seleccionarCandidatos } from '../../dominio/ubicaciones/candidatos.js';

export const SQL_CANDIDATOS_INGENUO = `
  SELECT u.chofer_id,
         ST_Y(u.geom::geometry) AS lat,
         ST_X(u.geom::geometry) AS lng
  FROM ubicaciones_actuales u
  JOIN choferes c ON c.usuario_id = u.chofer_id
  WHERE c.disponible = true
    AND c.habilitado = true
`;

export function crearServicioGeoIngenuo({ consulta }) {
  if (typeof consulta !== 'function') {
    throw new Error("El adaptador ingenuo de ServicioGeo requiere 'consulta'.");
  }

  return {
    async buscarCandidatos({ lat, lng, radioMetros, limite }) {
      const { rows } = await consulta(SQL_CANDIDATOS_INGENUO, []);
      const candidatos = rows.map((fila) => ({
        choferId: fila.chofer_id,
        lat: Number(fila.lat),
        lng: Number(fila.lng),
      }));
      // La seleccion valida origen/radio/limite y aplica la misma regla.
      return seleccionarCandidatos({
        candidatos,
        origen: { lat, lng },
        radioMetros,
        limite,
      });
    },
  };
}
