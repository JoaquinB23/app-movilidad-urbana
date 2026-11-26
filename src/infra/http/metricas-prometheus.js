// GET /metrics en formato Prometheus (lo scrapea Grafana Alloy y lo grafica
// el dashboard). Convive con GET /metricas (JSON para administradores), que
// es el que se usa para la tabla de docs/mediciones.md.
//
// Que expone:
//   * Metricas por defecto de Node (prom-client): CPU, memoria, GC y lag del
//     event loop (nodejs_eventloop_lag_*_seconds, medido con
//     monitorEventLoopDelay, en SEGUNDOS como manda la convencion).
//   * http_request_duration_seconds{metodo,ruta,status}: histograma por
//     PATRON de ruta (/viajes/:id), nunca por URL concreta: cada id crearia
//     una serie nueva y Prometheus explota en cardinalidad.
//   * Cola del historial: pendientes, fallos y descartados.
//   * Pool de PostgreSQL: conexiones totales, ociosas y pedidos en espera
//     (si hay espera, el cuello es la base y no Node).
//
// Acceso: si METRICAS_TOKEN esta configurado se exige `Authorization: Bearer`
// con ese valor (comparacion en tiempo constante). Sin token, /metrics queda
// abierto: pensado para una red interna donde solo llega el scraper.

import { timingSafeEqual } from 'node:crypto';

import client from 'prom-client';

const BUCKETS_SEGUNDOS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

function tokenValido(recibido, esperado) {
  const a = Buffer.from(recibido ?? '');
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function crearMetricasPrometheus({ colaHistorial = null, pool = null, token = null } = {}) {
  const registro = new client.Registry();
  registro.setDefaultLabels({ servicio: 'app-movilidad-urbana' });
  client.collectDefaultMetrics({ register: registro, eventLoopMonitoringPrecision: 10 });

  const duracion = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duracion de los pedidos HTTP por patron de ruta.',
    labelNames: ['metodo', 'ruta', 'status'],
    buckets: BUCKETS_SEGUNDOS,
    registers: [registro],
  });

  if (colaHistorial) {
    const gauge = (name, help, campo) => new client.Gauge({
      name,
      help,
      registers: [registro],
      collect() { this.set(colaHistorial.estadisticas()[campo]); },
    });
    gauge('cola_historial_pendientes', 'Posiciones encoladas sin escribir en la base.', 'pendientes');
    gauge('cola_historial_fallos', 'Escrituras de lote fallidas desde el arranque (se reintentan).', 'fallos');
    gauge('cola_historial_descartados', 'Posiciones descartadas por el tope de memoria desde el arranque.', 'descartados');
  }

  if (pool) {
    new client.Gauge({
      name: 'pg_pool_conexiones',
      help: 'Conexiones del pool de PostgreSQL por estado.',
      labelNames: ['estado'],
      registers: [registro],
      collect() {
        this.set({ estado: 'total' }, pool.totalCount);
        this.set({ estado: 'ociosas' }, pool.idleCount);
        this.set({ estado: 'en_espera' }, pool.waitingCount);
      },
    });
  }

  const middleware = (req, res, next) => {
    const fin = duracion.startTimer();
    res.on('finish', () => {
      // req.route existe solo si alguna ruta coincidio: se usa su patron.
      const ruta = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'sin_ruta';
      fin({ metodo: req.method, ruta, status: String(res.statusCode) });
    });
    next();
  };

  const ruta = async (req, res) => {
    if (token) {
      const [esquema, valor] = (req.get('authorization') ?? '').split(' ');
      if (esquema !== 'Bearer' || !tokenValido(valor, token)) {
        return res.status(401).json({
          error: { codigo: 'NO_AUTENTICADO', mensaje: 'Token de metricas invalido.', idCorrelacion: res.locals?.idCorrelacion ?? null },
        });
      }
    }
    res.set('Content-Type', registro.contentType);
    res.end(await registro.metrics());
  };

  return { middleware, ruta, registro };
}
