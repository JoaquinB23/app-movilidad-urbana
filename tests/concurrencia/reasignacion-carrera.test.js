// Tests de concurrencia de la VARIANTE H (reasignación por falta de reporte).
//
// Qué se prueba (documentado como "carrera propia de H"):
//   1. La reasignación y el chofer que VUELVE A REPORTAR en el mismo instante:
//      la decisión se toma dentro de la transacción (revalidación del umbral
//      con el viaje bloqueado). Resultado: o se reasigna, o se conserva el
//      chofer; NUNCA dos choferes asignados ni ninguno.
//   2. Dos reasignaciones simultáneas del mismo viaje (worker + rechazo):
//      queda exactamente UNA asignación abierta.
//   3. Dos viajes compitiendo por UN candidato (FOR UPDATE SKIP LOCKED):
//      el candidato termina en exactamente un viaje; el otro queda
//      SIN_CANDIDATOS con su chofer original.
//   4. El chofer anterior queda LIBRE (sin asignación abierta) tras reasignar.
//
// Corren contra PostgreSQL real (DATABASE_URL_TEST), como el resto de
// tests de concurrencia/integración.

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { crearReasignarViaje } from '../../src/dominio/reasignacion/reasignar-viaje.js';
import { crearWorkerReasignacion } from '../../src/workers/reasignacion.js';
import { crearGeneradorIdPg } from '../../src/infra/db/generador-id-pg.js';
import { crearPoolPg } from '../../src/infra/db/pool-pg.js';
import { crearRelojPg } from '../../src/infra/db/reloj-pg.js';
import { crearTransaccionPg } from '../../src/infra/db/transaccion-pg.js';
import { crearRepositorioAdministracionPg } from '../../src/infra/db/repo-administracion-pg.js';
import { migrar } from '../../src/infra/db/migrar.js';

const urlTest = process.env.DATABASE_URL_TEST;
const urlPrincipal = process.env.DATABASE_URL;

function identificarBase(url) {
  const parsed = new URL(url);
  return [parsed.protocol, parsed.hostname.toLowerCase(), parsed.port || '5432', decodeURIComponent(parsed.pathname)].join('|');
}

if (!urlTest || urlTest.trim() === '') {
  throw new Error('Falta DATABASE_URL_TEST; definila para ejecutar las pruebas de concurrencia.');
}
if (urlPrincipal && identificarBase(urlPrincipal) === identificarBase(urlTest)) {
  throw new Error('DATABASE_URL_TEST no puede ser igual a DATABASE_URL; se rechazó la ejecución.');
}

const PREFIJO_EMAIL = 'it-reasig-';
const pool = crearPoolPg({ connectionString: urlTest });
const transaccion = crearTransaccionPg({ pool });
const reasignarViaje = crearReasignarViaje({
  transaccion,
  reloj: crearRelojPg(),
  generadorId: crearGeneradorIdPg(),
});

const consulta = (sql, valores) => pool.query(sql, valores);

async function limpiar() {
  const patron = `${PREFIJO_EMAIL}%@test.invalid`;
  // TRUNCATE como el ayudante de integración: el worker detecta CUALQUIER
  // asignación abierta sin reporte, así que no pueden quedar restos de otros
  // tests. ubicaciones_actuales se vacía por la misma razón (candidatos).
  await consulta('TRUNCATE TABLE viajes_eventos, asignaciones_viaje, ofertas_viaje, ubicaciones_actuales');
  await consulta(`DELETE FROM viajes WHERE pasajero_id IN (
    SELECT id FROM usuarios WHERE email LIKE $1)`, [patron]);
  await consulta(`DELETE FROM choferes WHERE usuario_id IN (
    SELECT id FROM usuarios WHERE email LIKE $1)`, [patron]);
  await consulta('DELETE FROM usuarios WHERE email LIKE $1', [patron]);
}

async function crearChofer({ disponible = true, habilitado = true, reportoHaceSegundos = null } = {}) {
  const id = randomUUID();
  const sufijo = randomUUID();
  await consulta(
    `INSERT INTO usuarios (id, email, password_hash, nombre, rol)
     VALUES ($1, $2, 'hash-test', 'Chofer', 'chofer')`,
    [id, `${PREFIJO_EMAIL}chofer-${sufijo}@test.invalid`]
  );
  await consulta(
    `INSERT INTO choferes (usuario_id, patente, vehiculo_marca, vehiculo_modelo, vehiculo_color, habilitado, disponible)
     VALUES ($1, $2, 'Marca', 'Modelo', 'Color', $3, $4)`,
    [id, `R${sufijo.slice(0, 7)}`, habilitado, disponible]
  );
  if (reportoHaceSegundos !== null) {
    await actualizarReporte(id, reportoHaceSegundos);
  }
  return id;
}

// Último reporte de ubicación del chofer, hace `haceSegundos` (cerca del origen).
async function actualizarReporte(choferId, haceSegundos) {
  await consulta(
    `INSERT INTO ubicaciones_actuales (chofer_id, geom, timestamp)
     VALUES ($1, ST_MakePoint(-58.98, -27.45)::geography, now() - make_interval(secs => $2))
     ON CONFLICT (chofer_id) DO UPDATE SET geom = EXCLUDED.geom, timestamp = EXCLUDED.timestamp`,
    [choferId, haceSegundos]
  );
}

async function crearViajeAsignado(choferId) {
  const pasajeroId = randomUUID();
  const viajeId = randomUUID();
  const sufijo = randomUUID();
  await consulta(
    `INSERT INTO usuarios (id, email, password_hash, nombre, rol)
     VALUES ($1, $2, 'hash-test', 'Pasajero', 'pasajero')`,
    [pasajeroId, `${PREFIJO_EMAIL}pasajero-${sufijo}@test.invalid`]
  );
  await consulta(
    `INSERT INTO viajes (id, pasajero_id, estado, origen_lat, origen_lng, destino_lat, destino_lng,
       distancia_estimada_m, duracion_estimada_s, tarifa_estimada_centavos)
     VALUES ($1, $2, 'asignado', -27.45, -58.98, -27.46, -58.97, 1000, 120, 5000)`,
    [viajeId, pasajeroId]
  );
  await consulta(
    `INSERT INTO asignaciones_viaje (id, viaje_id, chofer_id, desde)
     VALUES ($1, $2, $3, now() - interval '10 minutes')`,
    [randomUUID(), viajeId, choferId]
  );
  return viajeId;
}

async function asignacionesAbiertas(viajeId) {
  const { rows } = await consulta(
    'SELECT chofer_id FROM asignaciones_viaje WHERE viaje_id = $1 AND hasta IS NULL',
    [viajeId]
  );
  return rows.map((r) => r.chofer_id);
}

before(async () => {
  const { rows } = await pool.query(`SELECT to_regclass('public.parametros') AS parametros`);
  if (!rows[0].parametros) {
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
beforeEach(limpiar);
after(async () => {
  await limpiar();
  await pool.end();
});

// --- 1. worker reasigna y el chofer anterior queda libre ---------------

test('el worker reasigna un viaje cuyo chofer no reporta; el anterior queda libre', async () => {
  const choferMudo = await crearChofer({ reportoHaceSegundos: 300 }); // no reporta hace 5 min
  const candidato = await crearChofer({ reportoHaceSegundos: 2 });
  const viajeId = await crearViajeAsignado(choferMudo);

  const worker = crearWorkerReasignacion({
    transaccion,
    reasignarViaje,
    repositorioAdministracion: crearRepositorioAdministracionPg({ pool }),
    logger: { info() {}, debug() {}, error() {} },
  });
  const resultado = await worker.ejecutarCiclo();
  assert.equal(resultado.reasignados, 1);

  const abiertas = await asignacionesAbiertas(viajeId);
  assert.deepEqual(abiertas, [candidato]); // exactamente UNA, y es el candidato

  // El chofer anterior NO queda ocupado: sin asignación abierta a su nombre.
  const { rows } = await consulta(
    'SELECT 1 FROM asignaciones_viaje WHERE chofer_id = $1 AND hasta IS NULL', [choferMudo]);
  assert.equal(rows.length, 0);

  // La asignación cerrada registra el motivo.
  const { rows: cerradas } = await consulta(
    'SELECT motivo_fin FROM asignaciones_viaje WHERE chofer_id = $1 AND hasta IS NOT NULL', [choferMudo]);
  assert.match(cerradas[0].motivo_fin, /sin_reporte_ubicacion/);
});

// --- 2. carrera propia de H: el chofer vuelve a reportar --------------

test('si el chofer volvió a reportar antes del lock, la revalidación aborta la reasignación', async () => {
  const chofer = await crearChofer({ reportoHaceSegundos: 300 });
  await crearChofer({ reportoHaceSegundos: 2 }); // candidato disponible
  const viajeId = await crearViajeAsignado(chofer);

  // Entre la detección (que lo vio inactivo) y la transacción, el chofer reporta.
  await actualizarReporte(chofer, 0);

  await assert.rejects(
    reasignarViaje({ viajeId, motivo: 'sin_reporte_ubicacion: test', exigirInactividadS: 60 }),
    (err) => err.codigo === 'VIAJE_NO_REASIGNABLE'
  );
  assert.deepEqual(await asignacionesAbiertas(viajeId), [chofer]); // conserva su chofer
});

test('carrera de H: reasignación y reporte del chofer simultáneos; nunca dos choferes ni ninguno', async () => {
  const RONDAS = 20;
  for (let i = 0; i < RONDAS; i += 1) {
    const chofer = await crearChofer({ reportoHaceSegundos: 300 });
    const candidato = await crearChofer({ reportoHaceSegundos: 2 });
    const viajeId = await crearViajeAsignado(chofer);

    // El worker decide reasignar y el chofer reporta EN EL MISMO instante.
    const [resultadoReasignacion] = await Promise.allSettled([
      reasignarViaje({ viajeId, motivo: 'sin_reporte_ubicacion: carrera', exigirInactividadS: 60 }),
      actualizarReporte(chofer, 0),
    ]);

    const abiertas = await asignacionesAbiertas(viajeId);
    // Invariante central: exactamente UNA asignación abierta, siempre.
    assert.equal(abiertas.length, 1, `ronda ${i}: quedó ${abiertas.length} asignaciones abiertas`);
    if (resultadoReasignacion.status === 'fulfilled') {
      assert.deepEqual(abiertas, [candidato]); // se reasignó: el nuevo chofer
    } else {
      assert.equal(resultadoReasignacion.reason.codigo, 'VIAJE_NO_REASIGNABLE');
      assert.deepEqual(abiertas, [chofer]); // el reporte ganó: conserva el chofer
    }
    await limpiar();
  }
});

// --- 3. dos reasignaciones simultáneas del mismo viaje ----------------

test('rechazar-continuar y worker simultáneos: queda exactamente una asignación abierta', async () => {
  const chofer = await crearChofer({ reportoHaceSegundos: 300 });
  await crearChofer({ reportoHaceSegundos: 2 });
  await crearChofer({ reportoHaceSegundos: 3 });
  const viajeId = await crearViajeAsignado(chofer);

  const original = await transaccion.ejecutar((repos) => repos.asignaciones.buscarAbiertaPorViaje(viajeId));
  const resultados = await Promise.allSettled([
    reasignarViaje({ viajeId, motivo: 'rechazo_chofer: no puedo seguir', asignacionEsperadaId: original.id }),
    reasignarViaje({ viajeId, motivo: 'sin_reporte_ubicacion: worker', exigirInactividadS: 60 }),
  ]);

  const abiertas = await asignacionesAbiertas(viajeId);
  const exitosos = resultados.filter((r) => r.status === 'fulfilled');
  const rechazados = resultados.filter((r) => r.status === 'rejected');
  assert.equal(exitosos.length, 1);
  assert.deepEqual(abiertas, [exitosos[0].value.choferNuevoId]);
  assert.equal(rechazados[0].reason.codigo, 'VIAJE_NO_REASIGNABLE');
  // El estado del viaje sigue siendo asignado.
  const { rows } = await consulta('SELECT estado FROM viajes WHERE id = $1', [viajeId]);
  assert.equal(rows[0].estado, 'asignado');
});

test('el reemplazo conserva el viaje ante rechazos pendientes de la asignación original', async () => {
  const original = await crearChofer({ reportoHaceSegundos: 300 });
  await crearChofer({ reportoHaceSegundos: 2 });
  await crearChofer({ reportoHaceSegundos: 3 });
  const viajeId = await crearViajeAsignado(original);
  const asignacionOriginal = await transaccion.ejecutar(
    (repos) => repos.asignaciones.buscarAbiertaPorViaje(viajeId)
  );

  // El worker confirma entre la autorización del rechazo y su transacción.
  const reemplazo = await reasignarViaje({ viajeId, motivo: 'sin_reporte_ubicacion', exigirInactividadS: 60 });
  const resultados = await Promise.allSettled(Array.from({ length: 50 }, () => reasignarViaje({
    viajeId, motivo: 'rechazo_chofer: no puedo seguir', asignacionEsperadaId: asignacionOriginal.id,
  })));

  assert.deepEqual(await asignacionesAbiertas(viajeId), [reemplazo.choferNuevoId]);
  const { rows } = await consulta('SELECT id FROM asignaciones_viaje WHERE viaje_id = $1', [viajeId]);
  assert.equal(rows.length, 2, 'el historial debe contener solo la asignación original y su reemplazo');
  for (const resultado of resultados) {
    assert.equal(resultado.status, 'rejected');
    assert.equal(resultado.reason.codigo, 'VIAJE_NO_REASIGNABLE');
  }
});

// --- 4. SKIP LOCKED: un candidato, dos viajes --------------------------

test('dos viajes compiten por un único candidato: SKIP LOCKED lo entrega a exactamente uno', async () => {
  const choferMudoA = await crearChofer({ disponible: false, reportoHaceSegundos: 300 });
  const choferMudoB = await crearChofer({ disponible: false, reportoHaceSegundos: 300 });
  const candidato = await crearChofer({ reportoHaceSegundos: 2 });
  const viajeA = await crearViajeAsignado(choferMudoA);
  const viajeB = await crearViajeAsignado(choferMudoB);

  const resultados = await Promise.allSettled([
    reasignarViaje({ viajeId: viajeA, motivo: 'sin_reporte_ubicacion: a', exigirInactividadS: 60 }),
    reasignarViaje({ viajeId: viajeB, motivo: 'sin_reporte_ubicacion: b', exigirInactividadS: 60 }),
  ]);

  const exitosas = resultados.filter((r) => r.status === 'fulfilled');
  const fallidas = resultados.filter((r) => r.status === 'rejected');
  assert.equal(exitosas.length, 1, 'exactamente una reasignación debe conseguir al candidato');
  assert.equal(fallidas[0].reason.codigo, 'SIN_CANDIDATOS');

  // El candidato quedó asignado a UN solo viaje.
  const { rows } = await consulta(
    'SELECT viaje_id FROM asignaciones_viaje WHERE chofer_id = $1 AND hasta IS NULL', [candidato]);
  assert.equal(rows.length, 1);
  // Cada viaje conserva exactamente una asignación abierta.
  assert.equal((await asignacionesAbiertas(viajeA)).length, 1);
  assert.equal((await asignacionesAbiertas(viajeB)).length, 1);
});
