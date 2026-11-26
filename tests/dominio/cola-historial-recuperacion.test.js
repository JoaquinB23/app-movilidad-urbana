// Recuperacion de lotes del historial (P1). Antes, si escribirLote fallaba
// (base caida, timeout), el lote ya habia salido del buffer y el error se
// tragaba: las posiciones se perdian sin rastro. Ahora el lote vuelve al
// frente de la cola, se reintenta con espera creciente y, si la caida dura
// tanto que la memoria se llenaria, se descartan las MAS VIEJAS contandolas.

import test from 'node:test';
import assert from 'node:assert/strict';

import { crearColaHistorial } from '../../src/infra/memoria/cola-historial-memoria.js';

function registro(n) {
  return { choferId: 'c1', lat: -27.45, lng: -58.98, timestamp: n, viajeId: null };
}

// Base falsa que falla las primeras `fallas` escrituras y guarda el resto.
function crearBaseFalsa({ fallas = 0 } = {}) {
  const escritos = [];
  let restantes = fallas;
  return {
    escritos,
    llamadas: 0,
    async escribirLote(lote) {
      this.llamadas += 1;
      if (restantes > 0) {
        restantes -= 1;
        throw new Error('base caida');
      }
      escritos.push(...lote);
    },
  };
}

function relojManual(inicio = 0) {
  let actual = inicio;
  return { ahora: () => actual, avanzar: (ms) => { actual += ms; } };
}

test('si la escritura falla, el lote vuelve a la cola y drenar lo reintenta sin perder nada', async () => {
  const base = crearBaseFalsa({ fallas: 1 });
  const cola = crearColaHistorial({ escribirLote: (l) => base.escribirLote(l), maxLote: 100 });
  for (let i = 1; i <= 5; i += 1) cola.encolar(registro(i));

  await assert.rejects(cola.drenar(), /base caida/);
  assert.equal(cola.tamano(), 5, 'el lote fallido sigue pendiente');
  assert.equal(base.escritos.length, 0);

  await cola.drenar();
  assert.deepEqual(base.escritos.map((r) => r.timestamp), [1, 2, 3, 4, 5]);
  assert.equal(cola.tamano(), 0);
  assert.deepEqual(cola.estadisticas(), { pendientes: 0, fallos: 1, descartados: 0 });
});

test('el lote reencolado conserva el orden por delante de lo que llego despues', async () => {
  const base = crearBaseFalsa({ fallas: 1 });
  const cola = crearColaHistorial({ escribirLote: (l) => base.escribirLote(l), maxLote: 100 });
  cola.encolar(registro(1));
  cola.encolar(registro(2));
  await assert.rejects(cola.drenar());
  cola.encolar(registro(3));
  await cola.drenar();
  assert.deepEqual(base.escritos.map((r) => r.timestamp), [1, 2, 3]);
});

test('un flush en segundo plano que falla no pierde el lote y avisa por alFallar', async () => {
  const base = crearBaseFalsa({ fallas: 1 });
  const avisos = [];
  const cola = crearColaHistorial({
    escribirLote: (l) => base.escribirLote(l),
    maxLote: 2,
    alFallar: (info) => avisos.push(info),
  });
  cola.encolar(registro(1));
  cola.encolar(registro(2)); // alcanza maxLote -> flush en segundo plano (falla)
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(cola.tamano(), 2);
  assert.equal(avisos.length, 1);
  assert.equal(avisos[0].reencolados, 2);
  assert.match(avisos[0].error.message, /base caida/);

  await cola.drenar();
  assert.deepEqual(base.escritos.map((r) => r.timestamp), [1, 2]);
});

test('durante la caida no martilla la base: espera creciente entre reintentos automaticos', async () => {
  const base = crearBaseFalsa({ fallas: 100 });
  const reloj = relojManual();
  const cola = crearColaHistorial({
    escribirLote: (l) => base.escribirLote(l),
    maxLote: 1,
    esperaInicialMs: 1000,
    ahora: reloj.ahora,
  });

  cola.encolar(registro(1)); // primer intento: falla
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 2; i <= 20; i += 1) cola.encolar(registro(i)); // dentro de la espera: no reintenta
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(base.llamadas, 1, 'no reintenta antes de que venza la espera');

  reloj.avanzar(1000);
  cola.encolar(registro(21)); // vencio la espera: reintenta (y vuelve a fallar)
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(base.llamadas, 2);

  reloj.avanzar(1000); // la espera ahora es 2000 ms: todavia no
  cola.encolar(registro(22));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(base.llamadas, 2, 'la espera se duplica tras cada falla');
  assert.equal(cola.tamano(), 22, 'nada se perdio mientras tanto');
});

test('tras una escritura exitosa la espera vuelve al valor inicial', async () => {
  const base = crearBaseFalsa({ fallas: 1 });
  const reloj = relojManual();
  const cola = crearColaHistorial({
    escribirLote: (l) => base.escribirLote(l), maxLote: 1, esperaInicialMs: 1000, ahora: reloj.ahora,
  });
  cola.encolar(registro(1));
  await new Promise((resolve) => setImmediate(resolve));
  reloj.avanzar(1000);
  cola.encolar(registro(2)); // reintento exitoso: escribe 1 (y deja 2 pendiente)
  await new Promise((resolve) => setImmediate(resolve));
  cola.encolar(registro(3)); // sin espera: flush inmediato
  await new Promise((resolve) => setImmediate(resolve));
  await cola.drenar();
  assert.deepEqual(base.escritos.map((r) => r.timestamp), [1, 2, 3]);
});

test('con la base caida mucho tiempo, el tope de memoria descarta las MAS VIEJAS y las cuenta', async () => {
  // La base falla una vez; mientras tanto siguen llegando posiciones.
  const base = crearBaseFalsa({ fallas: 1 });
  const avisos = [];
  const cola = crearColaHistorial({
    escribirLote: (l) => base.escribirLote(l),
    maxLote: 5,
    maxPendientes: 5,
    esperaInicialMs: 60_000,
    alDescartar: (info) => avisos.push(info),
  });
  for (let i = 1; i <= 5; i += 1) cola.encolar(registro(i)); // dispara un flush que va a fallar
  for (let i = 6; i <= 8; i += 1) cola.encolar(registro(i)); // llegan durante la escritura
  await new Promise((resolve) => setImmediate(resolve));

  // Lote fallido (5) + nuevas (3) = 8 > tope 5: se descartan las 3 mas viejas.
  assert.deepEqual(cola.estadisticas(), { pendientes: 5, fallos: 1, descartados: 3 });
  assert.equal(avisos.reduce((total, a) => total + a.descartados, 0), 3);

  await cola.drenar();
  // Se conservan las mas recientes: la ultima posicion es la que mas vale.
  assert.deepEqual(base.escritos.map((r) => r.timestamp), [4, 5, 6, 7, 8]);
});

test('drenar escribe en lotes de a maxLote, no un unico INSERT gigante', async () => {
  const lotes = [];
  const cola = crearColaHistorial({ escribirLote: async (l) => { lotes.push(l.length); }, maxLote: 3, maxPendientes: 100 });
  // Se llena sin disparar flush automatico: alcanzar maxLote dispara uno, asi
  // que el resto se encola mientras ese esta en curso.
  for (let i = 1; i <= 7; i += 1) cola.encolar(registro(i));
  await cola.drenar();
  assert.equal(lotes.reduce((a, b) => a + b, 0), 7);
  assert.ok(lotes.every((n) => n <= 3), `lotes: ${lotes}`);
});

test('valida los parametros nuevos', () => {
  const escribirLote = async () => {};
  assert.throws(() => crearColaHistorial({ escribirLote, maxLote: 10, maxPendientes: 5 }), /maxPendientes/);
  assert.throws(() => crearColaHistorial({ escribirLote, esperaInicialMs: -1 }), /esperaInicialMs/);
});
