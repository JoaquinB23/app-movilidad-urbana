import { ErrorReglaViaje } from '../errores.js';
import { aplicarTransicion } from '../maquina-estados.js';
import { sigueBuscando } from '../busqueda.js';

function crearContinuacion(deps, porVencimiento) {
  const { repositorioOfertas, repositorioViajes, servicioGeo, parametrosViajes,
    transaccion, reloj, generadorId, busEventos } = deps;

  function sinOferta() {
    if (porVencimiento) return null;
    throw new ErrorReglaViaje('OFERTA_NO_VIGENTE', 'La oferta ya no está vigente.');
  }

  return async function continuar({ ofertaId, actor }) {
    const inicial = await repositorioOfertas.buscarPorId(ofertaId);
    if (!inicial || (!porVencimiento && (actor?.rol !== 'chofer' || actor.id !== inicial.choferId))) {
      if (porVencimiento) return null;
      throw new ErrorReglaViaje('OFERTA_NO_ENCONTRADA', 'La oferta solicitada no fue encontrada.');
    }
    if (inicial.estado !== 'pendiente') return sinOferta();
    // Las lecturas externas usan su propio pool. Se hacen antes de tomar locks.
    const viajeInicial = await repositorioViajes.buscarPorId(inicial.viajeId);
    const parametros = await parametrosViajes.obtener();
    const candidatos = await servicioGeo.buscarCandidatos({
      ...viajeInicial.origen, radioMetros: parametros.radioBusquedaMetros, limite: parametros.maxCandidatos,
    });
    const resultado = await transaccion.ejecutar(async repos => {
      const viaje = await repos.viajes.buscarPorIdParaActualizar(inicial.viajeId);
      const oferta = await repos.ofertas.buscarPorIdParaActualizar(ofertaId);
      const ahora = reloj.ahora();
      if (viaje?.estado !== 'solicitado' || oferta?.estado !== 'pendiente' ||
          (oferta.expiraEn <= ahora) !== porVencimiento) return sinOferta();

      await repos.ofertas.actualizar({ ...oferta, estado: porVencimiento ? 'vencida' : 'rechazada', respondidaEn: ahora });
      const anteriores = await repos.ofertas.listarPorViaje(viaje.id);
      if (anteriores.some(o => o.estado === 'pendiente')) return { viajeId: viaje.id, estado: viaje.estado };
      const contactados = new Set(anteriores.map(o => o.choferId));
      for (const { choferId } of candidatos) {
        if (contactados.size >= parametros.maxCandidatos) break;
        if (contactados.has(choferId)) continue;
        const chofer = await repos.choferes.buscarPorId(choferId);
        if (!chofer?.habilitado || !chofer.disponible || await repos.asignaciones.buscarAbiertaPorChofer(choferId)) continue;
        await repos.ofertas.crear({
          id: generadorId.nuevo(), viajeId: viaje.id, choferId, estado: 'pendiente',
          orden: anteriores.at(-1).orden + 1, creadaEn: ahora, respondidaEn: null,
          expiraEn: new Date(+ahora + parametros.tiempoOfertaSegundos * 1000),
        });
        return { viajeId: viaje.id, estado: viaje.estado };
      }
      // Nadie mas para ofrecer AHORA: si sigue dentro del tiempo de busqueda,
      // el viaje queda buscando (lo retoma el worker de busqueda).
      if (sigueBuscando(viaje, parametros, ahora)) return { viajeId: viaje.id, estado: viaje.estado };
      const cerrado = aplicarTransicion(viaje, 'agotar_candidatos', 'sistema', { en: ahora });
      await repos.viajes.guardar({ ...cerrado, actualizadoEn: ahora });
      await repos.viajes.registrarEvento({ viajeId: viaje.id, evento: 'agotar_candidatos', actorTipo: 'sistema',
        actorId: null, estadoAnterior: viaje.estado, estadoNuevo: cerrado.estado, motivo: null, en: ahora });
      return { viajeId: viaje.id, estado: cerrado.estado };
    });
    if (resultado?.estado === 'sin_choferes') {
      busEventos?.publicar('seguimiento:viaje:' + resultado.viajeId, { tipo: 'estado', datos: resultado });
    }
    return resultado;
  };
}

export function crearRechazarOferta(deps) {
  return crearContinuacion(deps, false);
}

export function crearVencerOferta(deps) {
  return crearContinuacion(deps, true);
}
