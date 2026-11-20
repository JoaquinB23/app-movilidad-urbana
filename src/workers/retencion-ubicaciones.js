// Worker de retencion del historial de ubicaciones.
//
// Cada `intervaloMs` ejecuta `purgarHistorial(dias)`, que en PostgreSQL llama a
// la funcion `purgar_ubicaciones_historial(dias)` (migracion 200): un DELETE
// atomico, por rango de timestamp y apoyado en `idx_ubicaciones_historial_ts`.
//
// Decisiones:
//   1. NO se superpone consigo mismo: si una purga tarda mas que el intervalo,
//      el siguiente tick se saltea. Evita acumular conexiones y DELETE
//      concurrentes dentro de la misma instancia.
//   2. Los errores se capturan y loguean: un fallo de base no tumba la API ni
//      deja una promesa sin manejar.
//   3. `detener()` limpia el timer. Sin eso, el proceso no apaga con SIGTERM
//      (el intervalo lo mantiene vivo). `unref()` es una segunda red: el timer
//      no impide que Node salga si nadie mas lo necesita.
//   4. Dos instancias de la API pueden correr el worker a la vez: el DELETE es
//      atomico e idempotente. Una borra las filas viejas y la otra encuentra 0;
//      nunca hay doble borrado ni datos inconsistentes. El costo es trabajo
//      duplicado (dos scans), no correccion. Si molestara, se puede tomar un
//      advisory lock (`pg_try_advisory_lock`) para que solo una instancia
//      purge por ciclo; se documenta como alternativa, no se implementa.

import {
  RETENCION_DIAS_POR_DEFECTO,
  validarDiasRetencion,
} from '../dominio/ubicaciones/retencion.js';

const INTERVALO_POR_DEFECTO_MS = 60 * 60 * 1000; // 1 hora

export function crearWorkerRetencion({
  repositorioUbicaciones,
  dias = RETENCION_DIAS_POR_DEFECTO,
  intervaloMs = INTERVALO_POR_DEFECTO_MS,
  logger = console,
} = {}) {
  if (typeof repositorioUbicaciones?.purgarHistorial !== 'function') {
    throw new TypeError(
      'crearWorkerRetencion requiere repositorioUbicaciones con purgarHistorial.'
    );
  }
  validarDiasRetencion(dias);
  if (!Number.isInteger(intervaloMs) || intervaloMs <= 0) {
    throw new TypeError('intervaloMs debe ser un entero positivo.');
  }

  let timer = null;
  let corriendo = false;

  async function ejecutar() {
    // Reentrada: si la purga anterior sigue en curso, no se superpone.
    if (corriendo) return { borradas: 0, salteado: true };
    corriendo = true;
    try {
      const borradas = await repositorioUbicaciones.purgarHistorial(dias);
      logger.info?.({ borradas, dias }, 'Retencion de ubicaciones ejecutada.');
      return { borradas };
    } catch (error) {
      logger.error?.({ err: error, dias }, 'Error en la retencion de ubicaciones.');
      return { borradas: 0, error };
    } finally {
      corriendo = false;
    }
  }

  return {
    // Expuesto para tests y para una ejecucion manual: un ciclo determinista.
    ejecutarAhora: ejecutar,
    iniciar() {
      if (timer) return; // idempotente
      timer = setInterval(ejecutar, intervaloMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    detener() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    estaActivo() {
      return timer !== null;
    },
  };
}
