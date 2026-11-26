// Prueba de aceptacion del P0 (acuerdo de trabajo, "Cierre juntos"), de punta
// a punta por HTTP contra la app REAL (src/servidor.js + composicion) y
// PostgreSQL de test:
//
//   1. El chofer del seed inicia sesion, se pone disponible y reporta posicion.
//   2. El pasajero del seed estima y pide el viaje (con Idempotency-Key).
//   3. El pasajero abre el seguimiento SSE ANTES de la aceptacion.
//   4. El chofer ve su oferta y la acepta.
//   5. El pasajero recibe event: estado "asignado" por el SSE, sin recargar.
//   6. En la base queda exactamente UNA asignacion abierta, de ese chofer.

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

const PASSWORD = 'clave-p0-de-prueba';
const EMAILS = {
  pasajero: 'pasajero1@movilidad.invalid',
  otroPasajero: 'pasajero2@movilidad.invalid',
  chofer: 'chofer1@movilidad.invalid',
};
const ORIGEN = { lat: -27.4514, lng: -58.9866 };
const DESTINO = { lat: -27.46, lng: -58.99 };

const db = new pg.Pool({ connectionString: urlTest });
let servidor;
let baseUrl;
let choferId;

async function limpiarViajesDelSeed() {
  const usuariosSeed = `SELECT id FROM usuarios WHERE email LIKE '%@movilidad.invalid'`;
  const viajesSeed = `SELECT id FROM viajes WHERE pasajero_id IN (${usuariosSeed})`;
  await db.query(`DELETE FROM viajes_eventos WHERE viaje_id IN (${viajesSeed})`);
  await db.query(`DELETE FROM ofertas_viaje WHERE viaje_id IN (${viajesSeed})`);
  await db.query(`DELETE FROM asignaciones_viaje WHERE viaje_id IN (${viajesSeed})`);
  await db.query(`DELETE FROM ubicaciones_historial WHERE chofer_id IN (${usuariosSeed})`);
  await db.query(`DELETE FROM viajes WHERE pasajero_id IN (${usuariosSeed})`);
  await db.query(`DELETE FROM claves_idempotencia WHERE usuario_id IN (${usuariosSeed})`);
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
  return { status: res.status, headers: res.headers, body: texto ? JSON.parse(texto) : null };
}

async function login(email) {
  const res = await pedir('POST', '/auth/login', { body: { email, password: PASSWORD } });
  assert.equal(res.status, 200, `login de ${email}: ${JSON.stringify(res.body)}`);
  return res.body.token;
}

// Cliente SSE minimo con fetch + Bearer (el mismo mecanismo que usara el
// frontend). Junta los eventos y permite esperar uno por tipo.
function abrirSeguimiento(viajeId, token) {
  const controlador = new AbortController();
  const eventos = [];
  const esperas = [];
  const listo = fetch(`${baseUrl}/viajes/${viajeId}/seguimiento`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controlador.signal,
  }).then(async (res) => {
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
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
            const tipo = bloque.match(/^event: (.+)$/m)?.[1];
            const datos = bloque.match(/^data: (.+)$/m)?.[1];
            if (!tipo || !datos) continue;
            const evento = { tipo, id: bloque.match(/^id: (.+)$/m)?.[1] ?? null, datos: JSON.parse(datos) };
            eventos.push(evento);
            for (const espera of esperas.filter((e) => e.condicion(evento))) espera.resolver(evento);
          }
        }
      } catch (error) {
        if (error.name !== 'AbortError') throw error;
      }
    })();
  });

  return {
    listo,
    eventos,
    esperar(condicion, ms = 5000) {
      const yaLlego = eventos.find(condicion);
      if (yaLlego) return Promise.resolve(yaLlego);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('No llegó el evento SSE esperado.')), ms);
        esperas.push({ condicion, resolver: (e) => { clearTimeout(timer); resolve(e); } });
      });
    },
    cerrar: () => controlador.abort(),
  };
}

before(async () => {
  const urlOriginal = process.env.DATABASE_URL;
  try {
    process.env.DATABASE_URL = urlTest;
    await migrar(); // idempotente: aplica solo lo que falte (p. ej. la 301)
  } finally {
    if (urlOriginal === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = urlOriginal;
  }

  await limpiarViajesDelSeed();
  // Ningun otro chofer de pruebas anteriores puede ser candidato: solo el del seed.
  await db.query('TRUNCATE TABLE ubicaciones_actuales');
  const { ids } = await sembrarDatosBase({ pool: db, hasher: await crearHasherArgon2(), password: PASSWORD });
  choferId = ids[EMAILS.chofer];

  servidor = await arrancar({
    ...process.env,
    DATABASE_URL: urlTest,
    PUERTO_HTTP: '0',
    HOST: '127.0.0.1',
    LOG_NIVEL: 'silent',
  });
  baseUrl = `http://127.0.0.1:${servidor.puerto}`;
});

after(async () => {
  await servidor?.apagar('test');
  await limpiarViajesDelSeed();
  await db.query(`UPDATE choferes SET disponible = false WHERE usuario_id = $1`, [choferId]);
  await db.query('DELETE FROM ubicaciones_actuales WHERE chofer_id = $1', [choferId]);
  await db.end();
});

test('infraestructura: /health, /ready, 404 con formato comun e id de correlacion', async () => {
  assert.deepEqual((await pedir('GET', '/health')).body, { estado: 'ok' });
  assert.deepEqual((await pedir('GET', '/ready')).body, { estado: 'listo' });

  const metricas = await fetch(`${baseUrl}/metrics`);
  assert.equal(metricas.status, 200);
  const texto = await metricas.text();
  assert.match(texto, /nodejs_eventloop_lag_p99_seconds/);
  assert.match(texto, /cola_historial_pendientes/);
  assert.match(texto, /pg_pool_conexiones/);

  const inexistente = await pedir('GET', '/no-existe', { headers: { 'x-request-id': 'pedido-123' } });
  assert.equal(inexistente.status, 404);
  assert.equal(inexistente.headers.get('x-request-id'), 'pedido-123');
  assert.deepEqual(inexistente.body.error, {
    codigo: 'RUTA_NO_ENCONTRADA',
    mensaje: 'La ruta no existe.',
    idCorrelacion: 'pedido-123',
  });
});

test('errores comunes: JSON mal formado 400, sin token 401, rol equivocado 403', async () => {
  const malFormado = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"email":',
  });
  assert.equal(malFormado.status, 400);
  assert.equal((await malFormado.json()).error.codigo, 'JSON_INVALIDO');

  assert.equal((await pedir('POST', '/viajes/estimacion', { body: { origen: ORIGEN, destino: DESTINO } })).status, 401);

  const tokenChofer = await login(EMAILS.chofer);
  const rolEquivocado = await pedir('POST', '/viajes/estimacion', {
    token: tokenChofer, body: { origen: ORIGEN, destino: DESTINO },
  });
  assert.equal(rolEquivocado.status, 403);
  assert.ok(rolEquivocado.body.error.idCorrelacion);
});

test('primer viaje real: solicitud, oferta, aceptación y "asignado" por SSE', async () => {
  // 1. Chofer disponible y con posicion reportada.
  const tokenChofer = await login(EMAILS.chofer);
  const disponible = await pedir('PUT', '/choferes/me/disponibilidad', {
    token: tokenChofer, body: { disponible: true },
  });
  assert.equal(disponible.status, 200, JSON.stringify(disponible.body));
  const posicion = await pedir('POST', '/choferes/me/ubicacion', {
    token: tokenChofer, body: { ...ORIGEN, timestamp: new Date().toISOString() },
  });
  assert.equal(posicion.status, 202, JSON.stringify(posicion.body));

  // 2. Pasajero estima y solicita.
  const tokenPasajero = await login(EMAILS.pasajero);
  const estimacion = await pedir('POST', '/viajes/estimacion', {
    token: tokenPasajero, body: { origen: ORIGEN, destino: DESTINO },
  });
  assert.equal(estimacion.status, 200, JSON.stringify(estimacion.body));
  assert.ok(Number.isInteger(estimacion.body.precioCentavos) && estimacion.body.precioCentavos > 0);
  assert.deepEqual(Object.keys(estimacion.body).sort(), ['distanciaMetros', 'duracionSegundos', 'precioCentavos']);

  const clave = randomUUID();
  const solicitud = await pedir('POST', '/viajes', {
    token: tokenPasajero, body: { origen: ORIGEN, destino: DESTINO }, headers: { 'Idempotency-Key': clave },
  });
  assert.equal(solicitud.status, 201, JSON.stringify(solicitud.body));
  assert.equal(solicitud.body.estado, 'solicitado');
  const viajeId = solicitud.body.id;

  // Reintento con la misma clave: el mismo viaje, no uno nuevo.
  const reintento = await pedir('POST', '/viajes', {
    token: tokenPasajero, body: { origen: ORIGEN, destino: DESTINO }, headers: { 'Idempotency-Key': clave },
  });
  assert.equal(reintento.body.id, viajeId);

  // 3. Seguimiento abierto ANTES de aceptar.
  const seguimiento = abrirSeguimiento(viajeId, tokenPasajero);
  await seguimiento.listo;
  const snapshot = await seguimiento.esperar((e) => e.tipo === 'snapshot');
  assert.equal(snapshot.datos.estado, 'solicitado');

  try {
    // 4. El chofer ve su oferta y la acepta.
    const ofertas = await pedir('GET', '/choferes/me/ofertas', { token: tokenChofer });
    assert.equal(ofertas.status, 200);
    const oferta = ofertas.body.ofertas.find((o) => o.viajeId === viajeId);
    assert.ok(oferta, `el chofer no recibió oferta: ${JSON.stringify(ofertas.body)}`);
    // La oferta dice donde es el viaje: el chofer sabe a donde va antes de aceptar.
    assert.deepEqual(oferta.origen, ORIGEN);
    assert.deepEqual(oferta.destino, DESTINO);
    assert.ok(Number.isInteger(oferta.tarifaEstimadaCentavos));

    const aceptacion = await pedir('POST', `/ofertas/${oferta.id}/aceptar`, { token: tokenChofer });
    assert.equal(aceptacion.status, 200, JSON.stringify(aceptacion.body));
    assert.deepEqual(aceptacion.body, { viajeId, ofertaId: oferta.id, estado: 'asignado' });

    // 5. El pasajero ve "asignado" por el stream, sin recargar.
    const evento = await seguimiento.esperar((e) => e.tipo === 'estado');
    assert.deepEqual(evento.datos, { viajeId, estado: 'asignado' });
    assert.ok(evento.id, 'el evento lleva id para Last-Event-ID');
  } finally {
    seguimiento.cerrar();
  }

  // GET /viajes/:id: el dueño lo ve; otro pasajero recibe 404 (no 403).
  const propio = await pedir('GET', `/viajes/${viajeId}`, { token: tokenPasajero });
  assert.equal(propio.body.id, viajeId);
  assert.equal(propio.body.estado, 'asignado');
  assert.deepEqual(propio.body.origen, ORIGEN);
  assert.deepEqual(propio.body.destino, DESTINO);
  const ajeno = await pedir('GET', `/viajes/${viajeId}`, { token: await login(EMAILS.otroPasajero) });
  assert.equal(ajeno.status, 404);

  // 6. Dato final en la base: exactamente una asignacion abierta, de ese chofer.
  const { rows } = await db.query(
    'SELECT chofer_id FROM asignaciones_viaje WHERE viaje_id = $1 AND hasta IS NULL', [viajeId]
  );
  assert.deepEqual(rows, [{ chofer_id: choferId }]);
  const { rows: viajes } = await db.query('SELECT estado FROM viajes WHERE id = $1', [viajeId]);
  assert.equal(viajes[0].estado, 'asignado');
});
