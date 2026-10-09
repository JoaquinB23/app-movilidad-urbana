import { ErrorDatosInvalidos } from '../errores.js';
import { aplicarTransicion } from '../maquina-estados.js';
import { crearEstimarViaje, validarPunto } from './estimar-viaje.js';

function validarParametrosBusqueda(parametros) {
  if (
    !Number.isInteger(parametros.tiempoOfertaSegundos) ||
    parametros.tiempoOfertaSegundos < 0 ||
    !Number.isFinite(parametros.radioBusquedaMetros) ||
    parametros.radioBusquedaMetros < 0 ||
    !Number.isInteger(parametros.maxCandidatos) ||
    parametros.maxCandidatos < 1
  ) {
    throw new ErrorDatosInvalidos('Los parámetros de búsqueda y vencimiento de ofertas son inválidos.');
  }
}

export function crearSolicitarViaje({
  repositorioViajes,
  repositorioOfertas,
  transaccion,
  reloj,
  generadorId,
  estimadorRuta,
  parametrosViajes,
  servicioGeo,
}) {
  const estimarViaje = crearEstimarViaje({ estimadorRuta, parametrosViajes });
  if (
    typeof repositorioViajes?.guardar !== 'function' ||
    typeof repositorioViajes?.registrarEvento !== 'function'
  ) {
    throw new ErrorDatosInvalidos('El puerto RepositorioViajes es obligatorio.');
  }
  if (typeof repositorioOfertas?.crear !== 'function') {
    throw new ErrorDatosInvalidos('El puerto RepositorioOfertas es obligatorio.');
  }
  if (typeof transaccion?.ejecutar !== 'function') {
    throw new ErrorDatosInvalidos('El puerto Transaccion es obligatorio.');
  }
  if (typeof reloj?.ahora !== 'function') {
    throw new ErrorDatosInvalidos('El puerto Reloj es obligatorio.');
  }
  if (typeof generadorId?.nuevo !== 'function') {
    throw new ErrorDatosInvalidos('El puerto GeneradorId es obligatorio.');
  }
  if (typeof servicioGeo?.buscarCandidatos !== 'function') {
    throw new ErrorDatosInvalidos('El puerto ServicioGeo es obligatorio.');
  }

  return async function solicitarViaje({ pasajero, origen, destino } = {}) {
    return transaccion.ejecutar(async () => {
      if (
        pasajero === null ||
        typeof pasajero !== 'object' ||
        typeof pasajero.id !== 'string' ||
        pasajero.id.trim() === '' ||
        (pasajero.rol !== undefined && pasajero.rol !== 'pasajero')
      ) {
        throw new ErrorDatosInvalidos('El pasajero debe ser un usuario válido.');
      }
      validarPunto(origen, 'origen');
      validarPunto(destino, 'destino');

      const [estimacion, parametros] = await Promise.all([
        estimarViaje({ origen, destino }),
        parametrosViajes.obtener(),
      ]);
      validarParametrosBusqueda(parametros);

      const ahora = reloj.ahora();
      if (!(ahora instanceof Date) || !Number.isFinite(ahora.getTime())) {
        throw new ErrorDatosInvalidos('El reloj debe devolver una fecha válida.');
      }
      const viaje = {
        id: generadorId.nuevo(),
        pasajeroId: pasajero.id,
        estado: 'solicitado',
        origen: { lat: origen.lat, lng: origen.lng },
        destino: { lat: destino.lat, lng: destino.lng },
        distanciaEstimadaMetros: estimacion.distanciaMetros,
        duracionEstimadaSegundos: estimacion.duracionSegundos,
        tarifaEstimadaCentavos: estimacion.precioCentavos,
        tarifaFinalCentavos: null,
        motivoCierre: null,
        creadoEn: ahora,
        actualizadoEn: ahora,
        historial: [],
      };
      await repositorioViajes.guardar(viaje);
      await repositorioViajes.registrarEvento({
        viajeId: viaje.id,
        evento: 'viaje_solicitado',
        actorTipo: 'pasajero',
        actorId: pasajero.id,
        estadoAnterior: null,
        estadoNuevo: 'solicitado',
        motivo: null,
        en: ahora,
      });

      const candidatos = await servicioGeo.buscarCandidatos({
        lat: origen.lat,
        lng: origen.lng,
        radioMetros: parametros.radioBusquedaMetros,
        limite: parametros.maxCandidatos,
      });

      if (candidatos.length === 0) {
        const cerrado = aplicarTransicion(viaje, 'agotar_candidatos', 'sistema', { en: ahora });
        await repositorioViajes.guardar(cerrado);
        const entrada = cerrado.historial.at(-1);
        await repositorioViajes.registrarEvento({
          viajeId: viaje.id,
          evento: entrada.evento,
          actorTipo: entrada.actor,
          actorId: null,
          estadoAnterior: entrada.desde,
          estadoNuevo: entrada.hacia,
          motivo: entrada.motivo,
          en: entrada.en,
        });
        return { viaje: cerrado, oferta: null };
      }

      const primero = candidatos[0];
      const oferta = {
        id: generadorId.nuevo(),
        viajeId: viaje.id,
        choferId: primero.choferId,
        estado: 'pendiente',
        orden: 1,
        expiraEn: new Date(ahora.getTime() + parametros.tiempoOfertaSegundos * 1000),
        creadaEn: ahora,
        respondidaEn: null,
      };
      await repositorioOfertas.crear(oferta);
      return { viaje, oferta };
    });
  };
}
