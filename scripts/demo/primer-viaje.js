// Ejecutar contra la API local levantada con el seed y la misma DATABASE_URL.
// Requiere un chofer habilitado, libre y único candidato cercano al origen.
// node --env-file=.env scripts/demo/primer-viaje.js
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { crearPoolPg } from '../../src/infra/db/pool-pg.js';

const base = process.env.API_BASE ?? 'http://localhost:' + (process.env.PUERTO_HTTP ?? 3000);
const origen = { lat: -27.4514, lng: -58.9866 };
const destino = { lat: -27.46, lng: -58.99 };

function variable(nombre) {
  if (!process.env[nombre]) throw new Error('Falta ' + nombre + ' en el entorno de la demo.');
  return process.env[nombre];
}

async function pedir(ruta, { method = 'GET', token, body, headers = {}, signal } = {}) {
  const res = await fetch(new URL(ruta, base), {
    method, headers: {
      ...(body && { 'content-type': 'application/json' }),
      ...(token && { authorization: 'Bearer ' + token }), ...headers,
    },
    body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(method + ' ' + ruta + ' respondió HTTP ' + res.status);
  return res;
}

async function* eventos(res) {
  const lineas = createInterface({ input: Readable.fromWeb(res.body), crlfDelay: Infinity });
  let tipo;
  let datos;
  for await (const linea of lineas) {
    if (linea.startsWith('event: ')) tipo = linea.slice(7);
    if (linea.startsWith('data: ')) datos = JSON.parse(linea.slice(6));
    if (!linea) {
      if (tipo && datos) yield { tipo, datos };
      tipo = datos = undefined;
    }
  }
}

async function demo() {
  const sesiones = {};
  for (const rol of ['pasajero', 'chofer']) {
    const prefijo = 'DEMO_' + rol.toUpperCase();
    const body = {
      email: process.env[prefijo + '_EMAIL'] ?? rol + '1@movilidad.invalid',
      password: process.env[prefijo + '_PASSWORD'] ?? variable('SEED_PASSWORD'),
    };
    sesiones[rol] = await (await pedir('/auth/login', { method: 'POST', body })).json();
    assert.equal(sesiones[rol].usuario.rol, rol);
  }
  const { pasajero, chofer } = sesiones;
  const pool = crearPoolPg({ connectionString: variable('DATABASE_URL') });
  const cierre = new AbortController();
  try {
    await pedir('/choferes/me/disponibilidad', { method: 'PUT', token: chofer.token, body: { disponible: true } });
    await pedir('/choferes/me/ubicacion', { method: 'POST', token: chofer.token, body: { ...origen, timestamp: Date.now() } });
    const solicitud = { method: 'POST', token: pasajero.token, body: { origen, destino } };
    const estimacion = await (await pedir('/viajes/estimacion', solicitud)).json();
    assert.ok(Number.isInteger(estimacion.precioCentavos));
    const viaje = await (await pedir('/viajes', { ...solicitud, headers: { 'Idempotency-Key': randomUUID() } })).json();
    assert.equal(viaje.estado, 'solicitado');
    console.log('Viaje solicitado:', viaje.id);
    const stream = await pedir('/viajes/' + viaje.id + '/seguimiento', {
      token: pasajero.token, signal: AbortSignal.any([cierre.signal, AbortSignal.timeout(20000)]),
    });
    let confirmado = false;
    for await (const { tipo, datos } of eventos(stream)) {
      if (tipo === 'snapshot') {
        assert.equal(datos.estado, 'solicitado');
        const { ofertas } = await (await pedir('/choferes/me/ofertas', { token: chofer.token })).json();
        const oferta = ofertas.find(item => item.viajeId === viaje.id);
        assert.ok(oferta, 'El chofer de la demo debe recibir la oferta del viaje.');
        await pedir('/ofertas/' + oferta.id + '/aceptar', { method: 'POST', token: chofer.token });
      }
      if (tipo === 'estado' && datos.viajeId === viaje.id && datos.estado === 'asignado') {
        confirmado = true;
        break;
      }
    }
    assert.ok(confirmado, 'El pasajero debe recibir asignado en la misma conexión SSE.');
    const { rows } = await pool.query(
      'SELECT viaje_id, chofer_id FROM asignaciones_viaje WHERE hasta IS NULL AND (viaje_id = $1 OR chofer_id = $2)',
      [viaje.id, chofer.usuario.id]
    );
    assert.deepEqual(rows, [{ viaje_id: viaje.id, chofer_id: chofer.usuario.id }]);
    console.log('Verificado: estado asignado en vivo y una sola asignación abierta en PostgreSQL.');
  } finally {
    cierre.abort();
    await pool.end();
  }
}

demo().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
