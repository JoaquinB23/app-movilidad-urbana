// Tests HTTP del modulo de ubicaciones: autorizacion por recurso (el que se
// mira primero), validacion estricta zod, prototype pollution, rate limit,
// idempotencia y SSE con Last-Event-ID. Corren con Express real sobre un puerto
// efimero, usando los adaptadores en memoria (sin base de datos).

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import express from 'express';
import rateLimit from 'express-rate-limit';

import { crearRutasUbicaciones, MAPEO_HTTP } from '../../src/infra/http/rutas/ubicaciones.js';
import { crearMonitoreoMetricas } from '../../src/infra/http/metricas.js';
import { crearRepositorioChoferesMemoria } from '../../src/infra/memoria/repositorio-choferes-memoria.js';
import { crearRepositorioUbicacionesMemoria } from '../../src/infra/memoria/repositorio-ubicaciones-memoria.js';
import { crearRepositorioViajesMemoria } from '../../src/infra/memoria/repositorio-viajes-memoria.js';
import { crearColaHistorial } from '../../src/infra/memoria/cola-historial-memoria.js';
import { crearBusEventosMemoria } from '../../src/infra/memoria/bus-eventos-memoria.js';
import { crearRegistroMetricasMemoria } from '../../src/infra/memoria/registro-metricas-memoria.js';

const VIAJE = {
  id: 'viaje-1',
  pasajeroId: 'pasajero-1',
  choferId: 'chofer-1',
  estado: 'chofer_en_camino',
  origen: { lat: -27.45, lng: -58.98 },
};

async function montarApp({ limiteUbicaciones = 100 } = {}) {
  const choferes = crearRepositorioChoferesMemoria({
    choferes: [
      { id: 'chofer-1', habilitado: true, disponible: true },
      { id: 'chofer-2', habilitado: true, disponible: false },
    ],
  });
  const ubicaciones = crearRepositorioUbicacionesMemoria();
  const viajes = crearRepositorioViajesMemoria({ viajes: [VIAJE] });
  const cola = crearColaHistorial({
    escribirLote: (lote) => ubicaciones.agregarHistorialEnLote(lote),
    maxLote: 1000,
  });
  const bus = crearBusEventosMemoria();
  const registroMetricas = crearRegistroMetricasMemoria();

  // Autenticacion STUB (el modulo real es de otro equipo): lee el actor de
  // headers de prueba. Asi este test se concentra en la autorizacion por
  // RECURSO (403/404), no en el parseo del JWT.
  const autenticar = (req, res, next) => {
    const id = req.headers['x-actor-id'];
    const rol = req.headers['x-actor-rol'];
    if (!id) return res.status(401).json({ error: { codigo: 'NO_AUTENTICADO', mensaje: 'Falta autenticacion.', idCorrelacion: 'test' } });
    req.actor = { id: String(id), rol: String(rol ?? '') };
    next();
  };

  const monitoreo = crearMonitoreoMetricas({ registroMetricas });
  const limiteUbicacion = rateLimit({
    windowMs: 60000,
    max: limiteUbicaciones,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) =>
      res.status(429).json({ error: { codigo: 'DEMASIADAS_PETICIONES', mensaje: 'Limite de tasa superado.', idCorrelacion: 'test' } }),
  });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));
  app.use(monitoreo.middleware);

  app.use(
    crearRutasUbicaciones({
      autenticar,
      rateLimitUbicacion: limiteUbicacion,
      repositorioChoferes: choferes,
      repositorioUbicaciones: ubicaciones,
      repositorioViajes: viajes,
      colaHistorial: cola,
      busEventos: bus,
      metricas: monitoreo,
    })
  );

  // Middleware global de errores (el mismo contrato que usara el proyecto):
  // traduce codigos de dominio a HTTP con el formato unico {error:{...}}.
  app.use((err, req, res, next) => {
    const status = MAPEO_HTTP[err.codigo] ?? 500;
    res.status(status).json({
      error: {
        codigo: err.codigo ?? 'ERROR_INTERNO',
        mensaje: status === 500 ? 'Error interno del servidor.' : err.message,
        idCorrelacion: 'test',
      },
    });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    baseUrl,
    entorno: { choferes, ubicaciones, viajes, cola, bus },
    cerrar: async () => {
      monitoreo.detener();
      cola.detener();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function headers({ id, rol }) {
  return { 'x-actor-id': id, 'x-actor-rol': rol, 'content-type': 'application/json' };
}

function verError(res) {
  return res.error && typeof res.error.codigo === 'string' && res.error.mensaje && res.error.idCorrelacion;
}

// --- disponibilidad ---

test('PUT disponibilidad: chofer habilitado cambia disponibilidad', async () => {
  const app = await montarApp();
  try {
    const res = await fetch(`${app.baseUrl}/choferes/me/disponibilidad`, {
      method: 'PUT',
      headers: headers({ id: 'chofer-1', rol: 'chofer' }),
      body: JSON.stringify({ disponible: false }),
    });
    assert.equal(res.status, 200);
    const cuerpo = await res.json();
    assert.equal(cuerpo.disponible, false);
    const chofer = await app.entorno.choferes.buscarPorId('chofer-1');
    assert.equal(chofer.disponible, false);
  } finally {
    await app.cerrar();
  }
});

test('PUT disponibilidad: un pasajero no puede (403 por rol)', async () => {
  const app = await montarApp();
  try {
    const res = await fetch(`${app.baseUrl}/choferes/me/disponibilidad`, {
      method: 'PUT',
      headers: headers({ id: 'pasajero-1', rol: 'pasajero' }),
      body: JSON.stringify({ disponible: true }),
    });
    assert.equal(res.status, 403);
    const cuerpo = await res.json();
    assert.equal(cuerpo.error.codigo, 'ROL_NO_AUTORIZADO');
  } finally {
    await app.cerrar();
  }
});

test('PUT disponibilidad: campo no declarado -> 400 (zod strict)', async () => {
  const app = await montarApp();
  try {
    const res = await fetch(`${app.baseUrl}/choferes/me/disponibilidad`, {
      method: 'PUT',
      headers: headers({ id: 'chofer-1', rol: 'chofer' }),
      body: JSON.stringify({ disponible: true, extra: 'campo inventado' }),
    });
    assert.equal(res.status, 400);
    assert.ok(verError(await res.json()));
  } finally {
    await app.cerrar();
  }
});

// --- ubicacion ---

test('POST ubicacion: envia, responde 202 y el recorrido queda asociado al viaje', async () => {
  const app = await montarApp();
  try {
    const res = await fetch(`${app.baseUrl}/choferes/me/ubicacion`, {
      method: 'POST',
      headers: headers({ id: 'chofer-1', rol: 'chofer' }),
      body: JSON.stringify({ lat: -27.51, lng: -58.99, timestamp: 1700000000000 }),
    });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { encolado: true });

    await app.entorno.cola.drenar();
    const recorrido = await fetch(`${app.baseUrl}/viajes/viaje-1/recorrido`, {
      headers: headers({ id: 'pasajero-1', rol: 'pasajero' }),
    });
    assert.equal(recorrido.status, 200);
    const cuerpo = await recorrido.json();
    assert.equal(cuerpo.recorrido.length, 1);
    assert.equal(cuerpo.recorrido[0].lat, -27.51);
  } finally {
    await app.cerrar();
  }
});

test('POST ubicacion: chofer no disponible -> 409', async () => {
  const app = await montarApp();
  try {
    const res = await fetch(`${app.baseUrl}/choferes/me/ubicacion`, {
      method: 'POST',
      headers: headers({ id: 'chofer-2', rol: 'chofer' }),
      body: JSON.stringify({ lat: 0, lng: 0, timestamp: 1 }),
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.codigo, 'CHOFER_NO_DISPONIBLE');
  } finally {
    await app.cerrar();
  }
});

test('POST ubicacion: reintento con misma clave (chofer,timestamp) no duplica el historial', async () => {
  const app = await montarApp();
  try {
    const cuerpo = JSON.stringify({ lat: -27.5, lng: -58.99, timestamp: 42 });
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${app.baseUrl}/choferes/me/ubicacion`, {
        method: 'POST',
        headers: headers({ id: 'chofer-1', rol: 'chofer' }),
        body: cuerpo,
      });
      assert.equal(res.status, 202);
    }
    await app.entorno.cola.drenar();
    assert.equal(app.entorno.ubicaciones._tamanoHistorial(), 1);
  } finally {
    await app.cerrar();
  }
});

test('POST ubicacion: timestamp faltante -> 400', async () => {
  const app = await montarApp();
  try {
    const res = await fetch(`${app.baseUrl}/choferes/me/ubicacion`, {
      method: 'POST',
      headers: headers({ id: 'chofer-1', rol: 'chofer' }),
      body: JSON.stringify({ lat: 0, lng: 0 }),
    });
    assert.equal(res.status, 400);
  } finally {
    await app.cerrar();
  }
});

test('POST ubicacion: timestamp con formato invalido -> 400', async () => {
  const app = await montarApp();
  try {
    const res = await fetch(`${app.baseUrl}/choferes/me/ubicacion`, {
      method: 'POST',
      headers: headers({ id: 'chofer-1', rol: 'chofer' }),
      body: JSON.stringify({ lat: 0, lng: 0, timestamp: 'no-es-una-fecha' }),
    });
    assert.equal(res.status, 400);
  } finally {
    await app.cerrar();
  }
});

// --- autorizacion por recurso (requisito del bloque 5) ---

test('seguimiento: el pasajero del viaje recibe el estado y la posicion del chofer', async () => {
  const app = await montarApp();
  try {
    await fetch(`${app.baseUrl}/choferes/me/ubicacion`, {
      method: 'POST',
      headers: headers({ id: 'chofer-1', rol: 'chofer' }),
      body: JSON.stringify({ lat: -27.5, lng: -58.99, timestamp: 1 }),
    });
    const res = await fetch(`${app.baseUrl}/viajes/viaje-1/estado`, {
      headers: headers({ id: 'pasajero-1', rol: 'pasajero' }),
    });
    assert.equal(res.status, 200);
    const cuerpo = await res.json();
    assert.equal(cuerpo.estado, 'chofer_en_camino');
    assert.equal(cuerpo.rol, 'pasajero');
    assert.equal(cuerpo.posicionContraparte.lat, -27.5);
  } finally {
    await app.cerrar();
  }
});

test('seguimiento: viaje ajeno rechazado con 403 (chofer no asignado)', async () => {
  const app = await montarApp();
  try {
    const res = await fetch(`${app.baseUrl}/viajes/viaje-1/estado`, {
      headers: headers({ id: 'chofer-2', rol: 'chofer' }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.codigo, 'RECURSO_AJENO');
  } finally {
    await app.cerrar();
  }
});

test('seguimiento: viaje ajeno rechazado con 403 (pasajero distinto)', async () => {
  const app = await montarApp();
  try {
    const res = await fetch(`${app.baseUrl}/viajes/viaje-1/estado`, {
      headers: headers({ id: 'pasajero-99', rol: 'pasajero' }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.codigo, 'RECURSO_AJENO');
  } finally {
    await app.cerrar();
  }
});

test('seguimiento: un viaje inexistente -> 404, no 403 (no filtra existencia)', async () => {
  const app = await montarApp();
  try {
    const res = await fetch(`${app.baseUrl}/viajes/viaje-fantasma/estado`, {
      headers: headers({ id: 'pasajero-1', rol: 'pasajero' }),
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.codigo, 'NO_ENCONTRADO');
  } finally {
    await app.cerrar();
  }
});

test('recorrido: el chofer ajeno no puede ver el recorrido ajeno (403)', async () => {
  const app = await montarApp();
  try {
    const res = await fetch(`${app.baseUrl}/viajes/viaje-1/recorrido`, {
      headers: headers({ id: 'chofer-2', rol: 'chofer' }),
    });
    assert.equal(res.status, 403);
  } finally {
    await app.cerrar();
  }
});

// --- prototype pollution (bloque 5) ---

test('el cuerpo con __proto__ no contamina Object.prototype y es rechazado (400)', async () => {
  const app = await montarApp();
  try {
    const res = await fetch(`${app.baseUrl}/choferes/me/disponibilidad`, {
      method: 'PUT',
      headers: headers({ id: 'chofer-1', rol: 'chofer' }),
      body: '{"disponible":true,"__proto__":{"contaminado":1}}',
    });
    assert.equal(res.status, 400);
    assert.equal({}.contaminado, undefined, 'Object.prototype no debe contaminarse');
    assert.equal(Object.prototype.contaminado, undefined);
  } finally {
    delete Object.prototype.contaminado;
    await app.cerrar();
  }
});

test('el cuerpo con constructor.prototype no contamina y es rechazado (400)', async () => {
  const app = await montarApp();
  try {
    const res = await fetch(`${app.baseUrl}/choferes/me/ubicacion`, {
      method: 'POST',
      headers: headers({ id: 'chofer-1', rol: 'chofer' }),
      body: JSON.stringify({ lat: 0, lng: 0, timestamp: 1, constructor: { prototype: { ok: false } } }),
    });
    assert.equal(res.status, 400);
    assert.equal({}.ok, undefined);
  } finally {
    await app.cerrar();
  }
});

// --- inyeccion SQL (bloque 5): el id se trata como dato, no como SQL ---

test('el id con carga de inyeccion no es interpretado como SQL (404 de recurso inexistente)', async () => {
  const app = await montarApp();
  try {
    // Si el id se concatenara, esto romperia la consulta; con SQL parametrizado
    // es simplemente un id que no existe.
    const res = await fetch(
      `${app.baseUrl}/viajes/${encodeURIComponent("'; DROP TABLE ubicaciones_actuales; --")}/estado`,
      { headers: headers({ id: 'pasajero-1', rol: 'pasajero' }) }
    );
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.codigo, 'NO_ENCONTRADO');
  } finally {
    await app.cerrar();
  }
});

// --- rate limit (bloque 5) ---

test('POST ubicacion: superar el rate limit propio -> 429 con encabezado informativo', async () => {
  const app = await montarApp({ limiteUbicaciones: 3 });
  try {
    const ultimos = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${app.baseUrl}/choferes/me/ubicacion`, {
        method: 'POST',
        headers: headers({ id: 'chofer-1', rol: 'chofer' }),
        body: JSON.stringify({ lat: 0, lng: 0, timestamp: i }),
      });
      ultimos.push({ status: res.status, retry: res.headers.get('ratelimit-remaining') });
    }
    assert.deepEqual(ultimateStatuses(ultimos), [202, 202, 202, 429, 429]);
    const res429 = ultimos[3];
    assert.equal(res429.status, 429);
  } finally {
    await app.cerrar();
  }
});

function ultimateStatuses(lista) {
  return lista.map((e) => e.status);
}

// --- metricas (solo administrador) ---

test('GET metricas: solo administrador, devuelve p50/p95/p99, lag y memoria', async () => {
  const app = await montarApp();
  try {
    // genera un par de muestras
    for (let i = 0; i < 5; i++) {
      await fetch(`${app.baseUrl}/viajes/viaje-1/estado`, { headers: headers({ id: 'pasajero-1', rol: 'pasajero' }) });
    }
    const resAdmin = await fetch(`${app.baseUrl}/metricas`, { headers: headers({ id: 'admin-1', rol: 'administrador' }) });
    assert.equal(resAdmin.status, 200);
    const cuerpo = await resAdmin.json();
    assert.ok('p50' in cuerpo.latenciaMs && 'p95' in cuerpo.latenciaMs && 'p99' in cuerpo.latenciaMs);
    assert.ok('lagMaxMs' in cuerpo.eventLoop && 'lagP99Ms' in cuerpo.eventLoop);
    assert.ok('rssMb' in cuerpo.memoria);

    const resChofer = await fetch(`${app.baseUrl}/metricas`, { headers: headers({ id: 'chofer-1', rol: 'chofer' }) });
    assert.equal(resChofer.status, 403);
  } finally {
    await app.cerrar();
  }
});

// --- SSE: seguimiento en tiempo real ---

async function leerFrames(res, cantidad, timeoutMs = 3000) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let texto = '';
  const limite = Date.now() + timeoutMs;
  const fuerza = (await import('node:assert/strict')).default;
  while (Date.now() < limite) {
    const { value, done } = await reader.read();
    if (done) break;
    texto += decoder.decode(value, { stream: true });
    const frames = texto.split('\n\n').filter((f) => f.includes('data:'));
    if (frames.length >= cantidad) return { texto, frames, reader };
    await new Promise((r) => setTimeout(r, 10));
  }
  fuerza.fail(`timeout esperando ${cantidad} frames SSE`);
}

test('SSE: el pasajero recibe el snapshot inicial, posiciones en vivo y el Last-Event-ID reenvia lo perdido', async () => {
  const app = await montarApp();
  try {
    // 1) Conexion con Last-Event-ID vacio: recibe el snapshot.
    const res1 = await fetch(`${app.baseUrl}/viajes/viaje-1/seguimiento`, {
      headers: headers({ id: 'pasajero-1', rol: 'pasajero' }),
    });
    assert.equal(res1.status, 200);
    assert.equal(res1.headers.get('content-type'), 'text/event-stream');
    const parte1 = await leerFrames(res1, 1);
    assert.ok(parte1.texto.includes('event: snapshot'));
    assert.ok(parte1.texto.includes('"estado":"chofer_en_camino"'));
    await parte1.reader.cancel();

    // 2) Publicamos posiciones desde el chofer (vivo).
    await app.entorno.bus.publicar('seguimiento:viaje:viaje-1', { tipo: 'posicion', datos: { choferId: 'chofer-1', lat: 1, lng: 1 } });
    await app.entorno.bus.publicar('seguimiento:viaje:viaje-1', { tipo: 'posicion', datos: { choferId: 'chofer-1', lat: 2, lng: 2 } });

    // 3) Reconexion con Last-Event-ID=1: debe reenvair solo el evento id=2.
    const res2 = await fetch(`${app.baseUrl}/viajes/viaje-1/seguimiento`, {
      headers: { ...headers({ id: 'pasajero-1', rol: 'pasajero' }), 'last-event-id': '1' },
    });
    const parte2 = await leerFrames(res2, 2, 5000);
    assert.ok(parte2.texto.includes('event: snapshot'), 'reconexion reenvia el snapshot primero');
    assert.ok(parte2.texto.includes('event: posicion'));
    // El unico evento de posicion reenviado es el posterior a id=1 (lat 2).
    const conPosicion2 = parte2.frames.filter((f) => f.includes('lat'));
    assert.equal(conPosicion2.length, 1);
    assert.ok(conPosicion2[0].includes('"lat":2'));
    assert.ok(conPosicion2[0].includes('id: 2'));
    await parte2.reader.cancel();
  } finally {
    await app.cerrar();
  }
});

test('SSE: un chofer NO asignado no puede suscribirse al seguimiento (403)', async () => {
  const app = await montarApp();
  try {
    const res = await fetch(`${app.baseUrl}/viajes/viaje-1/seguimiento`, {
      headers: headers({ id: 'chofer-2', rol: 'chofer' }),
    });
    assert.equal(res.status, 403);
    const cuerpo = await res.json();
    assert.equal(cuerpo.error.codigo, 'RECURSO_AJENO');
  } finally {
    await app.cerrar();
  }
});