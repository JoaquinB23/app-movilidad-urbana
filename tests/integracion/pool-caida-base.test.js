// Si la base cierra una conexion OCIOSA del pool (reinicio de PostgreSQL,
// failover, pg_terminate_backend), el driver emite 'error' en el Pool. Sin un
// listener, Node trata ese evento como excepcion no capturada y TERMINA EL
// PROCESO: una caida de la base tumbaba toda la API (detectado al probar la
// recuperacion en docker compose). El pool tiene que reportarlo y seguir.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as dormir } from 'node:timers/promises';

import pg from 'pg';

import { crearPoolPg } from '../../src/infra/db/pool-pg.js';

const urlTest = process.env.DATABASE_URL_TEST;
if (!urlTest) throw new Error('Falta DATABASE_URL_TEST; definila para ejecutar las pruebas de integración.');

const admin = new pg.Pool({ connectionString: urlTest, max: 1 });
after(() => admin.end());

test('una conexion ociosa terminada por la base no tira el proceso y el pool sigue sirviendo', async () => {
  const errores = [];
  const pool = crearPoolPg({ connectionString: urlTest, alError: (error) => errores.push(error) });
  try {
    // Abre una conexion y la devuelve ociosa al pool.
    const { rows } = await pool.query('SELECT pg_backend_pid() AS pid');
    const pid = rows[0].pid;

    // La base mata ESA conexion (como en un reinicio de PostgreSQL).
    await admin.query('SELECT pg_terminate_backend($1)', [pid]);
    await dormir(200);

    assert.equal(errores.length, 1, 'el pool reporto el error en vez de tirar el proceso');
    // El pool descarta la conexion muerta y abre otra.
    const otra = await pool.query('SELECT pg_backend_pid() AS pid');
    assert.notEqual(otra.rows[0].pid, pid);
  } finally {
    await pool.end();
  }
});
