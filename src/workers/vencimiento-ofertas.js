export function crearWorkerVencimiento({ transaccion, vencerOferta, reloj, intervaloMs = 1000,
  limitePorCiclo = 50, logger = console }) {
  let timer;
  let enCurso;
  async function procesar() {
    const ids = await transaccion.ejecutar(repos => repos.ofertas.detectarVencidas(reloj.ahora(), limitePorCiclo));
    for (const ofertaId of ids) {
      try {
        await vencerOferta({ ofertaId });
      } catch (err) {
        logger.error({ ofertaId, err }, 'Error al vencer la oferta.');
      }
    }
  }
  function ejecutarCiclo() {
    enCurso ??= procesar().finally(() => { enCurso = undefined; });
    return enCurso;
  }
  return {
    ejecutarCiclo,
    iniciar() {
      if (timer) return;
      timer = setInterval(() => ejecutarCiclo().catch(err =>
        logger.error({ err }, 'Error al detectar ofertas vencidas.')), intervaloMs);
      timer.unref();
    },
    async detener() {
      clearInterval(timer);
      timer = undefined;
      await enCurso;
    },
  };
}
