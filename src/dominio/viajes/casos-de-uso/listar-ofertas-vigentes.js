import { ErrorActorNoAutorizado } from '../errores.js';

// Ofertas propias, pendientes y vigentes del chofer. Si hay repositorioViajes,
// cada oferta trae ademas DONDE es el viaje (origen, destino y precio
// estimado): el chofer decide si aceptar sabiendo a donde tiene que ir, como
// en cualquier app de viajes. Solo se ven los viajes de las ofertas propias.
export function crearListarOfertasVigentes({ repositorioOfertas, reloj, repositorioViajes = null }) {
  return async function listarOfertasVigentes({ actor }) {
    if (actor?.rol !== 'chofer' || !actor.id) {
      throw new ErrorActorNoAutorizado(actor?.rol, 'listar_ofertas', 'chofer');
    }
    const ofertas = await repositorioOfertas.listarVigentes(actor.id, reloj.ahora());
    if (!repositorioViajes) return ofertas;
    // Pocas ofertas por chofer (una por viaje pendiente): una lectura por oferta.
    return Promise.all(ofertas.map(async (oferta) => {
      const viaje = await repositorioViajes.buscarPorId(oferta.viajeId);
      return viaje
        ? { ...oferta, origen: viaje.origen, destino: viaje.destino, tarifaEstimadaCentavos: viaje.tarifaEstimadaCentavos }
        : oferta;
    }));
  };
}
