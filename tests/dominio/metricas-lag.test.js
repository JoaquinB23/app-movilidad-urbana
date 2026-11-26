// Unidades del lag del event loop en /metricas (P1). monitorEventLoopDelay
// mide en NANOSEGUNDOS; /metricas publica milisegundos (lagMaxMs, lagP99Ms).
// Se bloquea el event loop ~150 ms a proposito y se verifica que el valor
// reportado este en el orden de los milisegundos, no 1e6 veces mas grande.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as dormir } from 'node:timers/promises';

import { crearMonitoreoMetricas } from '../../src/infra/http/metricas.js';
import { crearRegistroMetricasMemoria } from '../../src/infra/memoria/registro-metricas-memoria.js';

function bloquearEventLoop(ms) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) { /* espera activa a proposito */ }
}

function leerMetricas(monitoreo) {
  let cuerpo;
  monitoreo.ruta({}, { json: (valor) => { cuerpo = valor; } });
  return cuerpo;
}

test('lagMaxMs y lagP99Ms se reportan en milisegundos', async () => {
  const monitoreo = crearMonitoreoMetricas({
    registroMetricas: crearRegistroMetricasMemoria(),
    resolucionLagMs: 10,
  });
  try {
    await dormir(30);
    bloquearEventLoop(150);
    await dormir(30);

    const { eventLoop } = leerMetricas(monitoreo);
    // Un bloqueo de 150 ms tiene que verse como ~150 ms de lag maximo. Con el
    // bug de unidades daba ~150.000.000.
    assert.ok(eventLoop.lagMaxMs >= 100, `lagMaxMs muy bajo: ${eventLoop.lagMaxMs}`);
    assert.ok(eventLoop.lagMaxMs < 5000, `lagMaxMs no esta en ms: ${eventLoop.lagMaxMs}`);
    assert.ok(eventLoop.lagP99Ms <= eventLoop.lagMaxMs);
    assert.ok(eventLoop.lagP99Ms < 5000, `lagP99Ms no esta en ms: ${eventLoop.lagP99Ms}`);
  } finally {
    monitoreo.detener();
  }
});

test('la memoria se reporta en MB con nombres que lo dicen', () => {
  const monitoreo = crearMonitoreoMetricas({ registroMetricas: crearRegistroMetricasMemoria() });
  try {
    const { memoria } = leerMetricas(monitoreo);
    // Un proceso de Node usa decenas de MB; en bytes serian decenas de millones.
    assert.ok(memoria.rssMb > 1 && memoria.rssMb < 100_000, `rssMb: ${memoria.rssMb}`);
  } finally {
    monitoreo.detener();
  }
});
