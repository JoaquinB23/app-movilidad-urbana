// Seed de carga (P2): N choferes habilitados con UUID deterministicos que el
// simulador reconstruye por su cuenta. Contra PostgreSQL real.

process.env.ARGON2_MEMORIA_KIB = '8192';
process.env.ARGON2_ITERACIONES = '2';

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { crearPoolPg } from '../../src/infra/db/pool-pg.js';
import { crearHasherArgon2 } from '../../src/infra/seguridad/hasher-argon2.js';
import { migrar } from '../../src/infra/db/migrar.js';
import { sembrarChoferesCarga, borrarChoferesCarga } from '../../scripts/carga/seed-choferes-carga.js';
import { idChoferCarga, idPasajeroCarga } from '../../scripts/carga/ids-carga.js';

const urlTest = process.env.DATABASE_URL_TEST;
if (!urlTest) throw new Error('Falta DATABASE_URL_TEST; definila para ejecutar las pruebas de integración.');
if (process.env.DATABASE_URL && new URL(process.env.DATABASE_URL).href === new URL(urlTest).href) {
  throw new Error('DATABASE_URL_TEST no puede ser igual a DATABASE_URL; se rechazó la ejecución.');
}

const pool = crearPoolPg({ connectionString: urlTest });
let hasher;

async function contarCarga() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE c.habilitado AND NOT c.disponible)::int AS listos
     FROM choferes c JOIN usuarios u ON u.id = c.usuario_id
     WHERE u.email LIKE 'carga-chofer-%@carga.invalid'`
  );
  return rows[0];
}

before(async () => {
  const urlOriginal = process.env.DATABASE_URL;
  try {
    process.env.DATABASE_URL = urlTest;
    await migrar();
  } finally {
    if (urlOriginal === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = urlOriginal;
  }
  hasher = await crearHasherArgon2();
  await borrarChoferesCarga({ pool });
});
after(async () => {
  await borrarChoferesCarga({ pool });
  await pool.end();
});

test('crea N choferes habilitados, no disponibles, con los UUID que calcula el simulador', async () => {
  await sembrarChoferesCarga({ pool, hasher, cantidad: 25, cantidadPasajeros: 4 });
  assert.deepEqual(await contarCarga(), { total: 25, listos: 25 });

  const { rows: pasajeros } = await pool.query(
    `SELECT id FROM usuarios WHERE rol = 'pasajero' AND email LIKE 'carga-pasajero-%@carga.invalid' ORDER BY id`
  );
  assert.deepEqual(pasajeros.map((p) => p.id), [0, 1, 2, 3].map(idPasajeroCarga));

  const { rows } = await pool.query('SELECT usuario_id FROM choferes WHERE usuario_id = ANY($1::uuid[])',
    [[idChoferCarga(0), idChoferCarga(24)]]);
  assert.equal(rows.length, 2);
});

test('es idempotente y re-sembrar deja a todos otra vez no disponibles', async () => {
  await pool.query('UPDATE choferes SET disponible = true WHERE usuario_id = $1', [idChoferCarga(3)]);
  await sembrarChoferesCarga({ pool, hasher, cantidad: 25 });
  await sembrarChoferesCarga({ pool, hasher, cantidad: 25 });
  assert.deepEqual(await contarCarga(), { total: 25, listos: 25 });
});

test('borrar quita todos los choferes de carga y solo esos', async () => {
  const { rows: antes } = await pool.query(`SELECT count(*)::int AS n FROM usuarios WHERE email NOT LIKE '%@carga.invalid'`);
  const { borrados } = await borrarChoferesCarga({ pool });
  assert.equal(borrados, 25);
  assert.deepEqual(await contarCarga(), { total: 0, listos: 0 });
  const { rows: quedan } = await pool.query(`SELECT count(*)::int AS n FROM usuarios WHERE email LIKE '%@carga.invalid'`);
  assert.equal(quedan[0].n, 0, 'tampoco quedan pasajeros de carga');
  const { rows: despues } = await pool.query(`SELECT count(*)::int AS n FROM usuarios WHERE email NOT LIKE '%@carga.invalid'`);
  assert.equal(despues[0].n, antes[0].n);
});

test('los ids son UUID v4 validos y distintos', () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const ids = Array.from({ length: 1000 }, (_, i) => idChoferCarga(i));
  assert.ok(ids.every((id) => uuid.test(id)));
  assert.equal(new Set(ids).size, 1000);
  assert.throws(() => idChoferCarga(-1), RangeError);
});
