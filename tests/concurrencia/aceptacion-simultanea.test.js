import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

import { crearAceptarOferta } from '../../src/dominio/viajes/casos-de-uso/aceptar-oferta.js';
import { crearGeneradorIdPg } from '../../src/infra/db/generador-id-pg.js';
import { crearRelojPg } from '../../src/infra/db/reloj-pg.js';
import { crearTransaccionPg } from '../../src/infra/db/transaccion-pg.js';
import { migrar } from '../../src/infra/db/migrar.js';
import { limpiarDatosViajes } from '../integracion/ayudante-viajes.js';

const { Pool } = pg;
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

const pool = new Pool({ connectionString: urlTest.trim(), max: 60 });
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

async function crearPasajero() {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO usuarios (id, email, password_hash, nombre, rol)
     VALUES ($1, $2, $3, $4, 'pasajero')`,
    [id, `it-viajes-pasajero-${randomUUID()}@test.invalid`, 'hash-test', 'Pasajero de prueba']
  );
  return id;
}

async function crearChofer(indice) {
  const id = randomUUID();
  const sufijo = randomUUID();
  await pool.query(
    `INSERT INTO usuarios (id, email, password_hash, nombre, rol)
     VALUES ($1, $2, $3, $4, 'chofer')`,
    [id, `it-viajes-chofer-${sufijo}@test.invalid`, 'hash-test', `Chofer ${indice}`]
  );
  await pool.query(
    `INSERT INTO choferes (
       usuario_id, patente, vehiculo_marca, vehiculo_modelo, vehiculo_color, habilitado, disponible
     ) VALUES ($1, $2, 'Marca', 'Modelo', 'Color', true, true)`,
    [id, `T${sufijo.slice(0, 7)}`]
  );
  return id;
}

async function crearViaje(pasajeroId) {
  const id = randomUUID();
  const ahora = new Date();
  await pool.query(
    `INSERT INTO viajes (
       id, pasajero_id, estado, origen_lat, origen_lng, destino_lat, destino_lng,
       distancia_estimada_m, duracion_estimada_s, tarifa_estimada_centavos,
       creado_en, actualizado_en
     ) VALUES ($1, $2, 'solicitado', -27.45, -58.98, -27.46, -58.97, 1000, 120, 5000, $3, $3)`,
    [id, pasajeroId, ahora]
  );
  return id;
}

async function crearOferta(viajeId, choferId, orden) {
  const id = randomUUID();
  const ahora = new Date();
  await pool.query(
    `INSERT INTO ofertas_viaje (id, viaje_id, chofer_id, estado, orden, expira_en, creada_en)
     VALUES ($1, $2, $3, 'pendiente', $4, $5, $6)`,
    [id, viajeId, choferId, orden, new Date(Date.now() + 10 * 60_000), ahora]
  );
  return id;
}

test('50 aceptaciones simultáneas del mismo viaje persisten un único ganador', async () => {
  const pasajeroId = await crearPasajero();
  const viajeId = await crearViaje(pasajeroId);
  const participantes = [];

  for (let indice = 1; indice <= 50; indice += 1) {
    const choferId = await crearChofer(indice);
    const ofertaId = await crearOferta(viajeId, choferId, indice);
    participantes.push({ choferId, ofertaId });
  }

  const resultados = await Promise.allSettled(
    participantes.map(({ choferId, ofertaId }) =>
      aceptarOferta({ actor: { id: choferId, rol: 'chofer' }, ofertaId })
    )
  );
  const ganadores = resultados.flatMap((resultado, indice) =>
    resultado.status === 'fulfilled'
      ? [{ ...participantes[indice], resultado: resultado.value }]
      : []
  );
  const rechazados = resultados.filter((resultado) => resultado.status === 'rejected');

  assert.equal(ganadores.length, 1, 'debe haber exactamente una aceptación exitosa');
  assert.equal(rechazados.length, 49, 'las otras 49 aceptaciones deben rechazarse');
  // El bloqueo del viaje serializa las aceptaciones; los perdedores ven su oferta cancelada y la regla devuelve OFERTA_NO_VIGENTE.
  assert.deepEqual(
    rechazados.map((resultado) => resultado.reason.codigo),
    Array(49).fill('OFERTA_NO_VIGENTE')
  );
  assert.ok(rechazados.every((resultado) => resultado.reason instanceof Error));

  const { rows: viajes } = await pool.query(
    'SELECT estado FROM viajes WHERE id = $1',
    [viajeId]
  );
  assert.equal(viajes[0].estado, 'asignado');

  const { rows: asignaciones } = await pool.query(
    `SELECT chofer_id FROM asignaciones_viaje
     WHERE viaje_id = $1 AND hasta IS NULL`,
    [viajeId]
  );
  assert.equal(asignaciones.length, 1, 'debe existir una única asignación abierta para el viaje');
  assert.equal(asignaciones[0].chofer_id, ganadores[0].choferId);

  const idsChoferes = participantes.map(({ choferId }) => choferId);
  const { rows: asignacionesChoferes } = await pool.query(
    `SELECT chofer_id FROM asignaciones_viaje
     WHERE chofer_id = ANY($1::uuid[]) AND hasta IS NULL`,
    [idsChoferes]
  );
  assert.equal(asignacionesChoferes.length, 1);
  assert.equal(asignacionesChoferes[0].chofer_id, ganadores[0].choferId);

  const { rows: estadosOfertas } = await pool.query(
    `SELECT estado, count(*)::int AS cantidad
     FROM ofertas_viaje
     WHERE viaje_id = $1
     GROUP BY estado
     ORDER BY estado`,
    [viajeId]
  );
  assert.deepEqual(estadosOfertas, [
    { estado: 'aceptada', cantidad: 1 },
    { estado: 'cancelada', cantidad: 49 },
  ]);

  const { rows: eventos } = await pool.query(
    `SELECT count(*)::int AS cantidad
     FROM viajes_eventos
     WHERE viaje_id = $1 AND evento = 'aceptar_oferta'`,
    [viajeId]
  );
  assert.equal(eventos[0].cantidad, 1);
});

test('un chofer no puede aceptar simultáneamente ofertas de dos viajes distintos', async () => {
  const pasajeroId = await crearPasajero();
  const choferId = await crearChofer(1);
  const viajes = [];

  for (let indice = 1; indice <= 2; indice += 1) {
    const viajeId = await crearViaje(pasajeroId);
    const ofertaId = await crearOferta(viajeId, choferId, indice);
    viajes.push({ viajeId, ofertaId });
  }

  const resultados = await Promise.allSettled(
    viajes.map(({ ofertaId }) =>
      aceptarOferta({ actor: { id: choferId, rol: 'chofer' }, ofertaId })
    )
  );
  const ganadores = resultados.filter((resultado) => resultado.status === 'fulfilled');
  const rechazados = resultados.filter((resultado) => resultado.status === 'rejected');

  assert.equal(ganadores.length, 1, 'debe haber exactamente una aceptación exitosa');
  assert.equal(rechazados.length, 1, 'la otra aceptación debe rechazarse');
  assert.equal(rechazados[0].reason.codigo, 'CHOFER_OCUPADO');

  const { rows: asignaciones } = await pool.query(
    `SELECT viaje_id FROM asignaciones_viaje
     WHERE chofer_id = $1 AND hasta IS NULL`,
    [choferId]
  );
  assert.equal(asignaciones.length, 1, 'el chofer debe tener una única asignación abierta');
  const viajeAsignado = viajes.find(({ viajeId }) => viajeId === asignaciones[0].viaje_id);
  assert.ok(viajeAsignado, 'la asignación abierta debe corresponder a uno de los dos viajes');

  const { rows: estadosViajes } = await pool.query(
    'SELECT id, estado FROM viajes WHERE id = ANY($1::uuid[])',
    [viajes.map(({ viajeId }) => viajeId)]
  );
  assert.equal(estadosViajes.length, 2);
  assert.equal(estadosViajes.filter(({ estado }) => estado === 'asignado').length, 1);
  assert.equal(estadosViajes.filter(({ estado }) => estado === 'solicitado').length, 1);
  assert.equal(
    estadosViajes.find(({ id }) => id === viajeAsignado.viajeId).estado,
    'asignado'
  );
});
