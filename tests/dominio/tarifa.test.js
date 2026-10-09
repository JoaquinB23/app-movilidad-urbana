// Tests del calculo de tarifa. Los importes de cada caso estan calculados a
// mano en el propio test (no se repite la formula de produccion) para que el
// test valide el resultado y no la implementacion.

import test from 'node:test';
import assert from 'node:assert/strict';

import { calcularTarifa } from '../../src/dominio/viajes/tarifa.js';
import {
  ErrorDatosInvalidos,
  ErrorViajeFueraDeLimite,
} from '../../src/dominio/viajes/errores.js';

const PARAMETROS = Object.freeze({
  tarifaBaseCentavos: 50000,
  porKmCentavos: 20000,
  porMinutoCentavos: 3000,
  tarifaMinimaCentavos: 80000,
  distanciaMaximaMetros: 50000,
});

function assertTodoEntero({ totalCentavos, desglose }) {
  assert.ok(Number.isInteger(totalCentavos));
  for (const [clave, valor] of Object.entries(desglose)) {
    assert.ok(Number.isInteger(valor), `${clave} debe ser entero (centavos)`);
  }
}

test('caso base: 10 km y 10 min supera la tarifa minima', () => {
  // base 50000 + distancia (10km * 20000) 200000 + tiempo (10min * 3000) 30000
  const r = calcularTarifa({
    distanciaMetros: 10000,
    duracionSegundos: 600,
    parametros: PARAMETROS,
  });

  assert.equal(r.totalCentavos, 280000);
  assert.deepEqual(r.desglose, {
    tarifaBaseCentavos: 50000,
    porDistanciaCentavos: 200000,
    porTiempoCentavos: 30000,
    subtotalCentavos: 280000,
    ajusteTarifaMinimaCentavos: 0,
    totalCentavos: 280000,
  });
  assertTodoEntero(r);
});

test('distancia 0 y duracion 0: aplica la tarifa minima', () => {
  const r = calcularTarifa({
    distanciaMetros: 0,
    duracionSegundos: 0,
    parametros: PARAMETROS,
  });

  assert.equal(r.totalCentavos, 80000);
  assert.equal(r.desglose.subtotalCentavos, 50000);
  assert.equal(r.desglose.ajusteTarifaMinimaCentavos, 30000);
  assertTodoEntero(r);
});

test('distancia maxima exacta: es valida', () => {
  // 50 km * 20000 + base 50000 = 1000000 + 50000
  const r = calcularTarifa({
    distanciaMetros: 50000,
    duracionSegundos: 0,
    parametros: PARAMETROS,
  });

  assert.equal(r.totalCentavos, 1050000);
  assert.equal(r.desglose.porDistanciaCentavos, 1000000);
});

test('distancia maxima + 1: lanza ErrorViajeFueraDeLimite', () => {
  assert.throws(
    () => calcularTarifa({ distanciaMetros: 50001, duracionSegundos: 0, parametros: PARAMETROS }),
    (err) => {
      assert.ok(err instanceof ErrorViajeFueraDeLimite);
      assert.equal(err.codigo, 'VIAJE_FUERA_DE_LIMITE');
      assert.equal(err.distanciaMetros, 50001);
      assert.equal(err.distanciaMaximaMetros, 50000);
      return true;
    }
  );
});

test('redondeo del desglose: mitad hacia arriba por componente', () => {
  // distancia 1234 m * 1234 /km = 1522756/1000 = 1522.756 -> 1523
  // tiempo 7 s * 100 /min = 700/60 = 11.666... -> 12
  const parametros = {
    tarifaBaseCentavos: 0,
    porKmCentavos: 1234,
    porMinutoCentavos: 100,
    tarifaMinimaCentavos: 0,
    distanciaMaximaMetros: 100000,
  };
  const r = calcularTarifa({ distanciaMetros: 1234, duracionSegundos: 7, parametros });

  assert.equal(r.desglose.porDistanciaCentavos, 1523);
  assert.equal(r.desglose.porTiempoCentavos, 12);
  assert.equal(r.totalCentavos, 1535);
});

test('redondeo half-up exacto en .5 sube al entero siguiente', () => {
  // 1500 m * 1 = 1500/1000 = 1.5 -> 2 ; 30 s * 1 = 30/60 = 0.5 -> 1
  const parametros = {
    tarifaBaseCentavos: 0,
    porKmCentavos: 1,
    porMinutoCentavos: 1,
    tarifaMinimaCentavos: 0,
    distanciaMaximaMetros: 100000,
  };
  const r = calcularTarifa({ distanciaMetros: 1500, duracionSegundos: 30, parametros });

  assert.equal(r.desglose.porDistanciaCentavos, 2);
  assert.equal(r.desglose.porTiempoCentavos, 1);
  assert.equal(r.totalCentavos, 3);
});

test('estimacion previa y tarifa final usan la misma funcion', () => {
  const entrada = { distanciaMetros: 7500, duracionSegundos: 450, parametros: PARAMETROS };
  const estimacion = calcularTarifa(entrada);
  const final = calcularTarifa(entrada);
  assert.deepEqual(estimacion, final);
  assertTodoEntero(estimacion);
});

test('distancia negativa -> ErrorDatosInvalidos', () => {
  assert.throws(
    () => calcularTarifa({ distanciaMetros: -1, duracionSegundos: 0, parametros: PARAMETROS }),
    ErrorDatosInvalidos
  );
});

test('distancia no entera -> ErrorDatosInvalidos', () => {
  assert.throws(
    () => calcularTarifa({ distanciaMetros: 1.5, duracionSegundos: 0, parametros: PARAMETROS }),
    ErrorDatosInvalidos
  );
});

test('duracion negativa -> ErrorDatosInvalidos', () => {
  assert.throws(
    () => calcularTarifa({ distanciaMetros: 0, duracionSegundos: -1, parametros: PARAMETROS }),
    ErrorDatosInvalidos
  );
});

test('duracion no entera -> ErrorDatosInvalidos', () => {
  assert.throws(
    () => calcularTarifa({ distanciaMetros: 0, duracionSegundos: 1.5, parametros: PARAMETROS }),
    ErrorDatosInvalidos
  );
});

test('parametros faltantes -> ErrorDatosInvalidos', () => {
  assert.throws(
    () => calcularTarifa({ distanciaMetros: 0, duracionSegundos: 0 }),
    ErrorDatosInvalidos
  );
});

test('parametros con importe negativo -> ErrorDatosInvalidos', () => {
  assert.throws(
    () =>
      calcularTarifa({
        distanciaMetros: 0,
        duracionSegundos: 0,
        parametros: { ...PARAMETROS, tarifaBaseCentavos: -1 },
      }),
    ErrorDatosInvalidos
  );
});

test('parametros con importe no entero -> ErrorDatosInvalidos', () => {
  assert.throws(
    () =>
      calcularTarifa({
        distanciaMetros: 0,
        duracionSegundos: 0,
        parametros: { ...PARAMETROS, porKmCentavos: 10.5 },
      }),
    ErrorDatosInvalidos
  );
});

test('distanciaMaximaMetros invalida -> ErrorDatosInvalidos', () => {
  assert.throws(
    () =>
      calcularTarifa({
        distanciaMetros: 0,
        duracionSegundos: 0,
        parametros: { ...PARAMETROS, distanciaMaximaMetros: 0 },
      }),
    ErrorDatosInvalidos
  );
});
