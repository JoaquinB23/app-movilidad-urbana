import test from 'node:test';
import assert from 'node:assert/strict';

import { cargarConfiguracion, ErrorConfiguracion } from '../../src/config/index.js';

const MINIMO = Object.freeze({
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  JWT_SECRETO: 'x'.repeat(32),
});

test('con lo minimo aplica los defaults y devuelve un objeto congelado', () => {
  const config = cargarConfiguracion({ ...MINIMO });
  assert.equal(config.http.puerto, 3000);
  assert.equal(config.rateLimit.loginMax, 10);
  assert.deepEqual(config.http.origenesCors, []);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.http));
});

test('convierte numeros y separa los origenes de CORS', () => {
  const config = cargarConfiguracion({
    ...MINIMO,
    PUERTO_HTTP: '4000',
    CORS_ORIGENES: 'http://a.test, http://b.test,',
  });
  assert.equal(config.http.puerto, 4000);
  assert.deepEqual(config.http.origenesCors, ['http://a.test', 'http://b.test']);
});

test('una variable vacia usa el default en vez de fallar', () => {
  assert.equal(cargarConfiguracion({ ...MINIMO, PUERTO_HTTP: '' }).http.puerto, 3000);
});

test('falla rapido y nombra cada variable invalida', () => {
  assert.throws(
    () => cargarConfiguracion({ JWT_SECRETO: 'corto', PUERTO_HTTP: 'abc' }),
    (error) => {
      assert.ok(error instanceof ErrorConfiguracion);
      const texto = error.problemas.join('\n');
      assert.match(texto, /DATABASE_URL/);
      assert.match(texto, /JWT_SECRETO/);
      assert.match(texto, /PUERTO_HTTP/);
      return true;
    }
  );
});

test('rechaza una DATABASE_URL que no es postgres', () => {
  assert.throws(
    () => cargarConfiguracion({ ...MINIMO, DATABASE_URL: 'mysql://u:p@h/db' }),
    /postgres/
  );
});
