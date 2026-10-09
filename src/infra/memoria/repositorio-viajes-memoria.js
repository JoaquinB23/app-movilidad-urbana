// Adaptador en memoria de RepositorioViajes (solo lectura, para ubicaciones).
// El adaptador real lo posee el modulo de viajes; aca se da la version falsa
// para tests y para poder arrancar el SSE sin base.

import { ErrorDatosInvalidos } from '../../dominio/ubicaciones/errores.js';

const ESTADOS_ACTIVOS = new Set([
  'solicitado',
  'asignado',
  'chofer_en_camino',
  'en_curso',
]);

function normalizar(viaje) {
  if (!viaje || typeof viaje.id !== 'string' || viaje.id.length === 0) {
    throw new ErrorDatosInvalidos('Cada viaje sembrado debe tener un id no vacio.');
  }
  return {
    id: viaje.id,
    pasajeroId: viaje.pasajeroId ?? '',
    choferId: viaje.choferId ?? null,
    estado: viaje.estado ?? 'solicitado',
    origen: viaje.origen ?? null,
  };
}

export function crearRepositorioViajesMemoria({ viajes = [] } = {}) {
  const tabla = new Map();
  for (const viaje of viajes) tabla.set(viaje.id, normalizar(viaje));

  return {
    async buscarPorId(viajeId) {
      const fila = tabla.get(viajeId);
      return fila ? { ...fila, origen: fila.origen ? { ...fila.origen } : null } : null;
    },

    async buscarActivoPorChofer(choferId) {
      for (const fila of tabla.values()) {
        if (fila.choferId === choferId && ESTADOS_ACTIVOS.has(fila.estado)) {
          return { ...fila, origen: fila.origen ? { ...fila.origen } : null };
        }
      }
      return null;
    },

    _sembrar(viaje) {
      tabla.set(viaje.id, normalizar(viaje));
    },
  };
}