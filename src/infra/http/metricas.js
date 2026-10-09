// Monitoreo del modulo: middleware que mide latencia de cada request y ruta
// GET /metricas que la expone junto con lag del event loop y memoria.

import { monitorEventLoopDelay } from 'node:perf_hooks';

export function crearMonitoreoMetricas({ registroMetricas, resolucionLagMs = 20 } = {}) {
  if (!registroMetricas || typeof registroMetricas.observar !== 'function') {
    throw new Error('crearMonitoreoMetricas requiere un RegistroMetricas.');
  }
  const lag = monitorEventLoopDelay({ resolution: resolucionLagMs });
  lag.enable();


  const middleware = (req, res, next) => {
    const inicio = process.hrtime.bigint();
    res.on('finish', () => {
      const ns = process.hrtime.bigint() - inicio;
      registroMetricas.observar(Number(ns) / 1e6);
    });
    next();
  };

  const ruta = (req, res) => {
    const latenciaMs = registroMetricas.percentiles();
    const memoria = process.memoryUsage();
    res.json({
      latenciaMs,
      eventLoop: {
        lagMaxMs: Math.max(0, lag.max || 0),
        lagP99Ms: Math.max(0, lag.percentile(99) || 0),
      },
      memoria: {
        rssMb: memoria.rss / 1e6,
        heapUsadoMb: memoria.heapUsed / 1e6,
        heapTotalMb: memoria.heapTotal / 1e6,
      },
    });
  };

  return {
    middleware,
    ruta,
    detener() {
      lag.disable();
    },
  };
}