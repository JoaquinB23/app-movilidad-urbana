// Busqueda continua (opcional, parametro tiempo_busqueda_s > 0): retoma un
// viaje "solicitado" que se quedo sin oferta pendiente (no habia choferes, o
// todos rechazaron o dejaron vencer la oferta).
//
//   * Si ahora hay un chofer disponible que todavia no fue contactado para este
//     viaje, se le ofrece (como al pedirlo).
//   * Si no hay y ya paso tiempoBusquedaSegundos desde el pedido, el viaje pasa
//     a sin_choferes y se avisa por el SSE.
//   * Si no hay y todavia hay tiempo, no cambia nada: se reintenta en el
//     proximo ciclo del worker.
//
// Concurrencia: mismo orden que el resto (primero el VIAJE, FOR UPDATE). Se
// revalida dentro de la transaccion que siga solicitado y sin oferta
// pendiente, asi un rechazo o una cancelacion simultanea no producen dos
// ofertas ni una oferta para un viaje cancelado.

import { ErrorDatosInvalidos } from '../errores.js';
import { aplicarTransicion } from '../maquina-estados.js';
import { sigueBuscando } from '../busqueda.js';

// Se piden mas candidatos que maxCandidatos: los mas cercanos pueden ser
// justamente los que ya rechazaron este viaje.
const CANDIDATOS_EXTRA = 20;

export function crearReintentarBusqueda({
  repositorioViajes, servicioGeo, parametrosViajes, transaccion, reloj, generadorId, busEventos = null,
}) {
  for (const [nombre, puerto, metodo] of [
    ['RepositorioViajes', repositorioViajes, 'buscarPorId'],
    ['ServicioGeo', servicioGeo, 'buscarCandidatos'],
    ['ParametrosViajes', parametrosViajes, 'obtener'],
    ['Transaccion', transaccion, 'ejecutar'],
    ['Reloj', reloj, 'ahora'],
    ['GeneradorId', generadorId, 'nuevo'],
  ]) {
    if (typeof puerto?.[metodo] !== 'function') throw new ErrorDatosInvalidos(`El puerto ${nombre} es obligatorio.`);
  }

  return async function reintentarBusqueda({ viajeId }) {
    const inicial = await repositorioViajes.buscarPorId(viajeId);
    if (!inicial || inicial.estado !== 'solicitado') return null;
    const parametros = await parametrosViajes.obtener();
    // Lecturas externas antes de tomar locks (igual que continuar-oferta).
    const candidatos = await servicioGeo.buscarCandidatos({
      ...inicial.origen,
      radioMetros: parametros.radioBusquedaMetros,
      limite: parametros.maxCandidatos + CANDIDATOS_EXTRA,
    });

    const resultado = await transaccion.ejecutar(async (repos) => {
      const viaje = await repos.viajes.buscarPorIdParaActualizar(viajeId);
      if (viaje?.estado !== 'solicitado') return null;
      const anteriores = await repos.ofertas.listarPorViaje(viaje.id);
      if (anteriores.some((o) => o.estado === 'pendiente')) return null;
      const ahora = reloj.ahora();

      const contactados = new Set(anteriores.map((o) => o.choferId));
      for (const { choferId } of candidatos) {
        if (contactados.has(choferId)) continue;
        const chofer = await repos.choferes.buscarPorId(choferId);
        if (!chofer?.habilitado || !chofer.disponible || await repos.asignaciones.buscarAbiertaPorChofer(choferId)) continue;
        const oferta = {
          id: generadorId.nuevo(),
          viajeId: viaje.id,
          choferId,
          estado: 'pendiente',
          orden: (anteriores.at(-1)?.orden ?? 0) + 1,
          creadaEn: ahora,
          respondidaEn: null,
          expiraEn: new Date(ahora.getTime() + parametros.tiempoOfertaSegundos * 1000),
        };
        await repos.ofertas.crear(oferta);
        return { viajeId: viaje.id, estado: viaje.estado, ofertaId: oferta.id };
      }

      if (sigueBuscando(viaje, parametros, ahora)) return null;

      const cerrado = aplicarTransicion(viaje, 'agotar_candidatos', 'sistema', { en: ahora });
      await repos.viajes.guardar({ ...cerrado, actualizadoEn: ahora });
      await repos.viajes.registrarEvento({
        viajeId: viaje.id, evento: 'agotar_candidatos', actorTipo: 'sistema', actorId: null,
        estadoAnterior: viaje.estado, estadoNuevo: cerrado.estado, motivo: null, en: ahora,
      });
      return { viajeId: viaje.id, estado: cerrado.estado };
    });

    if (resultado?.estado === 'sin_choferes') {
      busEventos?.publicar(`seguimiento:viaje:${resultado.viajeId}`, {
        tipo: 'estado', datos: { viajeId: resultado.viajeId, estado: resultado.estado },
      });
    }
    return resultado;
  };
}
