// Helper de autorización POR RECURSO, reutilizable por todos los módulos.
//
// Problema que resuelve: `requerirRol` alcanza para "solo administradores",
// pero no para "el pasajero DE ESTE viaje". Este helper centraliza esa regla
// para que cada ruta no la reinvente (y no se la olvide).
//
// Contrato: `autorizarRecurso({ actor, recurso, reglas })` devuelve el recurso
// si el actor puede verlo y lanza NO_ENCONTRADO en caso contrario. Se usa 404
// (no 403) para recursos ajenos: responder 403 confirmaría que el id existe,
// lo que habilita enumeración de ids (ver tests/seguridad).
//
// `reglas` es { [rol]: (actor, recurso) => boolean }. Un rol ausente no accede.
// Los roles de back-office (operador, administrador) suelen declarar
// `() => true`.

import { ErrorNoEncontrado } from './errores.js';

export function autorizarRecurso({ actor, recurso, reglas }) {
  if (!recurso) throw new ErrorNoEncontrado();
  const regla = Object.prototype.hasOwnProperty.call(reglas ?? {}, actor?.rol)
    ? reglas[actor.rol]
    : null;
  if (typeof regla !== 'function' || !regla(actor, recurso)) {
    throw new ErrorNoEncontrado();
  }
  return recurso;
}

// Reglas canónicas para un VIAJE: las usan ubicaciones, viajes y reasignación.
// El chofer accede si está (o estuvo) asignado; eso lo decide quien llama
// pasando `choferesDelViaje` (ids de asignaciones históricas) o el choferId.
export function reglasDeViaje({ choferesDelViaje = [] } = {}) {
  return {
    pasajero: (actor, viaje) => actor.id === (viaje.pasajeroId ?? viaje.pasajero_id),
    chofer: (actor, viaje) =>
      actor.id === viaje.choferId || choferesDelViaje.includes(actor.id),
    operador: () => true,
    administrador: () => true,
  };
}
