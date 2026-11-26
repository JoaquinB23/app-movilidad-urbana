// GET /metrics (formato Prometheus) para Grafana Alloy.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import express from 'express';

import { crearMetricasPrometheus } from '../../src/infra/http/metricas-prometheus.js';

async function montar(opciones) {
  const metricas = crearMetricasPrometheus(opciones);
  const app = express();
  app.use(metricas.middleware);
  app.get('/metrics', metricas.ruta);
  app.get('/viajes/:id', (req, res) => res.json({ id: req.params.id }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, cerrar: () => new Promise((r) => server.close(r)) };
}

test('expone las metricas de Node, el lag del event loop y la duracion por PATRON de ruta', async () => {
  const app = await montar();
  try {
    for (const id of ['a1', 'b2', 'c3']) await fetch(`${app.base}/viajes/${id}`);
    await fetch(`${app.base}/no-existe`);
    const res = await fetch(`${app.base}/metrics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/plain/);
    const texto = await res.text();

    assert.match(texto, /nodejs_eventloop_lag_p99_seconds/);
    assert.match(texto, /process_resident_memory_bytes/);
    // Tres ids distintos -> UNA sola serie con el patron, count 3.
    assert.match(texto, /http_request_duration_seconds_count\{[^}]*ruta="\/viajes\/:id"[^}]*\} 3/);
    assert.doesNotMatch(texto, /ruta="\/viajes\/a1"/);
    assert.match(texto, /ruta="sin_ruta"[^}]*status="404"/);
  } finally {
    await app.cerrar();
  }
});

test('publica el estado de la cola del historial y del pool de la base', async () => {
  const app = await montar({
    colaHistorial: { estadisticas: () => ({ pendientes: 7, fallos: 2, descartados: 1 }) },
    pool: { totalCount: 10, idleCount: 4, waitingCount: 3 },
  });
  try {
    const texto = await (await fetch(`${app.base}/metrics`)).text();
    assert.match(texto, /cola_historial_pendientes\{[^}]*\} 7/);
    assert.match(texto, /cola_historial_fallos\{[^}]*\} 2/);
    assert.match(texto, /cola_historial_descartados\{[^}]*\} 1/);
    assert.match(texto, /pg_pool_conexiones\{[^}]*estado="en_espera"[^}]*\} 3/);
  } finally {
    await app.cerrar();
  }
});

test('con METRICAS_TOKEN configurado exige el Bearer correcto', async () => {
  const app = await montar({ token: 'token-de-metricas-largo' });
  try {
    assert.equal((await fetch(`${app.base}/metrics`)).status, 401);
    assert.equal((await fetch(`${app.base}/metrics`, { headers: { authorization: 'Bearer otro' } })).status, 401);
    const ok = await fetch(`${app.base}/metrics`, { headers: { authorization: 'Bearer token-de-metricas-largo' } });
    assert.equal(ok.status, 200);
  } finally {
    await app.cerrar();
  }
});
