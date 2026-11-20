// Tests de la politica de retencion del historial de ubicaciones (sin base ni HTTP).
//
// Se cubre:
//   1. El adaptador en memoria borra SOLO lo anterior al corte y devuelve cuantas
//      filas borro (misma semantica que la funcion SQL).
//   2. `dias <= 0` (o no entero) se rechaza antes de tocar datos.
//   3. El worker no se superpone consigo mismo, captura errores y `detener()`
//      limpia el intervalo (si no, el proceso no apaga con SIGTERM).
//   4. Dos workers en paralelo (dos instancias de la API) son idempotentes: el
//      total borrado no se duplica y el dato final es el mismo.

import test from 'node:test';
import assert from 'node:assert/strict';

import { crearRepositorioUbicacionesMemoria } from '../../src/infra/memoria/repositorio-ubicaciones-memoria.js';
import { crearWorkerRetencion } from '../../src/workers/retencion-ubicaciones.js';
import { verificarRepositorioUbicaciones } from '../../src/dominio/ubicaciones/puertos.js';
import { ErrorDatosInvalidos } from '../../src/dominio/ubicaciones/errores.js';

const DIA_MS = 24 * 60 * 60 * 1000;
const AHORA = Date.UTC(2026, 0, 15, 12, 0, 0);
const LOGGER_SILENCIOSO = { info() {}, error() {} };

function crearRepo({ ahora = AHORA } = {}) {
  return crearRepositorioUbicacionesMemoria({ ahora: () => ahora });
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function esperarHasta(predicado, timeoutMs = 1000) {
  const inicio = Date.now();
  while (!predicado()) {
    if (Date.now() - inicio > timeoutMs) {
      throw new Error('Se agoto el tiempo esperando la condicion.');
    }
    await esperar(5);
  }
}

// --- adaptador en memoria ---

test('purgarHistorial: borra solo lo anterior al corte y devuelve el conteo', async () => {
  const repo = crearRepo();
  await repo.agregarHistorialEnLote([
    { choferId: 'c1', lat: 0, lng: 0, timestamp: AHORA - 100 * DIA_MS, viajeId: 'v1' },
    { choferId: 'c1', lat: 0, lng: 0, timestamp: AHORA - 91 * DIA_MS, viajeId: 'v1' },
    { choferId: 'c1', lat: 0, lng: 0, timestamp: AHORA - 90 * DIA_MS, viajeId: 'v1' }, // borde: se conserva
    { choferId: 'c1', lat: 0, lng: 0, timestamp: AHORA - 89 * DIA_MS, viajeId: 'v1' },
    { choferId: 'c1', lat: 0, lng: 0, timestamp: AHORA, viajeId: 'v1' },
  ]);
  assert.equal(repo._tamanoHistorial(), 5);

  const borradas = await repo.purgarHistorial(90);

  assert.equal(borradas, 2);
  assert.equal(repo._tamanoHistorial(), 3);
  const recorrido = await repo.historialDeViaje('v1');
  assert.equal(recorrido.length, 3);
  assert.ok(recorrido.every((r) => Number(r.timestamp) >= AHORA - 90 * DIA_MS));
});

test('purgarHistorial: rechaza dias <= 0, no entero o no numerico', async () => {
  const repo = crearRepo();
  await repo.agregarHistorialEnLote([
    { choferId: 'c1', lat: 0, lng: 0, timestamp: AHORA - 100 * DIA_MS },
  ]);

  for (const dias of [0, -1, -90, 1.5, '90', null, undefined, Number.NaN]) {
    await assert.rejects(() => repo.purgarHistorial(dias), ErrorDatosInvalidos);
  }
  assert.equal(repo._tamanoHistorial(), 1, 'un dias invalido no debe borrar nada');
});

test('el puerto RepositorioUbicaciones exige purgarHistorial', () => {
  const adaptadorIncompleto = {
    actualizarActual() {},
    obtenerActual() {},
    agregarHistorial() {},
    agregarHistorialEnLote() {},
    historialDeViaje() {},
    listarCandidatosDisponibles() {},
  };
  assert.throws(() => verificarRepositorioUbicaciones(adaptadorIncompleto), /purgarHistorial/);
});

// --- worker ---

test('el worker valida configuracion y dependencias', () => {
  const repo = crearRepo();
  assert.throws(() => crearWorkerRetencion({}), TypeError);
  assert.throws(
    () => crearWorkerRetencion({ repositorioUbicaciones: {}, dias: 90, intervaloMs: 1000 }),
    TypeError
  );
  for (const dias of [0, -1, 1.5, '90']) {
    assert.throws(
      () => crearWorkerRetencion({ repositorioUbicaciones: repo, dias, intervaloMs: 1000 }),
      ErrorDatosInvalidos
    );
  }
  assert.throws(
    () => crearWorkerRetencion({ repositorioUbicaciones: repo, dias: 90, intervaloMs: 0 }),
    TypeError
  );
});

test('ejecutarAhora: llama al repositorio con los dias y devuelve el conteo', async () => {
  const llamadas = [];
  const repo = {
    async purgarHistorial(dias) {
      llamadas.push(dias);
      return 7;
    },
  };
  const worker = crearWorkerRetencion({
    repositorioUbicaciones: repo,
    dias: 90,
    intervaloMs: 60000,
    logger: LOGGER_SILENCIOSO,
  });

  const resultado = await worker.ejecutarAhora();

  assert.deepEqual(llamadas, [90]);
  assert.equal(resultado.borradas, 7);
});

test('ejecutarAhora: un error del repositorio se loguea y no escapa', async () => {
  const errores = [];
  const repo = {
    async purgarHistorial() {
      throw new Error('base caida');
    },
  };
  const worker = crearWorkerRetencion({
    repositorioUbicaciones: repo,
    dias: 90,
    intervaloMs: 60000,
    logger: { info() {}, error: (detalle, mensaje) => errores.push([detalle, mensaje]) },
  });

  const resultado = await worker.ejecutarAhora();

  assert.ok(resultado.error instanceof Error);
  assert.equal(resultado.borradas, 0);
  assert.equal(errores.length, 1);
});

test('un ciclo lento no se superpone con el siguiente (reentrada)', async () => {
  let resolver;
  let llamadas = 0;
  const repo = {
    purgarHistorial() {
      llamadas += 1;
      return new Promise((resolverPromesa) => {
        resolver = resolverPromesa;
      });
    },
  };
  const worker = crearWorkerRetencion({
    repositorioUbicaciones: repo,
    dias: 90,
    intervaloMs: 60000,
    logger: LOGGER_SILENCIOSO,
  });

  const primero = worker.ejecutarAhora();
  const segundo = await worker.ejecutarAhora();

  assert.equal(segundo.salteado, true);
  assert.equal(segundo.borradas, 0);
  resolver(3);
  const resultadoPrimero = await primero;
  assert.equal(resultadoPrimero.borradas, 3);
  assert.equal(llamadas, 1);
});

test('detener() limpia el intervalo: no quedan timers colgados', async () => {
  let llamadas = 0;
  const repo = {
    async purgarHistorial() {
      llamadas += 1;
      return 0;
    },
  };
  const worker = crearWorkerRetencion({
    repositorioUbicaciones: repo,
    dias: 90,
    intervaloMs: 10,
    logger: LOGGER_SILENCIOSO,
  });

  worker.iniciar();
  assert.equal(worker.estaActivo(), true);
  await esperarHasta(() => llamadas >= 1);

  worker.detener();
  assert.equal(worker.estaActivo(), false);
  const alDetener = llamadas;
  await esperar(60);
  assert.equal(llamadas, alDetener, 'no debe ejecutarse despues de detener');

  worker.detener(); // idempotente
  assert.equal(worker.estaActivo(), false);
});

test('iniciar() dos veces no duplica el intervalo', async () => {
  let llamadas = 0;
  const repo = {
    async purgarHistorial() {
      llamadas += 1;
      return 0;
    },
  };
  const worker = crearWorkerRetencion({
    repositorioUbicaciones: repo,
    dias: 90,
    intervaloMs: 20,
    logger: LOGGER_SILENCIOSO,
  });

  worker.iniciar();
  worker.iniciar();
  await esperarHasta(() => llamadas >= 1);
  // Si hubiera dos timers, en dos intervalos habria ~4 llamadas; con uno, ~2.
  await esperar(50);
  worker.detener();
  assert.ok(llamadas <= 3, `se esperaban pocas llamadas, hubo ${llamadas}`);
});

test('dos workers en paralelo (dos instancias): idempotentes, el total no se duplica', async () => {
  const repo = crearRepo();
  await repo.agregarHistorialEnLote([
    { choferId: 'c1', lat: 0, lng: 0, timestamp: AHORA - 100 * DIA_MS, viajeId: 'v1' },
    { choferId: 'c1', lat: 0, lng: 0, timestamp: AHORA - 95 * DIA_MS, viajeId: 'v1' },
    { choferId: 'c1', lat: 0, lng: 0, timestamp: AHORA - 1 * DIA_MS, viajeId: 'v1' },
  ]);
  const workerA = crearWorkerRetencion({
    repositorioUbicaciones: repo,
    dias: 90,
    intervaloMs: 60000,
    logger: LOGGER_SILENCIOSO,
  });
  const workerB = crearWorkerRetencion({
    repositorioUbicaciones: repo,
    dias: 90,
    intervaloMs: 60000,
    logger: LOGGER_SILENCIOSO,
  });

  const [a, b] = await Promise.all([workerA.ejecutarAhora(), workerB.ejecutarAhora()]);

  assert.equal(a.borradas + b.borradas, 2);
  assert.equal(repo._tamanoHistorial(), 1);
});
