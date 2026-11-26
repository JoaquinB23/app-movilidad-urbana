// Caso de uso ÚNICO de reasignación (variante H): reasignarViaje(viajeId, motivo).
//
// Lo usan DOS disparadores con el mismo código:
//   1. El worker (src/workers/reasignacion.js) cuando el chofer asignado no
//      reporta ubicación hace más del umbral configurado.
//   2. POST /viajes/:id/rechazar-continuar, cuando el chofer asignado rechaza
//      continuar el viaje.
//
// Garantías de concurrencia (ver tests/concurrencia/):
//   * Orden global de bloqueos: VIAJE -> CHOFER(es). Mismo orden que
//     aceptarOferta; así worker y API no se deadlockean entre sí.
//   * El candidato se elige con SELECT ... FOR UPDATE SKIP LOCKED: dos
//     reasignaciones simultáneas jamás eligen el mismo chofer, y un chofer que
//     está siendo bloqueado por otra transacción simplemente se saltea.
//   * Dentro de la transacción se REVALIDA el umbral de inactividad (cuando se
//     pasa `exigirInactividadS`): si el chofer volvió a reportar entre que el
//     worker lo detectó y que tomó el lock, la reasignación se aborta. Esa es
//     la carrera propia de H: la decide el lock del viaje, y nunca quedan dos
//     choferes ni ninguno (índices únicos parciales de 103 como última red).
//   * El chofer anterior queda LIBRE: su asignación se cierra (hasta = ahora,
//     motivo_fin = motivo) en la misma transacción que abre la nueva. El índice
//     único parcial por chofer garantiza que nunca tenga dos abiertas.
//
// Estados: el viaje reasignado vuelve a 'asignado' (el chofer nuevo todavía no
// salió en camino). La tabla de transiciones de viajes no modela 'reasignar'
// porque no cambia de módulo el estado visible más que 'chofer_en_camino' ->
// 'asignado'; se registra el evento 'reasignar' (actor 'sistema') en
// viajes_eventos para auditoría. Decisión documentada en ADR-005.

import { ErrorDatosInvalidos } from '../viajes/errores.js';
import { ErrorViajeNoReasignable, ErrorSinCandidatos } from './errores.js';

const ESTADOS_REASIGNABLES = Object.freeze(['asignado', 'chofer_en_camino']);

function validarPuertos(repositorios) {
  const requeridos = {
    viajes: ['buscarPorIdParaActualizar', 'guardar', 'registrarEvento'],
    choferes: ['buscarPorIdParaActualizar'],
    asignaciones: ['buscarAbiertaPorViaje', 'cerrar', 'abrir'],
    reasignacion: ['elegirCandidato', 'segundosSinReportar'],
  };
  for (const [nombre, metodos] of Object.entries(requeridos)) {
    for (const metodo of metodos) {
      if (typeof repositorios?.[nombre]?.[metodo] !== 'function') {
        throw new ErrorDatosInvalidos(`Falta el método ${nombre}.${metodo} en la transacción.`);
      }
    }
  }
}

export function crearReasignarViaje({ transaccion, reloj, generadorId, busEventos = null }) {
  if (typeof transaccion?.ejecutar !== 'function') {
    throw new ErrorDatosInvalidos('El puerto Transaccion es obligatorio.');
  }
  if (typeof reloj?.ahora !== 'function') {
    throw new ErrorDatosInvalidos('El puerto Reloj es obligatorio.');
  }
  if (typeof generadorId?.nuevo !== 'function') {
    throw new ErrorDatosInvalidos('El puerto GeneradorId es obligatorio.');
  }

  // `exigirInactividadS`: solo el worker lo pasa; revalida DENTRO de la
  // transacción que el chofer siga sin reportar (SKIP LOCKED + revalidación).
  // `radioBusquedaM`: radio para elegir candidato cerca del origen del viaje.
  return async function reasignarViaje({ viajeId, motivo, asignacionEsperadaId, exigirInactividadS = null, radioBusquedaM = 5000 } = {}) {
    if (typeof viajeId !== 'string' || viajeId.length === 0) {
      throw new ErrorDatosInvalidos('viajeId es obligatorio.');
    }
    if (typeof motivo !== 'string' || motivo.trim().length === 0) {
      throw new ErrorDatosInvalidos('La reasignación requiere un motivo no vacío.');
    }

    const resultado = await transaccion.ejecutar(async (repositorios) => {
      validarPuertos(repositorios);

      // 1) Lock del viaje: a partir de acá ninguna otra transacción (otra
      //    corrida del worker, un rechazar-continuar simultáneo, una
      //    cancelación) puede tocar este viaje hasta el COMMIT.
      const viaje = await repositorios.viajes.buscarPorIdParaActualizar(viajeId);
      if (!viaje) throw new ErrorViajeNoReasignable('El viaje no existe.');
      if (!ESTADOS_REASIGNABLES.includes(viaje.estado)) {
        throw new ErrorViajeNoReasignable();
      }

      const asignacion = await repositorios.asignaciones.buscarAbiertaPorViaje(viajeId);
      if (!asignacion) throw new ErrorViajeNoReasignable('El viaje no tiene asignación abierta.');
      if (asignacionEsperadaId !== undefined && asignacion.id !== asignacionEsperadaId) {
        throw new ErrorViajeNoReasignable('La asignación que se intentó rechazar ya terminó.');
      }

      // 2) Lock del chofer saliente (orden global viaje -> chofer).
      const choferAnterior = await repositorios.choferes.buscarPorIdParaActualizar(asignacion.choferId);

      // 3) Revalidación del umbral DENTRO de la transacción (caso worker).
      //    Si el chofer reportó mientras esperábamos el lock, no se reasigna:
      //    la carrera "reasignación vs. chofer que vuelve" se decide acá, en
      //    el mismo instante, con el viaje bloqueado.
      if (exigirInactividadS !== null) {
        const segundos = await repositorios.reasignacion.segundosSinReportar(asignacion.choferId);
        if (segundos !== null && segundos < exigirInactividadS) {
          throw new ErrorViajeNoReasignable('El chofer volvió a reportar ubicación; no se reasigna.');
        }
      }

      const ahora = reloj.ahora();

      // 4) Candidato: disponible, habilitado, sin asignación abierta, distinto
      //    del saliente, el más cercano al origen. FOR UPDATE SKIP LOCKED.
      const candidato = await repositorios.reasignacion.elegirCandidato({
        origen: viaje.origen,
        excluirChoferId: asignacion.choferId,
        radioM: radioBusquedaM,
      });
      if (!candidato) throw new ErrorSinCandidatos();
      // La consulta que eligió al candidato pudo empezar antes del commit
      // de otro viaje. Con el chofer bloqueado, releemos su asignación.
      if (await repositorios.asignaciones.buscarAbiertaPorChofer(candidato.id)) {
        throw new ErrorSinCandidatos();
      }

      // 5) Cierre y apertura EN LA MISMA transacción: nunca dos choferes
      //    (índice único por viaje) ni ninguno (o se abre la nueva o rollback).
      await repositorios.asignaciones.cerrar(asignacion.id, motivo.trim());
      const nuevaAsignacion = await repositorios.asignaciones.abrir({
        id: generadorId.nuevo(),
        viajeId: viaje.id,
        choferId: candidato.id,
        desde: ahora,
      });

      const estadoAnterior = viaje.estado;
      const viajeActualizado = { ...viaje, estado: 'asignado', actualizadoEn: ahora };
      await repositorios.viajes.guardar(viajeActualizado);
      await repositorios.viajes.registrarEvento({
        viajeId: viaje.id,
        evento: 'reasignar',
        actorTipo: 'sistema',
        actorId: null,
        estadoAnterior,
        estadoNuevo: 'asignado',
        motivo: motivo.trim(),
        en: ahora,
      });

      return {
        viaje: viajeActualizado,
        asignacionCerrada: { ...asignacion, hasta: ahora, motivoFin: motivo.trim() },
        asignacionNueva: nuevaAsignacion,
        choferAnteriorId: choferAnterior?.id ?? asignacion.choferId,
        choferNuevoId: candidato.id,
      };
    });

    // Se publica DESPUES del commit (igual que aceptarOferta): una reasignacion
    // revertida nunca avisa. El evento no lleva ids de choferes: cada SSE
    // revalida contra la base quien participa ahora, y asi el chofer anterior
    // no se entera de quien lo reemplazo.
    busEventos?.publicar(`seguimiento:viaje:${resultado.viaje.id}`, {
      tipo: 'reasignado',
      datos: { viajeId: resultado.viaje.id, estado: resultado.viaje.estado },
    });
    return resultado;
  };
}
