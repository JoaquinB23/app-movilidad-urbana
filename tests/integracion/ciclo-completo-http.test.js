// Ciclo completo de un viaje por HTTP contra la app REAL (servidor +
// composicion + PostgreSQL de test), con los usuarios del seed:
// solicitud -> oferta -> aceptacion -> en camino -> iniciar -> posiciones ->
// finalizar (tarifa final) -> cobro (y su reintento) -> historiales y eventos.
// Ademas: el operador ve el viaje en su panel y cancela otro con motivo, y el
// pasajero recibe cada cambio de estado por el SSE sin recargar.

process.env.ARGON2_MEMORIA_KIB = '8192';
process.env.ARGON2_ITERACIONES = '2';

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import pg from 'pg';

import { arrancar } from '../../src/servidor.js';
import { migrar } from '../../src/infra/db/migrar.js';
import { sembrarDatosBase } from '../../src/infra/db/seed.js';
import { crearHasherArgon2 } from '../../src/infra/seguridad/hasher-argon2.js';

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

const PASSWORD = 'clave-ciclo-de-prueba';
const ORIGEN = { lat: -27.4514, lng: -58.9866 };
const DESTINO = { lat: -27.46, lng: -58.99 };
const db = new pg.Pool({ connectionString: urlTest });
let servidor;
let baseUrl;
let choferId;
const tokens = {};

async function limpiar() {
  const seed = `SELECT id FROM usuarios WHERE email LIKE '%@movilidad.invalid'`;
  const viajes = `SELECT id FROM viajes WHERE pasajero_id IN (${seed})`;
  for (const tabla of ['cobros', 'viajes_eventos', 'ofertas_viaje', 'asignaciones_viaje']) {
    await db.query(`DELETE FROM ${tabla} WHERE viaje_id IN (${viajes})`);
  }
  await db.query(`DELETE FROM ubicaciones_historial WHERE chofer_id IN (${seed})`);
  await db.query(`DELETE FROM viajes WHERE pasajero_id IN (${seed})`);
  await db.query(`DELETE FROM claves_idempotencia WHERE usuario_id IN (${seed})`);
}

async function pedir(metodo, ruta, { token, body, headers = {} } = {}) {
  const res = await fetch(`${baseUrl}${ruta}`, {
    method: metodo,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const texto = await res.text();
  return { status: res.status, body: texto ? JSON.parse(texto) : null };
}

async function login(email) {
  const res = await pedir('POST', '/auth/login', { body: { email, password: PASSWORD } });
  assert.equal(res.status, 200, `login ${email}`);
  return res.body.token;
}

// Cliente SSE minimo: junta los estados que recibe el pasajero.
function escucharEstados(viajeId, token) {
  const controlador = new AbortController();
  const estados = [];
  const listo = fetch(`${baseUrl}/viajes/${viajeId}/seguimiento`, {
    headers: { authorization: `Bearer ${token}` }, signal: controlador.signal,
  }).then((res) => {
    (async () => {
      const decodificador = new TextDecoder();
      let buffer = '';
      try {
        for await (const trozo of res.body) {
          buffer += decodificador.decode(trozo, { stream: true });
          let corte;
          while ((corte = buffer.indexOf('\n\n')) >= 0) {
            const bloque = buffer.slice(0, corte);
            buffer = buffer.slice(corte + 2);
            if (/^event: estado$/m.test(bloque)) estados.push(JSON.parse(bloque.match(/^data: (.+)$/m)[1]).estado);
          }
        }
      } catch (error) {
        if (error.name !== 'AbortError') throw error;
      }
    })();
  });
  return { listo, estados, cerrar: () => controlador.abort() };
}

async function pedirViaje() {
  const res = await pedir('POST', '/viajes', {
    token: tokens.pasajero, body: { origen: ORIGEN, destino: DESTINO }, headers: { 'Idempotency-Key': randomUUID() },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.id;
}

async function aceptarOfertaDe(viajeId) {
  const { body } = await pedir('GET', '/choferes/me/ofertas', { token: tokens.chofer });
  const oferta = body.ofertas.find((o) => o.viajeId === viajeId);
  assert.ok(oferta, 'el chofer recibio la oferta');
  const res = await pedir('POST', `/ofertas/${oferta.id}/aceptar`, { token: tokens.chofer });
  assert.equal(res.status, 200, JSON.stringify(res.body));
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
  await limpiar();
  await db.query('TRUNCATE TABLE ubicaciones_actuales');
  const { ids } = await sembrarDatosBase({ pool: db, hasher: await crearHasherArgon2(), password: PASSWORD });
  choferId = ids['chofer1@movilidad.invalid'];
  servidor = await arrancar({
    ...process.env, DATABASE_URL: urlTest, PUERTO_HTTP: '0', HOST: '127.0.0.1', LOG_NIVEL: 'silent',
  });
  baseUrl = `http://127.0.0.1:${servidor.puerto}`;
  tokens.pasajero = await login('pasajero1@movilidad.invalid');
  tokens.otroPasajero = await login('pasajero2@movilidad.invalid');
  tokens.chofer = await login('chofer1@movilidad.invalid');
  tokens.operador = await login('operador1@movilidad.invalid');
  assert.equal((await pedir('PUT', '/choferes/me/disponibilidad', { token: tokens.chofer, body: { disponible: true } })).status, 200);
  assert.equal((await pedir('POST', '/choferes/me/ubicacion', {
    token: tokens.chofer, body: { ...ORIGEN, timestamp: new Date().toISOString() },
  })).status, 202);
});

after(async () => {
  await servidor?.apagar('test');
  await limpiar();
  await db.query('UPDATE choferes SET disponible = false WHERE usuario_id = $1', [choferId]);
  await db.query('DELETE FROM ubicaciones_actuales WHERE chofer_id = $1', [choferId]);
  await db.end();
});

test('ciclo completo: finalizar con tarifa final, cobro idempotente, historiales y eventos', async () => {
  const viajeId = await pedirViaje();
  const sse = escucharEstados(viajeId, tokens.pasajero);
  await sse.listo;
  try {
    await aceptarOfertaDe(viajeId);
    assert.equal((await pedir('POST', `/viajes/${viajeId}/en-camino`, { token: tokens.chofer })).body.estado, 'chofer_en_camino');
    assert.equal((await pedir('POST', `/viajes/${viajeId}/iniciar`, { token: tokens.chofer })).body.estado, 'en_curso');

    // Otro pasajero no puede avanzar ni ver el viaje; otro rol tampoco.
    assert.equal((await pedir('POST', `/viajes/${viajeId}/cancelar`, { token: tokens.otroPasajero })).status, 404);
    assert.equal((await pedir('POST', `/viajes/${viajeId}/finalizar`, { token: tokens.pasajero })).status, 403);

    // Posiciones durante el viaje: alimentan la distancia recorrida.
    for (const [i, lat] of [-27.452, -27.455, -27.458, -27.46].entries()) {
      const res = await pedir('POST', '/choferes/me/ubicacion', {
        token: tokens.chofer, body: { lat, lng: -58.9866 - i * 0.001, timestamp: new Date(Date.now() + i + 1).toISOString() },
      });
      assert.equal(res.status, 202);
    }
    await new Promise((resolve) => setTimeout(resolve, 1300)); // la cola escribe el lote

    const fin = await pedir('POST', `/viajes/${viajeId}/finalizar`, { token: tokens.chofer });
    assert.equal(fin.status, 200, JSON.stringify(fin.body));
    assert.equal(fin.body.estado, 'finalizado');
    assert.ok(Number.isInteger(fin.body.tarifaFinalCentavos) && fin.body.tarifaFinalCentavos > 0);

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(sse.estados, ['asignado', 'chofer_en_camino', 'en_curso', 'finalizado']);
  } finally {
    sse.cerrar();
  }

  // Cobro: el reintento con la misma clave devuelve lo mismo; otra clave no cobra de nuevo.
  const clave = randomUUID();
  const cobro = await pedir('POST', `/viajes/${viajeId}/cobro`, { token: tokens.pasajero, headers: { 'Idempotency-Key': clave } });
  assert.equal(cobro.status, 201, JSON.stringify(cobro.body));
  const reintento = await pedir('POST', `/viajes/${viajeId}/cobro`, { token: tokens.pasajero, headers: { 'Idempotency-Key': clave } });
  assert.deepEqual(reintento, cobro);
  const otraClave = await pedir('POST', `/viajes/${viajeId}/cobro`, { token: tokens.pasajero, headers: { 'Idempotency-Key': randomUUID() } });
  assert.equal(otraClave.status, 409);
  assert.equal(otraClave.body.error.codigo, 'YA_COBRADO');
  const { rows } = await db.query('SELECT importe_centavos FROM cobros WHERE viaje_id = $1', [viajeId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].importe_centavos, cobro.body.importeCentavos);

  // El chofer quedo libre y el viaje aparece en los dos historiales.
  const { rows: abiertas } = await db.query('SELECT 1 FROM asignaciones_viaje WHERE chofer_id = $1 AND hasta IS NULL', [choferId]);
  assert.equal(abiertas.length, 0);
  assert.ok((await pedir('GET', '/pasajeros/me/viajes', { token: tokens.pasajero })).body.viajes.some((v) => v.id === viajeId));
  assert.ok((await pedir('GET', '/choferes/me/viajes', { token: tokens.chofer })).body.viajes.some((v) => v.id === viajeId));
  assert.deepEqual((await pedir('GET', '/pasajeros/me/viajes', { token: tokens.otroPasajero })).body.viajes.filter((v) => v.id === viajeId), []);

  const eventos = await pedir('GET', `/viajes/${viajeId}/eventos`, { token: tokens.pasajero });
  assert.deepEqual(eventos.body.eventos.map((e) => e.evento),
    ['viaje_solicitado', 'aceptar_oferta', 'salir_en_camino', 'iniciar', 'finalizar']);
  assert.equal((await pedir('GET', `/viajes/${viajeId}/eventos`, { token: tokens.otroPasajero })).status, 404);
});

test('panel del operador: ve los viajes en curso y cancela con motivo; sin motivo es 400', async () => {
  const viajeId = await pedirViaje();
  await aceptarOfertaDe(viajeId);

  const panel = await pedir('GET', '/operador/viajes', { token: tokens.operador });
  assert.equal(panel.status, 200);
  assert.ok(panel.body.viajes.some((v) => v.id === viajeId && v.estado === 'asignado'));
  assert.equal((await pedir('GET', '/operador/viajes', { token: tokens.pasajero })).status, 403);

  assert.equal((await pedir('POST', `/operador/viajes/${viajeId}/cancelar`, { token: tokens.operador, body: {} })).status, 400);
  const cancelado = await pedir('POST', `/operador/viajes/${viajeId}/cancelar`, {
    token: tokens.operador, body: { motivo: 'El pasajero reporto un problema' },
  });
  assert.equal(cancelado.status, 200);
  assert.equal(cancelado.body.estado, 'cancelado_pasajero');
  assert.equal(cancelado.body.motivoCierre, 'El pasajero reporto un problema');
  assert.ok(!(await pedir('GET', '/operador/viajes', { token: tokens.operador })).body.viajes.some((v) => v.id === viajeId));

  // Un viaje terminado no se puede volver a cancelar.
  const otraVez = await pedir('POST', `/viajes/${viajeId}/cancelar`, { token: tokens.pasajero });
  assert.equal(otraVez.status, 409);
  assert.equal(otraVez.body.error.codigo, 'TRANSICION_INVALIDA');
});
