import { ErrorActorNoAutorizado } from '../errores.js';

export function crearListarOfertasVigentes({ repositorioOfertas, reloj }) {
  return async function listarOfertasVigentes({ actor }) {
    if (actor?.rol !== 'chofer' || !actor.id) {
      throw new ErrorActorNoAutorizado(actor?.rol, 'listar_ofertas', 'chofer');
    }
    return repositorioOfertas.listarVigentes(actor.id, reloj.ahora());
  };
}
