// Adaptadores PostgreSQL que necesita el modulo de ubicaciones para funcionar
// contra la base real (P0):
//   * repo-choferes-pg: cambiarDisponibilidad (condicionada a habilitado).
//   * repo-viajes-lectura-pg: buscarPorId con el chofer ASIGNADO (asignacion
//     abierta) y buscarActivoPorChofer.
// Los tests verifican el dato final en la base, no solo que no hubo error.

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { crearPoolPg } from '../../src/infra/db/pool-pg.js';
import { crearRepositorioChoferesPg } from '../../src/infra/db/repo-choferes-pg.js';
import { crearRepositorioViajesLecturaPg } from '../../src/infra/db/repo-viajes-lectura-pg.js';
import {
  verificarRepositorioChoferes,
  verificarRepositorioViajes,
} from '../../src/dominio/ubicaciones/puertos.js';
import { cambiarDisponibilidadChofer } from '../../src/dominio/ubicaciones/servicios.js';
import { migrar } from '../../src/infra/db/migrar.js';

const urlTest = process.env.DATABASE_URL_TEST;
const urlPrincipal = process.env.DATABASE_URL;

function identificarBase(url) {
  const parsed = new URL(url);
  return [parsed.protocol, parsed.hostname.toLowerCase(), parsed.port || '5432', decodeURIComponent(parsed.pathname)].join('|');
}

if (!urlTest || urlTest.trim() === '') {
  throw new Error('Falta DATABASE_URL_TEST; definila para ejecutar las pruebas de integración.');
}
if (urlPrincipal && identificarBase(urlPrincipal) === identificarBase(urlTest)) {
  throw new Error('DATABASE_URL_TEST no puede ser igual a DATABASE_URL; se rechazó la ejecución.');
}

const PREFIJO_EMAIL = 'it-ubic-pg-';
const pool = crearPoolPg({ connectionString: urlTest });
const consulta = (sql, valores) => pool.query(sql, valores);
const repoChoferes = crearRepositorioChoferesPg({ consulta });
const repoViajes = crearRepositorioViajesLecturaPg({ consulta });

async function limpiar() {
  const patron = `${PREFIJO_EMAIL}%@test.invalid`;
  const viajesDelFixture = `SELECT v.id FROM viajes v JOIN usuarios u ON u.id = v.pasajero_id WHERE u.email LIKE $1`;
  await consulta(`DELETE FROM viajes_eventos WHERE viaje_id IN (${viajesDelFixture})`, [patron]);
  await consulta(`DELETE FROM asignaciones_viaje WHERE viaje_id IN (${viajesDelFixture})`, [patron]);
  await consulta(`DELETE FROM viajes WHERE pasajero_id IN (SELECT id FROM usuarios WHERE email LIKE $1)`, [patron]);
  await consulta(`DELETE FROM choferes WHERE usuario_id IN (SELECT id FROM usuarios WHERE email LIKE $1)`, [patron]);
  await consulta('DELETE FROM usuarios WHERE email LIKE $1', [patron]);
}

async function crearUsuario(rol) {
  const id = randomUUID();
  await consulta(
    `INSERT INTO usuarios (id, email, password_hash, nombre, rol) VALUES ($1, $2, 'hash-test', 'Prueba', $3)`,
    [id, `${PREFIJO_EMAIL}${rol}-${randomUUID()}@test.invalid`, rol]
  );
  return id;
}

async function crearChofer({ habilitado = true, disponible = false } = {}) {
  const id = await crearUsuario('chofer');
  await consulta(
    `INSERT INTO choferes (usuario_id, patente, vehiculo_marca, vehiculo_modelo, vehiculo_color, habilitado, disponible)
     VALUES ($1, $2, 'Marca', 'Modelo', 'Color', $3, $4)`,
    [id, `U${randomUUID().slice(0, 7)}`, habilitado, disponible]
  );
  return id;
}

async function crearViaje({ estado, choferId = null, asignacionCerrada = false }) {
  const pasajeroId = await crearUsuario('pasajero');
  const viajeId = randomUUID();
  await consulta(
    `INSERT INTO viajes (id, pasajero_id, estado, origen_lat, origen_lng, destino_lat, destino_lng,
       distancia_estimada_m, duracion_estimada_s, tarifa_estimada_centavos)
     VALUES ($1, $2, $3, -27.4514, -58.9866, -27.46, -58.99, 1200, 240, 350000)`,
    [viajeId, pasajeroId, estado]
  );
  if (choferId) {
    await consulta(
      `INSERT INTO asignaciones_viaje (viaje_id, chofer_id, desde, hasta, motivo_fin)
       VALUES ($1, $2, now() - interval '5 minutes', $3, $4)`,
      [viajeId, choferId, asignacionCerrada ? new Date() : null, asignacionCerrada ? 'reasignado' : null]
    );
  }
  return { viajeId, pasajeroId };
}

async function disponibleEnBase(choferId) {
  const { rows } = await consulta('SELECT disponible FROM choferes WHERE usuario_id = $1', [choferId]);
  return rows[0]?.disponible;
}

before(async () => {
  const { rows } = await pool.query(`SELECT to_regclass('public.asignaciones_viaje') AS tabla`);
  if (!rows[0].tabla) {
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

// --- contrato de puertos ---------------------------------------------

test('los adaptadores PG cumplen los puertos de ubicaciones', () => {
  assert.doesNotThrow(() => verificarRepositorioChoferes(repoChoferes));
  assert.doesNotThrow(() => verificarRepositorioViajes(repoViajes));
});

// --- cambiarDisponibilidad -------------------------------------------

test('cambiarDisponibilidad persiste true y false en la base', async () => {
  const choferId = await crearChofer({ habilitado: true, disponible: false });

  const encendido = await repoChoferes.cambiarDisponibilidad(choferId, true);
  assert.equal(encendido.disponible, true);
  assert.equal(await disponibleEnBase(choferId), true);

  const apagado = await repoChoferes.cambiarDisponibilidad(choferId, false);
  assert.equal(apagado.disponible, false);
  assert.equal(await disponibleEnBase(choferId), false);
});

test('un chofer NO habilitado no puede quedar disponible, ni por carrera con el admin', async () => {
  // El servicio ya chequea habilitado, pero entre su lectura y el UPDATE un
  // admin puede deshabilitarlo. El UPDATE condicionado lo impide en la base.
  const choferId = await crearChofer({ habilitado: false, disponible: false });
  const resultado = await repoChoferes.cambiarDisponibilidad(choferId, true);
  assert.equal(resultado, null);
  assert.equal(await disponibleEnBase(choferId), false);
});

test('un chofer no habilitado SI puede apagarse (disponible=false)', async () => {
  const choferId = await crearChofer({ habilitado: false, disponible: true });
  const resultado = await repoChoferes.cambiarDisponibilidad(choferId, false);
  assert.equal(resultado.disponible, false);
  assert.equal(await disponibleEnBase(choferId), false);
});

test('cambiarDisponibilidad de un chofer inexistente devuelve null', async () => {
  assert.equal(await repoChoferes.cambiarDisponibilidad(randomUUID(), true), null);
});

test('servicio de dominio + adaptador PG: chofer habilitado queda disponible', async () => {
  const choferId = await crearChofer({ habilitado: true });
  const res = await cambiarDisponibilidadChofer({ repositorioChoferes: repoChoferes, choferId, disponible: true });
  assert.deepEqual(res, { choferId, disponible: true });
  assert.equal(await disponibleEnBase(choferId), true);
});

// --- lectura de viaje con chofer asignado ----------------------------

test('buscarPorId devuelve el chofer de la asignación ABIERTA y el origen', async () => {
  const choferId = await crearChofer();
  const { viajeId, pasajeroId } = await crearViaje({ estado: 'asignado', choferId });

  const viaje = await repoViajes.buscarPorId(viajeId);
  assert.equal(viaje.id, viajeId);
  assert.equal(viaje.pasajeroId, pasajeroId);
  assert.equal(viaje.choferId, choferId);
  assert.equal(viaje.estado, 'asignado');
  assert.deepEqual(viaje.origen, { lat: -27.4514, lng: -58.9866 });
});

test('buscarPorId sin asignación abierta devuelve choferId null', async () => {
  const { viajeId } = await crearViaje({ estado: 'solicitado' });
  assert.equal((await repoViajes.buscarPorId(viajeId)).choferId, null);

  // Una asignación CERRADA (chofer reasignado) no cuenta como chofer actual:
  // el chofer anterior pierde acceso al seguimiento.
  const choferViejo = await crearChofer();
  const { viajeId: reasignado } = await crearViaje({ estado: 'asignado', choferId: choferViejo, asignacionCerrada: true });
  assert.equal((await repoViajes.buscarPorId(reasignado)).choferId, null);
});

test('buscarPorId de un viaje inexistente devuelve null', async () => {
  assert.equal(await repoViajes.buscarPorId(randomUUID()), null);
});

test('buscarActivoPorChofer encuentra el viaje en curso del chofer', async () => {
  for (const estado of ['asignado', 'chofer_en_camino', 'en_curso']) {
    const choferId = await crearChofer();
    const { viajeId } = await crearViaje({ estado, choferId });
    const activo = await repoViajes.buscarActivoPorChofer(choferId);
    assert.equal(activo?.id, viajeId, `estado ${estado}`);
    assert.equal(activo.choferId, choferId);
  }
});

test('buscarActivoPorChofer ignora viajes terminados y asignaciones cerradas', async () => {
  const choferTerminado = await crearChofer();
  await crearViaje({ estado: 'finalizado', choferId: choferTerminado });
  assert.equal(await repoViajes.buscarActivoPorChofer(choferTerminado), null);

  const choferReasignado = await crearChofer();
  await crearViaje({ estado: 'asignado', choferId: choferReasignado, asignacionCerrada: true });
  assert.equal(await repoViajes.buscarActivoPorChofer(choferReasignado), null);

  const choferLibre = await crearChofer();
  assert.equal(await repoViajes.buscarActivoPorChofer(choferLibre), null);
});
