// Tests de la geometria pura (sin base de datos ni servidor).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  distanciaHaversineMetros,
  esLatitudValida,
  esLongitudValida,
  validarPunto,
  validarRadio,
  validarLimite,
  RADIO_MEDIO_TIERRA_METROS,
} from '../../src/dominio/ubicaciones/geo.js';
import {
  ErrorCoordenadaInvalida,
  ErrorDatosInvalidos,
} from '../../src/dominio/ubicaciones/errores.js';

test('validarPunto acepta coordenadas validas y devuelve copia', () => {
  const original = { lat: -27.45, lng: -58.98 };
  const punto = validarPunto(original);
  assert.deepEqual(punto, original);
  assert.notEqual(punto, original, 'debe devolver un objeto nuevo');
});

test('validarPunto rechaza latitud fuera de rango', () => {
  assert.throws(() => validarPunto({ lat: 90.1, lng: 0 }), ErrorCoordenadaInvalida);
  assert.throws(() => validarPunto({ lat: -90.1, lng: 0 }), ErrorCoordenadaInvalida);
});

test('validarPunto rechaza longitud fuera de rango', () => {
  assert.throws(() => validarPunto({ lat: 0, lng: 180.1 }), ErrorCoordenadaInvalida);
  assert.throws(() => validarPunto({ lat: 0, lng: -181 }), ErrorCoordenadaInvalida);
});

test('validarPunto rechaza NaN, Infinity y no numericos', () => {
  assert.throws(() => validarPunto({ lat: NaN, lng: 0 }), ErrorCoordenadaInvalida);
  assert.throws(() => validarPunto({ lat: 0, lng: Infinity }), ErrorCoordenadaInvalida);
  assert.throws(() => validarPunto({ lat: '0', lng: 0 }), ErrorCoordenadaInvalida);
  assert.throws(() => validarPunto(null), ErrorCoordenadaInvalida);
});

test('los bordes de latitud y longitud son validos', () => {
  assert.equal(validarPunto({ lat: 90, lng: 180 }).lat, 90);
  assert.equal(validarPunto({ lat: -90, lng: -180 }).lng, -180);
  assert.ok(esLatitudValida(0) && esLongitudValida(0));
});

test('distancia de un punto a si mismo es cero', () => {
  assert.equal(distanciaHaversineMetros({ lat: 10, lng: 20 }, { lat: 10, lng: 20 }), 0);
});

test('un grado de longitud en el ecuador ronda 111.2 km', () => {
  const d = distanciaHaversineMetros({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
  // 2*pi*R/360 = 111194.9 m para el radio medio de la IUGG.
  assert.ok(Math.abs(d - 111195) < 5, `distancia inesperada: ${d}`);
});

test('la distancia es simetrica', () => {
  const a = { lat: -27.45, lng: -58.98 };
  const b = { lat: -27.46, lng: -58.99 };
  assert.equal(distanciaHaversineMetros(a, b), distanciaHaversineMetros(b, a));
});

test('validarRadio rechaza cero, negativos y no numericos', () => {
  assert.throws(() => validarRadio(0), ErrorDatosInvalidos);
  assert.throws(() => validarRadio(-1), ErrorDatosInvalidos);
  assert.throws(() => validarRadio('100'), ErrorDatosInvalidos);
  assert.equal(validarRadio(1500.5), 1500.5);
});

test('validarLimite rechaza no enteros y no positivos', () => {
  assert.throws(() => validarLimite(0), ErrorDatosInvalidos);
  assert.throws(() => validarLimite(2.5), ErrorDatosInvalidos);
  assert.equal(validarLimite(5), 5);
});

test('el radio terrestre es el documentado', () => {
  assert.equal(RADIO_MEDIO_TIERRA_METROS, 6371008.8);
});
