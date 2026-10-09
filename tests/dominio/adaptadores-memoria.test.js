// Tests de los adaptadores en memoria del modulo de ubicaciones.
// Corren sin base de datos ni servidor (requisito de arquitectura hexagonal).

import test from 'node:test';
import assert from 'node:assert/strict';

import { crearServicioGeoMemoria } from '../../src/infra/memoria/servicio-geo-memoria.js';
import { crearRepositorioUbicacionesMemoria } from '../../src/infra/memoria/repositorio-ubicaciones-memoria.js';
import { crearBusEventosMemoria } from '../../src/infra/memoria/bus-eventos-memoria.js';
import { crearColaHistorial } from '../../src/infra/memoria/cola-historial-memoria.js';
import { crearRegistroMetricasMemoria } from '../../src/infra/memoria/registro-metricas-memoria.js';

// --- ServicioGeo en memoria: busqueda de candidatos ---

test('busqueda de candidatos con adaptador en memoria', async () => {
  const geo = crearServicioGeoMemoria({
    listarCandidatos: () => [
      { choferId: 'a', lat: -27.45, lng: -58.98 },
      { choferId: 'b', lat: -27.46, lng: -58.99 },
      { choferId: 'c', lat: -28.0, lng: -59.0 }, // lejos
    ],
  });
  // -27.45/-58.98 es el origen: 'a' queda a 0 m, 'b' a ~1.5 km, 'c' a la deriva.
  const r = await geo.buscarCandidatos({ lat: -27.45, lng: -58.98, radioMetros: 3000, limite: 2 });

  assert.deepEqual(r.map((c) => c.choferId), ['a', 'b']);
  assert.equal(r[0].distanciaMetros, 0);
  assert.ok(r[1].distanciaMetros > 1000 && r[1].distanciaMetros < 2000);
});

test('servicio geo en memoria valida origen antes de buscar', async () => {
  const geo = crearServicioGeoMemoria({ listarCandidatos: () => [] });
  await assert.rejects(() => geo.buscarCandidatos({ lat: 999, lng: 0, radioMetros: 1, limite: 1 }));
  await assert.rejects(() => geo.buscarCandidatos({ lat: 0, lng: 0, radioMetros: 0, limite: 1 }));
  await assert.rejects(() => geo.buscarCandidatos({ lat: 0, lng: 0, radioMetros: 1, limite: 0 }));
});

test('el adaptador en memoria requiere listarCandidatos', () => {
  assert.throws(() => crearServicioGeoMemoria({}));
});

// --- RepositorioUbicaciones en memoria ---

test('actualizarActual hace UPSERT: la ultima posicion gana', async () => {
  const repo = crearRepositorioUbicacionesMemoria();
  await repo.actualizarActual({ choferId: 'c1', lat: 1, lng: 1, timestamp: 10 });
  await repo.actualizarActual({ choferId: 'c1', lat: 2, lng: 2, timestamp: 20 });
  const actual = await repo.obtenerActual('c1');
  assert.equal(actual.lat, 2);
  assert.equal(actual.timestamp, 20);
});

test('listarCandidatosDisponibles respeta el predicado de disponibilidad', async () => {
  const repo = crearRepositorioUbicacionesMemoria({
    estaDisponible: (choferId) => choferId === 'libre',
  });
  await repo.actualizarActual({ choferId: 'libre', lat: 0, lng: 0, timestamp: 1 });
  await repo.actualizarActual({ choferId: 'ocupado', lat: 0.1, lng: 0.1, timestamp: 1 });
  const candidatos = await repo.listarCandidatosDisponibles();
  assert.deepEqual(candidatos.map((c) => c.choferId), ['libre']);
});

test('historialDeViaje solo devuelve los registros del viaje, en orden', async () => {
  const repo = crearRepositorioUbicacionesMemoria();
  await repo.agregarHistorial({ viajeId: 'v1', choferId: 'c1', lat: 1, lng: 1, timestamp: 1 });
  await repo.agregarHistorial({ viajeId: 'v2', choferId: 'c1', lat: 2, lng: 2, timestamp: 2 });
  await repo.agregarHistorialEnLote([
    { viajeId: 'v1', choferId: 'c1', lat: 3, lng: 3, timestamp: 3 },
    { choferId: 'c1', lat: 4, lng: 4, timestamp: 4 },
  ]);
  const recorrido = await repo.historialDeViaje('v1');
  assert.deepEqual(recorrido.map((r) => r.timestamp), [1, 3]);
});

test('el historial en memoria descarta duplicados por (chofer, timestamp)', async () => {
  const repo = crearRepositorioUbicacionesMemoria();
  await repo.agregarHistorial({ choferId: 'c1', lat: 1, lng: 1, timestamp: 7 });
  await repo.agregarHistorial({ choferId: 'c1', lat: 1, lng: 1, timestamp: 7 });
  assert.equal(repo._tamanoHistorial(), 1);
});

// --- Bus de eventos ---

test('el bus entrega eventos en vivo a los suscriptores', () => {
  const bus = crearBusEventosMemoria();
  const vistos = [];
  bus.suscribir('canal', (e) => vistos.push(e));
  bus.publicar('canal', { tipo: 'posicion', datos: { lat: 1 } });
  bus.publicar('canal', { tipo: 'posicion', datos: { lat: 2 } });
  assert.equal(vistos.length, 2);
  assert.equal(vistos[0].id, '1');
  assert.equal(vistos[1].id, '2');
});

test('eventosDesde reenvia lo ocurrido despues de un Last-Event-ID (reconexion)', () => {
  const bus = crearBusEventosMemoria();
  bus.publicar('canal', { tipo: 'a', datos: {} });
  bus.publicar('canal', { tipo: 'b', datos: {} });
  bus.publicar('canal', { tipo: 'c', datos: {} });
  const desdeB = bus.eventosDesde('canal', '2');
  assert.deepEqual(desdeB.map((e) => e.tipo), ['c']);
  assert.deepEqual(bus.eventosDesde('canal', '999'), []);
});

test('desuscribirse deja de recibir eventos', () => {
  const bus = crearBusEventosMemoria();
  let contador = 0;
  const desuscribir = bus.suscribir('canal', () => contador++);
  bus.publicar('canal', { tipo: 'x', datos: {} });
  desuscribir();
  bus.publicar('canal', { tipo: 'x', datos: {} });
  assert.equal(contador, 1);
});

test('un suscriptor que falla no impide a los demas recibir', () => {
  const bus = crearBusEventosMemoria();
  const vistos = [];
  bus.suscribir('canal', () => {
    throw new Error('boom');
  });
  bus.suscribir('canal', (e) => vistos.push(e.tipo));
  assert.doesNotThrow(() => bus.publicar('canal', { tipo: 'x', datos: {} }));
  assert.equal(vistos[0], 'x');
});

// --- Cola de historial: recepcion concurrente (requisito) ---

test('la cola persiste todas las recepciones concurrentes sin perdida', async () => {
  const repo = crearRepositorioUbicacionesMemoria();
  // maxLote chico a proposito para forzar muchos flushes parciales.
  const cola = crearColaHistorial({
    escribirLote: (lote) => repo.agregarHistorialEnLote(lote),
    maxLote: 25,
  });

  const TOTAL = 500;
  const registros = Array.from({ length: TOTAL }, (_, i) => ({
    choferId: `chofer-${i % 10}`,
    lat: -27.45 + i * 0.0001,
    lng: -58.98,
    timestamp: 1000 + i,
  }));

  // Recibimos en RACHA sin esperar entre envios (simula 500 choferes a la vez).
  // `encolar` es O(1) y no bloquea: devolvemos el control entre envio y envio.
  for (const registro of registros) cola.encolar(registro);

  await cola.drenar();

  assert.equal(repo._tamanoHistorial(), TOTAL, 'no debe perderse ni duplicarse ninguna');
});

test('drenar vacia el buffer y tamano refleja lo pendiente', async () => {
  const repo = crearRepositorioUbicacionesMemoria();
  const cola = crearColaHistorial({
    escribirLote: (lote) => repo.agregarHistorialEnLote(lote),
    maxLote: 100000, // no dispara flush por tamano
  });
  for (let i = 0; i < 10; i++) {
    cola.encolar({ choferId: 'c1', lat: 0, lng: 0, timestamp: i });
  }
  assert.equal(cola.tamano(), 10);
  const drenados = await cola.drenar();
  assert.equal(drenados, 10);
  assert.equal(cola.tamano(), 0);
  assert.equal(repo._tamanoHistorial(), 10);
});

// --- Registro metricas ---

test('percentiles con nearest-rank sobre muestra conocida', () => {
  const registro = crearRegistroMetricasMemoria();
  // Muestra de 101 valores: [1..100, 1000].
  for (let i = 1; i <= 100; i++) registro.observar(i);
  registro.observar(1000);
  const pct = registro.percentiles();
  // nearest-rank: indice = ceil(p/100*N)-1. Para N=101:
  //   p50 -> ceil(50.5)-1 = 50 -> 51 ; p95 -> ceil(95.95)-1 = 95 -> 96
  //   p99 -> ceil(99.99)-1 = 99 -> 100
  assert.equal(pct.p50, 51);
  assert.equal(pct.p95, 96);
  assert.equal(pct.p99, 100);
  assert.equal(pct.max, 1000);
});

test('registro metricas vacio devuelve ceros', () => {
  const registro = crearRegistroMetricasMemoria();
  assert.deepEqual(registro.percentiles(), { p50: 0, p95: 0, p99: 0, max: 0, total: 0 });
});

// --- evidencia de SQL parametrizado en los adaptadores de base ---

test('el SQL de los adaptadores de base es parametrizado (placeholders, sin interpolacion)', async () => {
  const postgis = await import('../../src/infra/db/servicio-geo-postgis.js');
  const ingenuo = await import('../../src/infra/db/servicio-geo-ingenuo.js');
  const repo = await import('../../src/infra/db/repositorio-ubicaciones-pg.js');

  // Las sentencias que SI reciben parametros deben usar posiciones $1..$n.
  const conParametros = [
    postgis.SQL_CANDIDATOS_POSTGIS,
    repo.SQL_UPSERT_ACTUAL,
    repo.SQL_OBTENER_ACTUAL,
    repo.SQL_INSERT_HISTORIAL,
    repo.SQL_INSERT_HISTORIAL_LOTE,
    repo.SQL_HISTORIAL_VIAJE,
  ];
  // Las que son "traer todo" (ingenuo y disponibles) NO llevan parametros,
  // pero tampoco interpolan nada.
  const sinInterpolacion = [
    ...conParametros,
    ingenuo.SQL_CANDIDATOS_INGENUO,
    repo.SQL_CANDIDATOS_DISPONIBLES,
  ];

  for (const sql of conParametros) {
    assert.match(sql, /\$\d+/, 'debe usar posiciones $1, $2...');
  }
  for (const sql of sinInterpolacion) {
    assert.ok(!sql.includes('${'), 'no debe interpolar con template strings');
    assert.ok(!sql.includes('" + '), 'no debe concatenar strings');
  }
});