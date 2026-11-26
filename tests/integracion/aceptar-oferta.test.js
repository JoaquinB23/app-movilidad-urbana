import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { crearAceptarOferta } from '../../src/dominio/viajes/casos-de-uso/aceptar-oferta.js';
import { crearRechazarOferta, crearVencerOferta } from '../../src/dominio/viajes/casos-de-uso/continuar-oferta.js';
import { crearWorkerVencimiento } from '../../src/workers/vencimiento-ofertas.js';
import { crearRepositorioViajesPg } from '../../src/infra/db/repo-viajes-pg.js';
import { crearSolicitarViaje } from '../../src/dominio/viajes/casos-de-uso/solicitar-viaje.js';
import { crearRepositorioOfertasPg } from '../../src/infra/db/repo-ofertas-pg.js';
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

test('al vencer pasa al siguiente chofer una sola vez y su rechazo agota los candidatos', async () => {
  const ahora = new Date();
  const primero = await crearEscenarioPg(pool, { ofertaExpiraEn: ahora });
  const segundo = await crearEscenarioPg(pool, { ofertaExpiraEn: new Date(+ahora + 60000) });
  const consulta = (sql, valores) => pool.query(sql, valores);
  const deps = {
    transaccion, reloj: { ahora: () => ahora }, generadorId: crearGeneradorIdPg(),
    repositorioViajes: crearRepositorioViajesPg({ consulta }), repositorioOfertas: crearRepositorioOfertasPg({ consulta }),
    parametrosViajes: { obtener: () => ({ tiempoOfertaSegundos: 30, radioBusquedaMetros: 5000, maxCandidatos: 2 }) },
    servicioGeo: { buscarCandidatos: () => [primero, segundo] },
  };
  const vencerOferta = crearVencerOferta(deps);
  const worker = crearWorkerVencimiento({ ...deps, vencerOferta });
  const carrera = Array.from({ length: 49 }, () => vencerOferta({ ofertaId: primero.ofertaId }));
  await Promise.all([worker.ejecutarCiclo(), ...carrera,
    assert.rejects(aceptarOferta({ ofertaId: primero.ofertaId, actor: { id: primero.choferId, rol: 'chofer' } }),
      { codigo: 'OFERTA_NO_VIGENTE' })]);
  const leer = async () => (await consulta(
    'SELECT id, chofer_id, estado FROM ofertas_viaje WHERE viaje_id = $1 ORDER BY orden', [primero.viajeId])).rows;
  const filas = await leer();
  assert.deepEqual(filas.map(f => [f.chofer_id, f.estado]), [
    [primero.choferId, 'vencida'], [segundo.choferId, 'pendiente'],
  ]);
  const rechazar = crearRechazarOferta(deps);
  await assert.rejects(rechazar({ ofertaId: filas[1].id, actor: { id: primero.choferId, rol: 'chofer' } }),
    { codigo: 'OFERTA_NO_ENCONTRADA' });
  await rechazar({ ofertaId: filas[1].id, actor: { id: segundo.choferId, rol: 'chofer' } });
  assert.equal((await leer())[1].estado, 'rechazada');
  assert.equal((await deps.repositorioViajes.buscarPorId(primero.viajeId)).estado, 'sin_choferes');
  assert.equal((await consulta('SELECT id FROM asignaciones_viaje WHERE viaje_id = $1', [primero.viajeId])).rowCount, 0);
});

test('50 reintentos conservan en PostgreSQL un solo viaje, oferta y respuesta', async (t) => {
  const { pasajeroId, choferId } = await crearEscenarioPg(pool);
  const clave = randomUUID();
  t.after(() => pool.query('DELETE FROM claves_idempotencia WHERE usuario_id = $1 AND clave = $2', [pasajeroId, clave]));
  const solicitar = crearSolicitarViaje({
    transaccion, reloj: crearRelojPg(), generadorId: crearGeneradorIdPg(),
    estimadorRuta: { estimar: () => ({ distanciaMetros: 100, duracionSegundos: 30 }) },
    parametrosViajes: { obtener: () => ({
      tiempoOfertaSegundos: 60, radioBusquedaMetros: 500, maxCandidatos: 1,
      tarifa: { tarifaBaseCentavos: 100, porKmCentavos: 10, porMinutoCentavos: 5,
        tarifaMinimaCentavos: 100, distanciaMaximaMetros: 1000 },
    }) },
    servicioGeo: { buscarCandidatos: () => [{ choferId }] },
  });
  const pedido = {
    pasajero: { id: pasajeroId, rol: 'pasajero' }, origen: { lat: 0, lng: 0 },
    destino: { lat: 0, lng: 0.001 }, idempotencia: { clave, hash: 'a'.repeat(64) },
  };
  const resultados = await Promise.all(Array.from({ length: 50 }, () => solicitar(pedido)));
  const { viaje } = resultados[0];
  for (const resultado of resultados) assert.deepEqual(resultado.viaje, viaje);
  const { rows } = await pool.query(
    `SELECT (SELECT count(*)::int FROM viajes WHERE pasajero_id = $1) AS viajes,
            (SELECT count(*)::int FROM ofertas_viaje WHERE viaje_id = $2) AS ofertas,
            respuesta FROM claves_idempotencia WHERE usuario_id = $1 AND clave = $3`,
    [pasajeroId, viaje.id, clave]
  );
  // El fixture ya tiene un viaje antes de los reintentos.
  assert.deepEqual(rows, [{ viajes: 2, ofertas: 1, respuesta: viaje }]);
  const ofertas = crearRepositorioOfertasPg({ consulta: (sql, args) => pool.query(sql, args) });
  assert.ok((await ofertas.listarVigentes(choferId, new Date())).some(o => o.viajeId === viaje.id));
  assert.deepEqual(await ofertas.listarVigentes(choferId, new Date(Date.now() + 120000)), []);
});

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
