import { ErrorDatosInvalidos, ErrorViajeNoEncontrado } from '../errores.js';

export function crearObtenerViaje({ repositorioViajes, repositorioAsignaciones }) {
  if (!repositorioViajes || typeof repositorioViajes.buscarPorId !== 'function') {
    throw new ErrorDatosInvalidos('El puerto RepositorioViajes es obligatorio.');
  }
  if (
    !repositorioAsignaciones ||
    typeof repositorioAsignaciones.buscarAbiertaPorViaje !== 'function'
  ) {
    throw new ErrorDatosInvalidos('El puerto RepositorioAsignaciones es obligatorio.');
  }

  return async function obtenerViaje({ actor, viajeId } = {}) {
    const viaje = await repositorioViajes.buscarPorId(viajeId);
    if (!viaje) throw new ErrorViajeNoEncontrado();

    if (actor?.rol === 'operador' || actor?.rol === 'administrador') return viaje;
    if (actor?.rol === 'pasajero' && actor.id === viaje.pasajeroId) return viaje;
    if (actor?.rol === 'chofer' && typeof actor.id === 'string') {
      const asignacion = await repositorioAsignaciones.buscarAbiertaPorViaje(viaje.id);
      if (asignacion?.choferId === actor.id) return viaje;
    }
    throw new ErrorViajeNoEncontrado();
  };
}
