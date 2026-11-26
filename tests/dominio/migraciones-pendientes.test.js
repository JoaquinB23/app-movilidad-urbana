// GET /ready responde 503 si falta aplicar alguna migracion del repo
// (bloque 3). Se prueba la funcion con una base falsa.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

import { migracionesPendientes } from '../../src/infra/db/migrar.js';

const ARCHIVOS = readdirSync(new URL('../../migraciones/', import.meta.url))
  .filter((f) => f.endsWith('.sql'))
  .sort((a, b) => a.localeCompare(b, 'es'));

function baseFalsa({ existeTabla, aplicadas = [] }) {
  return async (sql) => {
    if (sql.includes('to_regclass')) return { rows: [{ tabla: existeTabla ? 'schema_migraciones' : null }] };
    return { rows: aplicadas.map((nombre) => ({ nombre })) };
  };
}

test('sin tabla de control, todas las migraciones estan pendientes', async () => {
  assert.deepEqual(await migracionesPendientes({ consulta: baseFalsa({ existeTabla: false }) }), ARCHIVOS);
});

test('devuelve solo las que faltan, en orden', async () => {
  const pendientes = await migracionesPendientes({
    consulta: baseFalsa({ existeTabla: true, aplicadas: ARCHIVOS.slice(0, -1) }),
  });
  assert.deepEqual(pendientes, [ARCHIVOS.at(-1)]);
});

test('con todo aplicado no hay pendientes', async () => {
  assert.deepEqual(
    await migracionesPendientes({ consulta: baseFalsa({ existeTabla: true, aplicadas: ARCHIVOS }) }),
    []
  );
});
