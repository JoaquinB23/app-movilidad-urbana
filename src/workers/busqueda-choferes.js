// Worker de busqueda continua (opcional): cada intervaloMs retoma los viajes
// que siguen buscando chofer (solicitados y sin oferta pendiente) con el caso
// de uso reintentarBusqueda: les ofrece el viaje al primer chofer disponible
// o, vencido tiempo_busqueda_s, los pasa a sin_choferes.
//
// Con tiempo_busqueda_s = 0 (por defecto) la busqueda continua esta apagada:
// ningun viaje queda "buscando" y el ciclo no consulta la base.

export function crearWorkerBusqueda({
  transaccion, reintentarBusqueda, parametrosViajes, intervaloMs = 2000, limitePorCiclo = 50, logger = console,
}) {
  let timer;
  let enCurso;

  async function procesar() {
    const { tiempoBusquedaSegundos } = await parametrosViajes.obtener();
    if (!(tiempoBusquedaSegundos > 0)) return { procesados: 0, apagado: true };
    const ids = await transaccion.ejecutar((repos) => repos.viajes.detectarBuscando(limitePorCiclo));
    let ofertados = 0;
    for (const viajeId of ids) {
      try {
        const resultado = await reintentarBusqueda({ viajeId });
        if (resultado?.ofertaId) ofertados += 1;
      } catch (err) {
        logger.error?.({ viajeId, err }, 'Error al retomar la busqueda de chofer.');
      }
    }
    return { procesados: ids.length, ofertados };
  }

  // Reentrada: si un ciclo tarda mas que el intervalo, no se superponen.
  function ejecutarCiclo() {
    enCurso ??= procesar().finally(() => { enCurso = undefined; });
    return enCurso;
  }

  return {
    ejecutarCiclo,
    iniciar() {
      if (timer) return;
      timer = setInterval(() => ejecutarCiclo().catch((err) =>
        logger.error?.({ err }, 'Error en el ciclo de busqueda de chofer.')), intervaloMs);
      timer.unref?.();
    },
    async detener() {
      clearInterval(timer);
      timer = undefined;
      await enCurso;
    },
  };
}
