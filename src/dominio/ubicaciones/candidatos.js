// Seleccion de choferes candidatos por cercania (dominio puro).
//
// Esta funcion es la REGLA de negocio compartida por los tres adaptadores de
// ServicioGeo:
//   - el adaptador PostGIS filtra/ordena en la base (ST_DWithin + KNN);
//   - el adaptador ingenuo trae TODOS los choferes y llama a esta funcion;
//   - el adaptador en memoria la usa directo sobre su mapa.
// Tener una sola implementacion de "que es un candidato valido" evita que los
// adaptadores diverjan en el resultado.
//
// Decision de diseno: la distancia de salida se redondea a entero (metros) para
// que el resultado sea determinista y comparable entre tests. El filtro por
// radio se hace con el valor SIN redondear para no incluir/excluir por un metro
// de error de redondeo.

import {
  distanciaHaversineMetros,
  validarPunto,
  validarRadio,
  validarLimite,
} from './geo.js';
import { ErrorDatosInvalidos } from './errores.js';

function normalizarCandidato(candidato) {
  if (candidato === null || typeof candidato !== 'object') {
    throw new ErrorDatosInvalidos('Cada candidato debe ser un objeto.');
  }
  const choferId = candidato.choferId ?? candidato.id;
  if (typeof choferId !== 'string' || choferId.length === 0) {
    throw new ErrorDatosInvalidos('Cada candidato debe tener un choferId no vacio.');
  }
  // Puede venir {lat,lng} o {ubicacion:{lat,lng}}. Se aceptan las dos formas.
  const punto = candidato.ubicacion ?? candidato;
  return { choferId, punto: validarPunto(punto) };
}

export function seleccionarCandidatos({ candidatos, origen, radioMetros, limite } = {}) {
  if (!Array.isArray(candidatos)) {
    throw new ErrorDatosInvalidos('`candidatos` debe ser un arreglo.');
  }
  const centro = validarPunto(origen);
  const radio = validarRadio(radioMetros);
  const tope = validarLimite(limite);

  const resultado = [];
  for (const candidato of candidatos) {
    const { choferId, punto } = normalizarCandidato(candidato);
    const distancia = distanciaHaversineMetros(centro, punto);
    // Borde exacto (== radio) es valido, igual que en tarifa con el maximo.
    if (distancia <= radio) {
      resultado.push({
        choferId,
        lat: punto.lat,
        lng: punto.lng,
        distanciaMetros: Math.round(distancia),
      });
    }
  }

  // Orden determinista: por distancia y, a igual distancia, por choferId.
  // El desempate es importante para que dos corridas den el mismo `limite`
  // cuando hay empates de distancia (evita flakiness en los tests).
  resultado.sort((a, b) => a.distanciaMetros - b.distanciaMetros || a.choferId.localeCompare(b.choferId));

  return resultado.slice(0, tope);
}
