// Logs JSON con el id de pedido propagado por AsyncLocalStorage (bloque 4).

import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { setTimeout as dormir } from 'node:timers/promises';

import { contextoPedido, crearLogger } from '../../src/infra/observabilidad.js';

function capturar() {
  const lineas = [];
  const destino = new Writable({
    write(trozo, _codificacion, listo) {
      lineas.push(...trozo.toString().trim().split('\n').map((l) => JSON.parse(l)));
      listo();
    },
  });
  return { lineas, destino };
}

test('un log emitido varios await despues lleva el id del pedido, sin pasarlo a mano', async () => {
  const { lineas, destino } = capturar();
  const logger = crearLogger({ destino });

  async function casoDeUsoProfundo() {
    await dormir(5);
    await Promise.resolve();
    logger.info('dentro del caso de uso');
  }

  await Promise.all([
    contextoPedido.run({ idCorrelacion: 'pedido-A' }, casoDeUsoProfundo),
    contextoPedido.run({ idCorrelacion: 'pedido-B' }, casoDeUsoProfundo),
  ]);

  const ids = lineas.map((l) => l.idCorrelacion).sort();
  assert.deepEqual(ids, ['pedido-A', 'pedido-B'], 'cada pedido conserva su propio id aunque corran intercalados');
});

test('fuera de un pedido (workers, arranque) el log no inventa un id', () => {
  const { lineas, destino } = capturar();
  crearLogger({ destino }).info('worker');
  assert.equal(lineas[0].idCorrelacion, undefined);
  assert.equal(lineas[0].msg, 'worker');
});
