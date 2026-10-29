import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { crearAceptarOferta } from '../../src/dominio/viajes/casos-de-uso/aceptar-oferta.js';
import { crearGeneradorIdPg } from '../../src/infra/db/generador-id-pg.js';
import { crearPoolPg } from '../../src/infra/db/pool-pg.js';
import { crearRelojPg } from '../../src/infra/db/reloj-pg.js';
import { crearTransaccionPg } from '../../src/infra/db/transaccion-pg.js';
import { migrar } from '../../src/infra/db/migrar.js';
import { crearEscenarioPg, limpiarDatosViajes } from './ayudante-viajes.js';

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
  throw new Error('Falta DATABASE_URL_TEST; definila para ejecutar las pruebas de integración.');
}
if (urlPrincipal && identificarBase(urlPrincipal) === identificarBase(urlTest)) {
  throw new Error('DATABASE_URL_TEST no puede ser igual a DATABASE_URL; se rechazó la ejecución.');
}

const pool = crearPoolPg({ connectionString: urlTest });
const transaccion = crearTransaccionPg({ pool });
const aceptarOferta = crearAceptarOferta({
  transaccion,
  reloj: crearRelojPg(),
  generadorId: crearGeneradorIdPg(),
});

before(async () => {
  const { rows } = await pool.query(`
    SELECT to_regclass('public.viajes') AS viajes,
           to_regclass('public.viajes_eventos') AS eventos
  `);
  if (!rows[0].viajes || !rows[0].eventos) {
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

beforeEach(async () => limpiarDatosViajes((sql, valores) => pool.query(sql, valores)));
after(async () => pool.end());

test('acepta una oferta y persiste el viaje, la asignación y el evento', async () => {
  const escenario = await crearEscenarioPg(pool);
  const resultado = await aceptarOferta({
    actor: { id: escenario.choferId, rol: 'chofer' },
    ofertaId: escenario.ofertaId,
  });

  assert.equal(resultado.viaje.estado, 'asignado');
  assert.equal(resultado.oferta.estado, 'aceptada');
  const { rows } = await pool.query(
    `SELECT v.estado AS estado_viaje, o.estado AS estado_oferta,
            a.chofer_id, a.hasta, e.evento
     FROM viajes v
     JOIN ofertas_viaje o ON o.viaje_id = v.id
     JOIN asignaciones_viaje a ON a.viaje_id = v.id AND a.hasta IS NULL
     JOIN viajes_eventos e ON e.viaje_id = v.id
     WHERE v.id = $1`,
    [escenario.viajeId]
  );
  assert.equal(rows[0].estado_viaje, 'asignado');
  assert.equal(rows[0].estado_oferta, 'aceptada');
  assert.equal(rows[0].chofer_id, escenario.choferId);
  assert.equal(rows[0].hasta, null);
  assert.equal(rows[0].evento, 'aceptar_oferta');
});

test('rechaza la aceptación si el chofer ya tiene una asignación abierta', async () => {
  const escenario = await crearEscenarioPg(pool);
  const viajeOcupadoId = randomUUID();
  await pool.query(
    `INSERT INTO viajes (
       id, pasajero_id, estado, origen_lat, origen_lng, destino_lat, destino_lng,
       distancia_estimada_m, duracion_estimada_s, tarifa_estimada_centavos
     ) VALUES ($1, $2, 'asignado', 0, 0, 0, 0, 0, 0, 0)`,
    [viajeOcupadoId, escenario.pasajeroId]
  );
  await pool.query(
    `INSERT INTO asignaciones_viaje (id, viaje_id, chofer_id, desde)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), viajeOcupadoId, escenario.choferId, new Date()]
  );

  await assert.rejects(
    aceptarOferta({
      actor: { id: escenario.choferId, rol: 'chofer' },
      ofertaId: escenario.ofertaId,
    }),
    (error) => error.codigo === 'CHOFER_OCUPADO'
  );
  const { rows } = await pool.query(
    `SELECT estado FROM viajes WHERE id = $1`,
    [escenario.viajeId]
  );
  assert.equal(rows[0].estado, 'solicitado');
});
