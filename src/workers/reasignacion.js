// Worker de reasignación (VARIANTE H).
//
// Cada `intervaloMs` detecta viajes 'asignado'/'chofer_en_camino' cuyo chofer
// no reporta ubicación hace más del umbral configurado (parámetro
// umbral_reasignacion_s, editable por PUT /admin/parametros) y los reasigna
// SIN que el pasajero vuelva a pedir el viaje.
//
// Diseño de la concurrencia:
//   1. La DETECCIÓN corre en una transacción corta con
//      SELECT ... FOR UPDATE SKIP LOCKED sobre los viajes: si otra instancia
//      del worker (o un rechazar-continuar) está procesando un viaje, esta
//      corrida lo SALTEA en vez de esperarlo o duplicar el trabajo.
//   2. La REASIGNACIÓN de cada viaje usa el caso de uso único reasignarViaje,
//      que vuelve a bloquear el viaje y REVALIDA el umbral DENTRO de su
//      transacción (exigirInactividadS): si el chofer reportó entre la
//      detección y el lock, no se reasigna. Esa revalidación decide la carrera
//      propia de H ("la reasignación vs. el chofer que vuelve justo") en el
//      mismo instante, con el viaje bloqueado.
//   3. SIN_CANDIDATOS no es error fatal: el viaje conserva su chofer actual y
//      se reintenta en el próximo ciclo.
//
// El worker nunca tira el proceso: cada ciclo captura y loguea sus errores.

export function crearWorkerReasignacion({
  transaccion,
  reasignarViaje,
  repositorioAdministracion,
  logger = console,
  intervaloMs = 10000,
  limitePorCiclo = 20,
}) {
  if (typeof transaccion?.ejecutar !== 'function') {
    throw new TypeError('crearWorkerReasignacion requiere el puerto transaccion.');
  }
  if (typeof reasignarViaje !== 'function') {
    throw new TypeError('crearWorkerReasignacion requiere el caso de uso reasignarViaje.');
  }
  if (typeof repositorioAdministracion?.obtenerParametro !== 'function') {
    throw new TypeError('crearWorkerReasignacion requiere repositorioAdministracion.');
  }

  let timer = null;
  let corriendo = false;

  async function ciclo() {
    // Reentrada: si un ciclo tarda más que el intervalo, no se superponen.
    if (corriendo) return { procesados: 0, reasignados: 0, salteado: true };
    corriendo = true;
    try {
      const umbralS = Number(await repositorioAdministracion.obtenerParametro('umbral_reasignacion_s')) || 60;
      const radioM = Number(await repositorioAdministracion.obtenerParametro('radio_busqueda_m')) || 5000;

      // Detección en transacción corta (SKIP LOCKED): los locks se liberan al
      // commit; la reasignación re-bloquea y revalida por su cuenta.
      const detectados = await transaccion.ejecutar((repos) =>
        repos.reasignacion.detectarViajesConChoferInactivo({ umbralS, limite: limitePorCiclo })
      );

      let reasignados = 0;
      for (const { viajeId, choferId, segundosSinReportar } of detectados) {
        try {
          await reasignarViaje({
            viajeId,
            motivo: `sin_reporte_ubicacion: ${Math.round(segundosSinReportar)}s sin reportar (umbral ${umbralS}s)`,
            exigirInactividadS: umbralS,
            radioBusquedaM: radioM,
          });
          reasignados += 1;
          logger.info?.(
            { viajeId, choferAnteriorId: choferId },
            'Viaje reasignado por falta de reporte de ubicación.'
          );
        } catch (error) {
          if (error?.codigo === 'SIN_CANDIDATOS' || error?.codigo === 'VIAJE_NO_REASIGNABLE') {
            // Esperable: sin candidatos ahora, o el chofer volvió a reportar.
            logger.debug?.({ viajeId, codigo: error.codigo }, 'Reasignación no aplicada.');
          } else {
            logger.error?.({ viajeId, err: error }, 'Error reasignando viaje.');
          }
        }
      }
      return { procesados: detectados.length, reasignados };
    } catch (error) {
      logger.error?.({ err: error }, 'Error en ciclo del worker de reasignación.');
      return { procesados: 0, reasignados: 0, error };
    } finally {
      corriendo = false;
    }
  }

  return {
    // Expuesto para tests: ejecuta UN ciclo determinístico sin timers.
    ejecutarCiclo: ciclo,
    iniciar() {
      if (timer) return;
      timer = setInterval(ciclo, intervaloMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    detener() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
