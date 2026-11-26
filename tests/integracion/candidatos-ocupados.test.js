// Busqueda de candidatos (P1): un chofer con una asignacion ABIERTA no es
// candidato, aunque este disponible, habilitado y cerca. Antes se le podia
// ofrecer el viaje; aceptarOferta lo frenaba con CHOFER_OCUPADO, pero el viaje
// quedaba esperando una oferta que nunca se iba a aceptar.
// Se prueban las DOS versiones (PostGIS e ingenua): tienen que devolver lo
// mismo para que la comparacion de mediciones sea honesta.

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { crearPoolPg } from '../../src/infra/db/pool-pg.js';
import { crearServicioGeoPostgis } from '../../src/infra/db/servicio-geo-postgis.js';
import { crearServicioGeoIngenuo } from '../../src/infra/db/servicio-geo-ingenuo.js';
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

const PREFIJO_EMAIL = 'it-candidatos-';
const ORIGEN = { lat: -27.4514, lng: -58.9866 };
const pool = crearPoolPg({ connectionString: urlTest });
const consulta = (sql, valores) => pool.query(sql, valores);
const versiones = {
  postgis: crearServicioGeoPostgis({ consulta }),
  ingenua: crearServicioGeoIngenuo({ consulta }),
};

async function limpiar() {
  const patron = `${PREFIJO_EMAIL}%@test.invalid`;
  const viajes = `SELECT v.id FROM viajes v JOIN usuarios u ON u.id = v.pasajero_id WHERE u.email LIKE $1`;
  await consulta(`DELETE FROM asignaciones_viaje WHERE viaje_id IN (${viajes})`, [patron]);
  await consulta(`DELETE FROM viajes WHERE pasajero_id IN (SELECT id FROM usuarios WHERE email LIKE $1)`, [patron]);
  // Cualquier ubicacion de otros tests competiria como candidato.
  await consulta('TRUNCATE TABLE ubicaciones_actuales');
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

// Chofer disponible y habilitado, a `metros` al norte del origen.
async function crearChoferCerca(metros) {
  const id = await crearUsuario('chofer');
  await consulta(
    `INSERT INTO choferes (usuario_id, patente, vehiculo_marca, vehiculo_modelo, vehiculo_color, habilitado, disponible)
     VALUES ($1, $2, 'Marca', 'Modelo', 'Color', true, true)`,
    [id, `K${randomUUID().slice(0, 7)}`]
  );
  const lat = ORIGEN.lat + metros / 111_320;
  await consulta(
    `INSERT INTO ubicaciones_actuales (chofer_id, geom, timestamp)
     VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, now())`,
    [id, ORIGEN.lng, lat]
  );
  return id;
}

async function asignarAViaje(choferId, { cerrada = false } = {}) {
  const pasajeroId = await crearUsuario('pasajero');
  const viajeId = randomUUID();
  await consulta(
    `INSERT INTO viajes (id, pasajero_id, estado, origen_lat, origen_lng, destino_lat, destino_lng,
       distancia_estimada_m, duracion_estimada_s, tarifa_estimada_centavos)
     VALUES ($1, $2, $3, -27.45, -58.98, -27.46, -58.99, 1000, 120, 5000)`,
    [viajeId, pasajeroId, cerrada ? 'finalizado' : 'asignado']
  );
  await consulta(
    `INSERT INTO asignaciones_viaje (viaje_id, chofer_id, desde, hasta, motivo_fin)
     VALUES ($1, $2, now() - interval '10 minutes', $3, $4)`,
    [viajeId, choferId, cerrada ? new Date() : null, cerrada ? 'finalizado' : null]
  );
}

const busqueda = { ...ORIGEN, radioMetros: 5000, limite: 10 };

before(async () => {
  const { rows } = await pool.query(`SELECT to_regclass('public.ubicaciones_actuales') AS tabla`);
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

for (const [nombre, servicio] of Object.entries(versiones)) {
  test(`${nombre}: un chofer con asignación abierta no es candidato aunque esté más cerca`, async () => {
    const ocupado = await crearChoferCerca(100);
    const libre = await crearChoferCerca(800);
    await asignarAViaje(ocupado);

    const candidatos = await servicio.buscarCandidatos(busqueda);
    assert.deepEqual(candidatos.map((c) => c.choferId), [libre]);
  });

  test(`${nombre}: una asignación CERRADA no lo excluye (el chofer quedó libre)`, async () => {
    const liberado = await crearChoferCerca(100);
    await asignarAViaje(liberado, { cerrada: true });

    const candidatos = await servicio.buscarCandidatos(busqueda);
    assert.deepEqual(candidatos.map((c) => c.choferId), [liberado]);
  });
}

test('las dos versiones devuelven los mismos candidatos en el mismo orden', async () => {
  const ids = [];
  for (const metros of [300, 100, 2000, 50]) ids.push(await crearChoferCerca(metros));
  await asignarAViaje(ids[3]); // el mas cercano esta ocupado

  const [postgis, ingenua] = await Promise.all([
    versiones.postgis.buscarCandidatos(busqueda),
    versiones.ingenua.buscarCandidatos(busqueda),
  ]);
  assert.deepEqual(postgis.map((c) => c.choferId), [ids[1], ids[0], ids[2]]);
  assert.deepEqual(ingenua.map((c) => c.choferId), postgis.map((c) => c.choferId));
});
