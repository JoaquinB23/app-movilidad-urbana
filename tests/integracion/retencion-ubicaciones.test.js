// Test de integracion de la retencion de ubicaciones contra PostgreSQL/PostGIS real.
//
// Verifica, contando filas en la base:
//   * la funcion SQL `purgar_ubicaciones_historial(90)` borra SOLO las filas con
//     timestamp anterior al corte y conserva las recientes;
//   * `ubicaciones_actuales` no se toca (es la ultima posicion, no historial);
//   * el adaptador rechaza `dias <= 0` sin ejecutar SQL;
//   * la funcion SQL tambien rechaza `dias <= 0` (defensa en profundidad);
//   * el worker real, con el repositorio PG, reporta el conteo de borradas.
//
// Todo corre dentro de una transaccion que se revierte al final: no deja datos
// ni afecta filas de otros tests.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { crearPoolPg } from '../../src/infra/db/pool-pg.js';
import { crearRepositorioUbicacionesPg } from '../../src/infra/db/repositorio-ubicaciones-pg.js';
import { crearWorkerRetencion } from '../../src/workers/retencion-ubicaciones.js';
import { migrar } from '../../src/infra/db/migrar.js';
import { ErrorDatosInvalidos } from '../../src/dominio/ubicaciones/errores.js';

const urlTest = process.env.DATABASE_URL_TEST;
const urlPrincipal = process.env.DATABASE_URL;

function identificarBase(url) {
  const parsed = new URL(url);
  return [
    parsed.protocol,
    parsed.hostname.toLowerCase(),
    parsed.port || '5432',
    decodeURIComponent(parsed.pathname),
  ].join('|');
}

if (!urlTest || urlTest.trim() === '') {
  throw new Error('Falta DATABASE_URL_TEST; definila para ejecutar las pruebas de integracion.');
}
if (urlPrincipal && identificarBase(urlPrincipal) === identificarBase(urlTest)) {
  throw new Error('DATABASE_URL_TEST no puede ser igual a DATABASE_URL; se rechazo la ejecucion.');
}

const pool = crearPoolPg({ connectionString: urlTest });

before(async () => {
  const { rows } = await pool.query(`
    SELECT to_regclass('public.ubicaciones_historial') AS historial,
           to_regprocedure('public.purgar_ubicaciones_historial(integer)') AS purgar
  `);
  if (!rows[0].historial || !rows[0].purgar) {
    const urlOriginal = process.env.DATABASE_URL;
    try {
      process.env.DATABASE_URL = urlTest;
      await migrar();
    } finally {
      if (urlOriginal === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = urlOriginal;
    }
  }
});

after(async () => {
  await pool.end();
});

const DIA_MS = 24 * 60 * 60 * 1000;
const haceDias = (dias) => new Date(Date.now() - dias * DIA_MS);

test('el adaptador PG rechaza dias <= 0 sin ejecutar SQL', async () => {
  let consultas = 0;
  const repo = crearRepositorioUbicacionesPg({
    consulta: async () => {
      consultas += 1;
      return { rows: [] };
    },
  });

  for (const dias of [0, -1, -90, 1.5, '90']) {
    await assert.rejects(() => repo.purgarHistorial(dias), ErrorDatosInvalidos);
  }
  assert.equal(consultas, 0, 'no debe llegar ninguna consulta a la base');
});

test('purgarHistorial en PostGIS: borra solo lo viejo y conserva lo reciente', async () => {
  const client = await pool.connect();
  const loggerSilencioso = { info() {}, error() {} };
  try {
    await client.query('BEGIN');

    const choferId = randomUUID();
    await client.query(
      `INSERT INTO usuarios (id, email, password_hash, nombre, rol)
       VALUES ($1, $2, 'x', 'Chofer retencion', 'chofer')`,
      [choferId, `retencion-${choferId}@test.local`]
    );
    await client.query(
      `INSERT INTO choferes (usuario_id, patente, vehiculo_marca, vehiculo_modelo, vehiculo_color)
       VALUES ($1, $2, 'marca', 'modelo', 'color')`,
      [choferId, `RET${choferId.slice(0, 6)}`.slice(0, 10)]
    );

    // Deja el escenario deterministico dentro de la transaccion: cualquier fila
    // vieja de otros tests se borra aca y se revierte al final.
    await client.query(`DELETE FROM ubicaciones_historial WHERE timestamp < now() - interval '90 days'`);

    const insertarHistorial = `INSERT INTO ubicaciones_historial (viaje_id, chofer_id, geom, timestamp)
       VALUES (NULL, $1, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4)`;
    await client.query(insertarHistorial, [choferId, 0, 0, haceDias(100)]); // vieja
    await client.query(insertarHistorial, [choferId, 0, 0, haceDias(91)]); // vieja
    await client.query(insertarHistorial, [choferId, 0, 0, haceDias(89)]); // reciente
    await client.query(insertarHistorial, [choferId, 0, 0, haceDias(0)]); // reciente

    await client.query(
      `INSERT INTO ubicaciones_actuales (chofer_id, geom, timestamp)
       VALUES ($1, ST_SetSRID(ST_MakePoint(0, 0), 4326)::geography, now())`,
      [choferId]
    );

    const consulta = (sql, valores) => client.query(sql, valores);
    const repo = crearRepositorioUbicacionesPg({ consulta });
    const worker = crearWorkerRetencion({
      repositorioUbicaciones: repo,
      dias: 90,
      intervaloMs: 60000,
      logger: loggerSilencioso,
    });

    const resultado = await worker.ejecutarAhora();
    assert.equal(resultado.borradas, 2, 'deben borrarse las dos filas de 100 y 91 dias');
    assert.equal(resultado.error, undefined);

    const { rows: historial } = await client.query(
      `SELECT count(*)::int AS total FROM ubicaciones_historial WHERE chofer_id = $1`,
      [choferId]
    );
    assert.equal(historial[0].total, 2, 'quedan solo las dos recientes');

    const { rows: recientes } = await client.query(
      `SELECT count(*)::int AS total FROM ubicaciones_historial
       WHERE chofer_id = $1 AND timestamp >= now() - interval '90 days'`,
      [choferId]
    );
    assert.equal(recientes[0].total, 2);

    const { rows: actuales } = await client.query(
      `SELECT count(*)::int AS total FROM ubicaciones_actuales WHERE chofer_id = $1`,
      [choferId]
    );
    assert.equal(actuales[0].total, 1, 'ubicaciones_actuales no se purga');

    // Defensa en profundidad: la funcion SQL tambien rechaza dias <= 0.
    await client.query('SAVEPOINT guardia_dias');
    await assert.rejects(
      () => client.query('SELECT purgar_ubicaciones_historial(0)'),
      /dias/i
    );
    await client.query('ROLLBACK TO SAVEPOINT guardia_dias');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
});

// Dos instancias de la API purgando A LA VEZ las mismas filas viejas.
//
// Expectativa declarada ANTES de correr:
//   * El DELETE de PostgreSQL es atomico y bloquea las filas que va a borrar.
//     La primera llamada borra TODAS las viejas; la segunda queda esperando los
//     locks, reevalua el WHERE sobre las filas ya borradas y devuelve 0.
//   * Entonces: una llamada borra N y la otra 0, la SUMA es N (ninguna fila se
//     borra dos veces ni queda sin borrar) y quedan intactas las recientes.
//   * No se puede usar una transaccion con ROLLBACK: las dos purgas necesitan
//     conexiones distintas y ver los datos COMMITEADOS (si no, cada una solo
//     veria su propia transaccion). Por eso se commitea y se limpia al final.
//
// Se cuentan filas ANTES de purgar (no se asume una base vacia: puede haber
// filas viejas de otras pruebas) y se verifica el estado final en la base.
test('dos purgas simultaneas: se reparten el total exacto, sin doble borrado ni filas sin borrar', async () => {
  const clienteSetup = await pool.connect();
  const clientesPurga = [await pool.connect(), await pool.connect()];
  const choferId = randomUUID();

  try {
    // 1) Datos COMMITEADOS: las dos conexiones de purga deben verlos.
    await clienteSetup.query('BEGIN');
    await clienteSetup.query(
      `INSERT INTO usuarios (id, email, password_hash, nombre, rol)
       VALUES ($1, $2, 'x', 'Chofer concurrencia retencion', 'chofer')`,
      [choferId, `retencion-concurrente-${choferId}@test.local`]
    );
    await clienteSetup.query(
      `INSERT INTO choferes (usuario_id, patente, vehiculo_marca, vehiculo_modelo, vehiculo_color)
       VALUES ($1, $2, 'marca', 'modelo', 'color')`,
      [choferId, `CON${choferId.slice(0, 6)}`.slice(0, 10)]
    );

    const insertarHistorial = `INSERT INTO ubicaciones_historial (viaje_id, chofer_id, geom, timestamp)
       VALUES (NULL, $1, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4)`;
    await clienteSetup.query(insertarHistorial, [choferId, 0, 0, haceDias(120)]); // vieja
    await clienteSetup.query(insertarHistorial, [choferId, 0, 0, haceDias(100)]); // vieja
    await clienteSetup.query(insertarHistorial, [choferId, 0, 0, haceDias(91)]); // vieja
    await clienteSetup.query(insertarHistorial, [choferId, 0, 0, haceDias(89)]); // reciente
    await clienteSetup.query(insertarHistorial, [choferId, 0, 0, haceDias(0)]); // reciente
    await clienteSetup.query('COMMIT');

    // 2) Total de filas viejas en este instante (incluye las nuestras y las que
    //    hayan dejado otras pruebas). Es el N que debe repartirse la suma.
    const { rows: antes } = await clienteSetup.query(
      `SELECT count(*)::int AS total
       FROM ubicaciones_historial
       WHERE timestamp < now() - interval '90 days'`
    );
    const viejasAntes = antes[0].total;
    assert.ok(viejasAntes >= 3, 'el escenario debe tener al menos las 3 filas viejas propias');

    // 3) Dos purgas concurrentes, una por conexion (dos instancias distintas).
    const repos = clientesPurga.map((c) =>
      crearRepositorioUbicacionesPg({ consulta: (sql, valores) => c.query(sql, valores) })
    );
    const resultados = await Promise.all(repos.map((repo) => repo.purgarHistorial(90)));

    const suma = resultados.reduce((total, n) => total + n, 0);
    assert.ok(resultados.every((n) => Number.isInteger(n) && n >= 0), 'conteos validos');
    assert.equal(
      suma,
      viejasAntes,
      `la suma de borradas (${suma}) debe ser exactamente el total de viejas (${viejasAntes})`
    );
    // Serializacion esperada por los locks: una borra todo y la otra nada.
    assert.deepEqual(
      [...resultados].sort((a, b) => a - b),
      [0, viejasAntes],
      'una purga debe borrar todo y la otra 0 (no se reparten filas)'
    );

    // 4) Estado final medido en la base.
    const { rows: nuestras } = await clienteSetup.query(
      `SELECT
         count(*) FILTER (WHERE timestamp <  now() - interval '90 days')::int AS viejas,
         count(*) FILTER (WHERE timestamp >= now() - interval '90 days')::int AS recientes
       FROM ubicaciones_historial
       WHERE chofer_id = $1`,
      [choferId]
    );
    assert.equal(nuestras[0].viejas, 0, 'no debe quedar ninguna fila vieja propia');
    assert.equal(nuestras[0].recientes, 2, 'las dos filas recientes siguen intactas');

    const { rows: global } = await clienteSetup.query(
      `SELECT count(*)::int AS total
       FROM ubicaciones_historial
       WHERE timestamp < now() - interval '90 days'`
    );
    assert.equal(global[0].total, 0, 'no debe quedar ninguna fila vieja en la base');
  } finally {
    // Si el setup fallo dentro de la transaccion, se cierra antes de limpiar.
    await clienteSetup.query('ROLLBACK').catch(() => {});
    await clienteSetup
      .query('DELETE FROM ubicaciones_historial WHERE chofer_id = $1', [choferId])
      .catch(() => {});
    await clienteSetup
      .query('DELETE FROM ubicaciones_actuales WHERE chofer_id = $1', [choferId])
      .catch(() => {});
    await clienteSetup
      .query('DELETE FROM choferes WHERE usuario_id = $1', [choferId])
      .catch(() => {});
    await clienteSetup.query('DELETE FROM usuarios WHERE id = $1', [choferId]).catch(() => {});
    clienteSetup.release();
    for (const c of clientesPurga) c.release();
  }
});
