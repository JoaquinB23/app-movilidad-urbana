// Tests de la seleccion de candidatos (regla compartida por los 3 adaptadores).

import test from 'node:test';
import assert from 'node:assert/strict';

import { seleccionarCandidatos } from '../../src/dominio/ubicaciones/candidatos.js';
import { ErrorDatosInvalidos, ErrorCoordenadaInvalida } from '../../src/dominio/ubicaciones/errores.js';

const ORIGEN = { lat: 0, lng: 0 };

// 0.01 grados de latitud ~= 1112 m; 0.02 ~= 2224 m.
const CERCA = { choferId: 'cerca', lat: 0.01, lng: 0 };
const MEDIO = { choferId: 'medio', lat: 0.015, lng: 0 };
const LEJOS = { choferId: 'lejos', lat: 0.02, lng: 0 };

test('filtra por radio y ordena por distancia', () => {
  const r = seleccionarCandidatos({
    candidatos: [LEJOS, CERCA, MEDIO],
    origen: ORIGEN,
    radioMetros: 2000,
    limite: 10,
  });
  assert.deepEqual(r.map((c) => c.choferId), ['cerca', 'medio']);
  assert.ok(r[0].distanciaMetros < r[1].distanciaMetros);
});

test('aplica el limite de resultados', () => {
  const r = seleccionarCandidatos({
    candidatos: [LEJOS, CERCA, MEDIO],
    origen: ORIGEN,
    radioMetros: 5000,
    limite: 2,
  });
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((c) => c.choferId), ['cerca', 'medio']);
});

test('el borde exacto del radio se incluye (radio igual a la distancia)', () => {
  const candidato = { choferId: 'borde', lat: 0, lng: 0.01 };
  const distancia = seleccionarCandidatos({
    candidatos: [candidato],
    origen: ORIGEN,
    radioMetros: 5000,
    limite: 1,
  })[0].distanciaMetros;

  const r = seleccionarCandidatos({
    candidatos: [candidato],
    origen: ORIGEN,
    radioMetros: distancia,
    limite: 1,
  });
  assert.equal(r.length, 1, 'con radio == distancia el candidato entra');
});

test('desempata por choferId cuando la distancia empata (resultado estable)', () => {
  const a = { choferId: 'aaa', lat: 0.01, lng: 0 };
  const b = { choferId: 'bbb', lat: 0.01, lng: 0 };
  const r = seleccionarCandidatos({ candidatos: [b, a], origen: ORIGEN, radioMetros: 5000, limite: 1 });
  assert.equal(r[0].choferId, 'aaa');
});

test('acepta candidatos con la forma {ubicacion:{lat,lng}}', () => {
  const r = seleccionarCandidatos({
    candidatos: [{ choferId: 'x', ubicacion: { lat: 0.01, lng: 0 } }],
    origen: ORIGEN,
    radioMetros: 5000,
    limite: 5,
  });
  assert.equal(r.length, 1);
  assert.equal(r[0].lat, 0.01);
});

test('el resultado redondea la distancia a metros enteros', () => {
  const r = seleccionarCandidatos({
    candidatos: [{ choferId: 'x', lat: 0.01, lng: 0 }],
    origen: ORIGEN,
    radioMetros: 5000,
    limite: 5,
  });
  assert.ok(Number.isInteger(r[0].distanciaMetros));
});

test('candidato sin choferId -> ErrorDatosInvalidos', () => {
  assert.throws(
    () => seleccionarCandidatos({ candidatos: [{ lat: 0, lng: 0 }], origen: ORIGEN, radioMetros: 1, limite: 1 }),
    ErrorDatosInvalidos
  );
});

test('candidato con coordenada invalida -> ErrorCoordenadaInvalida', () => {
  assert.throws(
    () =>
      seleccionarCandidatos({
        candidatos: [{ choferId: 'x', lat: 200, lng: 0 }],
        origen: ORIGEN,
        radioMetros: 1,
        limite: 1,
      }),
    ErrorCoordenadaInvalida
  );
});

test('candidatos no es arreglo -> ErrorDatosInvalidos', () => {
  assert.throws(
    () => seleccionarCandidatos({ candidatos: null, origen: ORIGEN, radioMetros: 1, limite: 1 }),
    ErrorDatosInvalidos
  );
});
