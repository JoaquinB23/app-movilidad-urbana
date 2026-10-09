// Adaptador en memoria de ServicioGeo: recibe una funcion que lista los
// candidatos disponibles ({choferId, lat, lng}) y aplica la seleccion de
// dominio. Se usa en los tests de la busqueda de candidatos (requisito) y como
// adaptador alternativo sin base de datos.
//
// Decision: la fuente de candidatos se inyecta como funcion, no como referencia
// al repositorio, para poder testear el adaptador con un arreglo literal.

import { seleccionarCandidatos } from '../../dominio/ubicaciones/candidatos.js';

export function crearServicioGeoMemoria({ listarCandidatos }) {
  if (typeof listarCandidatos !== 'function') {
    throw new Error("El adaptador en memoria de ServicioGeo requiere 'listarCandidatos'.");
  }

  return {
    async buscarCandidatos({ lat, lng, radioMetros, limite }) {
      const candidatos = await listarCandidatos();
      return seleccionarCandidatos({ candidatos, origen: { lat, lng }, radioMetros, limite });
    },
  };
}
