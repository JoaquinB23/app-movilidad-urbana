import { ErrorDatosInvalidos, ErrorReglaViaje } from '../errores.js';
import { aplicarTransicion } from '../maquina-estados.js';

function validarFecha(fecha) {
  if (!(fecha instanceof Date) || !Number.isFinite(fecha.getTime())) {
    throw new ErrorDatosInvalidos('El reloj debe devolver una fecha válida.');
  }
}

function validarPuertos(repositorios) {
  const requeridos = {
    viajes: ['buscarPorIdParaActualizar', 'guardar', 'registrarEvento'],
    ofertas: ['buscarPorId', 'buscarPorIdParaActualizar', 'actualizar', 'cancelarPendientesPorViaje'],
    choferes: ['buscarPorIdParaActualizar'],
    asignaciones: ['buscarAbiertaPorChofer', 'abrir'],
  };
  for (const [nombre, metodos] of Object.entries(requeridos)) {
    for (const metodo of metodos) {
      if (typeof repositorios?.[nombre]?.[metodo] !== 'function') {
        throw new ErrorDatosInvalidos(`Falta el método ${nombre}.${metodo} en la transacción.`);
      }
    }
  }
}

export function crearAceptarOferta({ transaccion, reloj, generadorId }) {
  if (typeof transaccion?.ejecutar !== 'function') {
    throw new ErrorDatosInvalidos('El puerto Transaccion es obligatorio.');
  }
  if (typeof reloj?.ahora !== 'function') {
    throw new ErrorDatosInvalidos('El puerto Reloj es obligatorio.');
  }
  if (typeof generadorId?.nuevo !== 'function') {
    throw new ErrorDatosInvalidos('El puerto GeneradorId es obligatorio.');
  }

  return async function aceptarOferta({ actor, ofertaId } = {}) {
    return transaccion.ejecutar(async (repositorios) => {
      validarPuertos(repositorios);
      const ofertaInicial = await repositorios.ofertas.buscarPorId(ofertaId);
      if (!ofertaInicial) {
        throw new ErrorReglaViaje('OFERTA_NO_ENCONTRADA', 'La oferta solicitada no fue encontrada.');
      }

      // El orden global de bloqueos es viaje, chofer y oferta para evitar deadlocks.
      const viaje = await repositorios.viajes.buscarPorIdParaActualizar(ofertaInicial.viajeId);
      const chofer = await repositorios.choferes.buscarPorIdParaActualizar(ofertaInicial.choferId);
      const oferta = await repositorios.ofertas.buscarPorIdParaActualizar(ofertaId);

      if (
        !viaje ||
        !chofer ||
        !oferta ||
        viaje.id !== oferta.viajeId ||
        chofer.id !== oferta.choferId ||
        oferta.id !== ofertaId ||
        oferta.viajeId !== ofertaInicial.viajeId ||
        oferta.choferId !== ofertaInicial.choferId ||
        actor?.rol !== 'chofer' ||
        actor.id !== oferta.choferId
      ) {
        throw new ErrorReglaViaje('OFERTA_NO_ENCONTRADA', 'La oferta solicitada no fue encontrada.');
      }

      const ahora = reloj.ahora();
      validarFecha(ahora);

      if (oferta.estado !== 'pendiente' || oferta.expiraEn <= ahora) {
        throw new ErrorReglaViaje('OFERTA_NO_VIGENTE', 'La oferta ya no está vigente.');
      }
      if (viaje.estado !== 'solicitado') {
        throw new ErrorReglaViaje('VIAJE_NO_DISPONIBLE', 'El viaje ya no está disponible.');
      }
      if (!chofer.habilitado) {
        throw new ErrorReglaViaje('CHOFER_NO_DISPONIBLE', 'El chofer no está habilitado o disponible.');
      }
      if (await repositorios.asignaciones.buscarAbiertaPorChofer(chofer.id)) {
        throw new ErrorReglaViaje('CHOFER_OCUPADO', 'El chofer ya tiene una asignación abierta.');
      }
      if (!chofer.disponible) {
        throw new ErrorReglaViaje('CHOFER_NO_DISPONIBLE', 'El chofer no está habilitado o disponible.');
      }

      const viajeActualizado = {
        ...aplicarTransicion(viaje, 'aceptar_oferta', 'chofer', { en: ahora }),
        actualizadoEn: ahora,
      };
      const ofertaAceptada = { ...oferta, estado: 'aceptada', respondidaEn: ahora };
      const asignacion = {
        id: generadorId.nuevo(),
        viajeId: viaje.id,
        choferId: chofer.id,
        desde: ahora,
        hasta: null,
        motivoFin: null,
      };

      await repositorios.viajes.guardar(viajeActualizado);
      await repositorios.ofertas.actualizar(ofertaAceptada);
      await repositorios.ofertas.cancelarPendientesPorViaje(viaje.id, oferta.id, ahora);
      await repositorios.asignaciones.abrir(asignacion);
      await repositorios.viajes.registrarEvento({
        viajeId: viaje.id,
        evento: 'aceptar_oferta',
        actorTipo: 'chofer',
        actorId: actor.id,
        estadoAnterior: viaje.estado,
        estadoNuevo: viajeActualizado.estado,
        motivo: null,
        en: ahora,
      });

      return { viaje: viajeActualizado, oferta: ofertaAceptada, asignacion };
    });
  };
}
