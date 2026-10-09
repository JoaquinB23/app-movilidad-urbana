// Carga de fuego con autocannon para las mediciones (docs/mediciones.md).
//
// Mide un endpoint LIVIANO (/health o /ready) mientras el simulador de choferes
// o una tarea pesada golpean el sistema: asi se ve el impacto en la latencia del
// endpoint que no deberia degradarse.
//
// Uso:
//   node scripts/carga/carga-autocannon.js --health          # /health
//   node scripts/carga/carga-autocannon.js --ubicacion       # POST ubicacion
//
// Variables:
//   API_BASE        base de la API
//   DURACION_S      duracion de la corrida en segundos (default 30, minimo exigido)
//   CONEXIONES      conexiones simultaneas (default 20)
//   BATCH_TOKEN_HOLDER  token de demo si la API lo pide

import autocannon from 'autocannon';

const API_BASE = process.env.API_BASE ?? 'http://localhost:3000';
const DURACION_S = Number(process.env.DURACION_S ?? 30);
const CONEXIONES = Number(process.env.CONEXIONES ?? 20);
const TOKEN = process.env.BATCH_TOKEN_HOLDER ?? '';

const objetivo = process.argv[2]?.replace(/^--/, '') ?? 'health';

function construirConfig() {
  if (objetivo === 'health' || objetivo === 'ready') {
    return { url: `${API_BASE}/${objetivo}`, method: 'GET' };
  }
  if (objetivo === 'ubicacion') {
    return {
      url: `${API_BASE}/choferes/me/ubicacion`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ lat: -27.4514, lng: -58.9866, timestamp: Date.now() }),
    };
  }
  throw new Error(`Objetivo desconocido: ${objetivo}. Usa --health, --ready o --ubicacion.`);
}

const instancia = autocannon({
  ...construirConfig(),
  connections: CONEXIONES,
  duration: DURACION_S,
  // Para repetibilidad: mismo client, misma carga.
  titles: `${objetivo} (${DURACION_S}s, ${CONEXIONES} conexiones)`,
});

autocannon.track(instancia, {
  renderResultsTable: true,
  renderLatencyTable: true,
});

instancia.on('done', () => {
  // El histograma p50/p95/p99 ya lo imprime track(); termina con el resumen.
});

process.once('SIGINT', () => instancia.stop());