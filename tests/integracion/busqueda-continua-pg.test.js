// SQL de la busqueda continua contra PostgreSQL: detectarBuscando devuelve
// los viajes solicitados SIN oferta pendiente (y saltea los que otra
// transaccion tiene bloqueados).

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import pg from 'pg';

import { crearRepositorioViajesPg } from '../../src/infra/db/repo-viajes-pg.js';
import { migrar } from '../../src/infra/db/migrar.js';
import { crearEscenarioPg, limpiarDatosViajes } from './ayudante-viajes.js';

const urlTest = process.env.DATABASE_URL_TEST;
if (!urlTest) throw new Error('Falta DATABASE_URL_TEST; definila para ejecutar las pruebas de integración.');
if (process.env.DATABASE_URL && new URL(process.env.DATABASE_URL).href === new URL(urlTest).href) {
  throw new Error('DATABASE_URL_TEST no puede ser igual a DATABASE_URL; se rechazó la ejecución.');
}

const pool = new pg.Pool({ connectionString: urlTest });
const consulta = (sql, valores) => pool.query(sql, valores);
const repo = crearRepositorioViajesPg({ consulta });

before(async () => {
  const original = process.env.DATABASE_URL;
  try {
    process.env.DATABASE_URL = urlTest;
    await migrar();
  } finally {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  }
});
beforeEach(() => limpiarDatosViajes(consulta));
after(async () => {
  await limpiarDatosViajes(consulta);
  await pool.end();
});

test('un viaje con oferta pendiente no esta buscando; sin oferta pendiente si', async () => {
  const { viajeId, ofertaId } = await crearEscenarioPg(pool);
  assert.ok(!(await repo.detectarBuscando(50)).includes(viajeId));

  await consulta("UPDATE ofertas_viaje SET estado = 'vencida' WHERE id = $1", [ofertaId]);
  assert.ok((await repo.detectarBuscando(50)).includes(viajeId));

  await consulta("UPDATE viajes SET estado = 'cancelado_pasajero' WHERE id = $1", [viajeId]);
  assert.ok(!(await repo.detectarBuscando(50)).includes(viajeId), 'un viaje terminado no busca');
});

test('SKIP LOCKED: un viaje bloqueado por otra transaccion se saltea', async () => {
  const { viajeId, ofertaId } = await crearEscenarioPg(pool);
  await consulta("UPDATE ofertas_viaje SET estado = 'rechazada' WHERE id = $1", [ofertaId]);

  const otra = await pool.connect();
  try {
    await otra.query('BEGIN');
    await otra.query('SELECT id FROM viajes WHERE id = $1 FOR UPDATE', [viajeId]);
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      const enTransaccion = crearRepositorioViajesPg({ consulta: (sql, v) => cliente.query(sql, v) });
      assert.ok(!(await enTransaccion.detectarBuscando(50)).includes(viajeId));
      await cliente.query('COMMIT');
    } finally {
      cliente.release();
    }
    await otra.query('ROLLBACK');
  } finally {
    otra.release();
  }
});
