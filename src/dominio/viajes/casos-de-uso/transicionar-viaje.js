// Ciclo de vida del viaje despues de la asignacion: un UNICO caso de uso para
// todas las transiciones que dispara una persona.
//
//   chofer:    salir_en_camino, iniciar, finalizar, cancelar_chofer
//   pasajero:  cancelar_pasajero
//   operador:  cancelar_operador (motivo obligatorio)
//
// Reglas:
//   * La tabla de transiciones (maquina-estados.js) decide que es valido; este
//     caso de uso agrega la autorizacion POR RECURSO: el pasajero tiene que
//     ser el dueno y el chofer el de la asignacion ABIERTA. Si no, 404 (no se
//     confirma que el viaje existe).
//   * Mismo orden global de bloqueos que aceptarOferta y reasignarViaje:
//     VIAJE -> CHOFER. Por eso una cancelacion y una aceptacion simultaneas se
//     serializan sobre la fila del viaje y nunca se interbloquean.
//   * Al llegar a un estado TERMINAL se cierra la asignacion abierta en la
//     misma transaccion: el chofer queda libre (si no, quedaria "ocupado" sin
//     viaje) y se cancelan las ofertas pendientes del viaje.
//   * finalizar calcula la tarifa FINAL con la misma funcion que la estimacion
//     (calcularTarifa), con distancia RECORRIDA y duracion REAL. La diferencia
//     con la estimacion se explica por esas dos entradas (docs/api.md).
//   * El nuevo estado se publica en el canal SSE despues del commit.

import { ErrorDatosInvalidos, ErrorViajeNoEncontrado } from '../errores.js';
import { aplicarTransicion, esEstadoTerminal } from '../maquina-estados.js';
import { calcularTarifa } from '../tarifa.js';

export const EVENTOS_POR_ROL = Object.freeze({
  chofer: Object.freeze(['salir_en_camino', 'iniciar', 'finalizar', 'cancelar_chofer']),
  pasajero: Object.freeze(['cancelar_pasajero']),
  operador: Object.freeze(['cancelar_operador']),
});

function segundosEntre(desde, hasta) {
  return Math.max(0, Math.round((hasta.getTime() - new Date(desde).getTime()) / 1000));
}

export function crearTransicionarViaje({ transaccion, reloj, parametrosViajes, medidorRecorrido, busEventos = null }) {
  if (typeof transaccion?.ejecutar !== 'function') {
    throw new ErrorDatosInvalidos('El puerto Transaccion es obligatorio.');
  }
  if (typeof reloj?.ahora !== 'function') {
    throw new ErrorDatosInvalidos('El puerto Reloj es obligatorio.');
  }
  if (typeof parametrosViajes?.obtener !== 'function') {
    throw new ErrorDatosInvalidos('Los parametros de viajes son obligatorios.');
  }
  if (typeof medidorRecorrido?.distanciaRecorridaMetros !== 'function') {
    throw new ErrorDatosInvalidos('El puerto MedidorRecorrido es obligatorio.');
  }

  // Tarifa final: misma funcion que la estimacion. Distancia = lo recorrido
  // segun el historial de ubicaciones desde que se inicio el viaje (si no hay
  // puntos suficientes, la estimada); duracion = de iniciar a finalizar. La
  // distancia se acota al maximo cotizable: el viaje ya se hizo y la tarifa
  // final no puede fallar por un desvio.
  async function tarifaFinal(viaje, ahora) {
    const inicio = viaje.historial?.find((e) => e.evento === 'iniciar')?.en;
    const { tarifa } = await parametrosViajes.obtener();
    const recorrida = inicio ? await medidorRecorrido.distanciaRecorridaMetros(viaje.id, new Date(inicio)) : null;
    const distanciaMetros = Math.min(
      Number.isInteger(recorrida) ? recorrida : viaje.distanciaEstimadaMetros,
      tarifa.distanciaMaximaMetros
    );
    const duracionSegundos = inicio ? segundosEntre(inicio, ahora) : viaje.duracionEstimadaSegundos;
    return calcularTarifa({ distanciaMetros, duracionSegundos, parametros: tarifa }).totalCentavos;
  }

  return async function transicionarViaje({ actor, viajeId, evento, motivo = null } = {}) {
    const rol = actor?.rol;
    if (!EVENTOS_POR_ROL[rol]?.includes(evento)) {
      // Un rol que no puede disparar ese evento ni siquiera mira el viaje.
      throw new ErrorViajeNoEncontrado();
    }

    const resultado = await transaccion.ejecutar(async (repos) => {
      // 1) Lock del viaje (orden global: viaje -> chofer).
      const viaje = await repos.viajes.buscarPorIdParaActualizar(viajeId);
      if (!viaje) throw new ErrorViajeNoEncontrado();
      const asignacion = await repos.asignaciones.buscarAbiertaPorViaje(viaje.id);

      // 2) Autorizacion por recurso.
      const autorizado =
        (rol === 'pasajero' && actor.id === viaje.pasajeroId) ||
        (rol === 'chofer' && asignacion?.choferId === actor.id) ||
        rol === 'operador';
      if (!autorizado) throw new ErrorViajeNoEncontrado();

      // 3) Lock del chofer asignado, si hay (despues del viaje).
      if (asignacion) await repos.choferes.buscarPorIdParaActualizar(asignacion.choferId);

      const ahora = reloj.ahora();
      const nuevo = aplicarTransicion(viaje, evento, rol, { en: ahora, motivo });
      const terminal = esEstadoTerminal(nuevo.estado);
      const viajeGuardado = {
        ...nuevo,
        actualizadoEn: ahora,
        tarifaFinalCentavos: evento === 'finalizar' ? await tarifaFinal(viaje, ahora) : viaje.tarifaFinalCentavos,
        motivoCierre: terminal ? (nuevo.historial.at(-1).motivo ?? evento) : viaje.motivoCierre,
      };

      await repos.viajes.guardar(viajeGuardado);
      if (terminal) {
        if (asignacion) await repos.asignaciones.cerrar(asignacion.id, evento);
        await repos.ofertas.cancelarPendientesPorViaje(viaje.id, null, ahora);
      }
      await repos.viajes.registrarEvento({
        viajeId: viaje.id,
        evento,
        actorTipo: rol,
        actorId: actor.id,
        estadoAnterior: viaje.estado,
        estadoNuevo: nuevo.estado,
        motivo: nuevo.historial.at(-1).motivo,
        en: ahora,
      });
      return viajeGuardado;
    });

    busEventos?.publicar(`seguimiento:viaje:${resultado.id}`, {
      tipo: 'estado',
      datos: { viajeId: resultado.id, estado: resultado.estado },
    });
    return {
      id: resultado.id,
      estado: resultado.estado,
      tarifaFinalCentavos: resultado.tarifaFinalCentavos,
      motivoCierre: resultado.motivoCierre,
    };
  };
}
