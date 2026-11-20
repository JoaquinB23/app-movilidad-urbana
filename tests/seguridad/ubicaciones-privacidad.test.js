// Privacidad del seguimiento (requisito 6.4) a nivel HTTP/SSE, con Express real
// sobre un puerto efimero y adaptadores en memoria (sin base de datos).
//
// Se montan DOS viajes completos y distintos:
//   viaje-1: pasajero-1 / chofer-1  (origen -27.45, -58.98)
//   viaje-2: pasajero-2 / chofer-2  (origen -26.00, -57.00)
// y se verifica que:
//   * cada pasajero vea SOLO la posicion de su chofer;
//   * cada chofer vea SOLO el origen de su pasajero;
//   * actores ajenos (otro pasajero, chofer de otro viaje, operador/admin)
//     reciban un rechazo sin datos;
//   * los canales SSE de dos viajes no se crucen;
//   * el cuerpo del error no agregue datos que confirmen la existencia del viaje.
//
// La autenticacion es un STUB (lee el actor de headers): el modulo real de
// identidad es de otro equipo. Lo que se prueba aca es la autorizacion POR
// RECURSO, que es la que decide si se expone o no la ubicacion.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import express from 'express';

import { crearRutasUbicaciones, MAPEO_HTTP } from '../../src/infra/http/rutas/ubicaciones.js';
import { crearMonitoreoMetricas } from '../../src/infra/http/metricas.js';
import { crearRepositorioChoferesMemoria } from '../../src/infra/memoria/repositorio-choferes-memoria.js';
import { crearRepositorioUbicacionesMemoria } from '../../src/infra/memoria/repositorio-ubicaciones-memoria.js';
import { crearRepositorioViajesMemoria } from '../../src/infra/memoria/repositorio-viajes-memoria.js';
import { crearBusEventosMemoria } from '../../src/infra/memoria/bus-eventos-memoria.js';
import { crearRegistroMetricasMemoria } from '../../src/infra/memoria/registro-metricas-memoria.js';

const VIAJE_1 = {
  id: 'viaje-1',
  pasajeroId: 'pasajero-1',
  choferId: 'chofer-1',
  estado: 'en_curso',
  origen: { lat: -27.45, lng: -58.98 },
};

const VIAJE_2 = {
  id: 'viaje-2',
  pasajeroId: 'pasajero-2',
  choferId: 'chofer-2',
  estado: 'en_curso',
  origen: { lat: -26.0, lng: -57.0 },
};

const VIAJE_FINALIZADO = {
  id: 'viaje-finalizado',
  pasajeroId: 'pasajero-1',
  choferId: 'chofer-1',
  estado: 'finalizado',
  origen: { lat: -27.45, lng: -58.98 },
};

const VIAJE_CANCELADO = {
  id: 'viaje-cancelado',
  pasajeroId: 'pasajero-2',
  choferId: 'chofer-2',
  estado: 'cancelado',
  origen: { lat: -26.0, lng: -57.0 },
};

async function montarApp() {
  const choferes = crearRepositorioChoferesMemoria({
    choferes: [
      { id: 'chofer-1', habilitado: true, disponible: true },
      { id: 'chofer-2', habilitado: true, disponible: true },
    ],
  });
  const ubicaciones = crearRepositorioUbicacionesMemoria();
  // Posiciones en vivo, distintas y reconocibles. Aunque existiera una
  // "posicion del pasajero-1", no debe filtrarse por ningun endpoint.
  await ubicaciones.actualizarActual({ choferId: 'chofer-1', lat: -27.5, lng: -58.99, timestamp: 100 });
  await ubicaciones.actualizarActual({ choferId: 'chofer-2', lat: -26.1, lng: -57.1, timestamp: 200 });
  await ubicaciones.actualizarActual({ choferId: 'pasajero-1', lat: -27.9, lng: -58.8, timestamp: 300 });

  const viajes = crearRepositorioViajesMemoria({
    viajes: [VIAJE_1, VIAJE_2, VIAJE_FINALIZADO, VIAJE_CANCELADO],
  });
  const bus = crearBusEventosMemoria();
  const registroMetricas = crearRegistroMetricasMemoria();
  const monitoreo = crearMonitoreoMetricas({ registroMetricas });

  const autenticar = (req, res, next) => {
    const id = req.headers['x-actor-id'];
    if (!id) {
      return res.status(401).json({
        error: { codigo: 'NO_AUTENTICADO', mensaje: 'Falta autenticacion.', idCorrelacion: 'test' },
      });
    }
    req.actor = { id: String(id), rol: String(req.headers['x-actor-rol'] ?? '') };
    next();
  };

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));
  app.use(monitoreo.middleware);
  app.use(
    crearRutasUbicaciones({
      autenticar,
      rateLimitUbicacion: (req, res, next) => next(), // no se prueba el rate limit aca
      repositorioChoferes: choferes,
      repositorioUbicaciones: ubicaciones,
      repositorioViajes: viajes,
      colaHistorial: null,
      busEventos: bus,
      metricas: monitoreo,
    })
  );
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
    entorno: { choferes, ubicaciones, viajes, bus },
    cerrar: async () => {
      monitoreo.detener();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function headers({ id, rol }) {
  return { 'x-actor-id': id, 'x-actor-rol': rol };
}

function textoError(cuerpo) {
  return JSON.stringify(cuerpo?.error ?? {});
}

// --- GET /viajes/:id/estado ---

test('seguimiento HTTP: el pasajero recibe la posicion de SU chofer y nada del otro viaje', async () => {
  const app = await montarApp();
  try {
    const res = await fetch(`${app.baseUrl}/viajes/viaje-1/estado`, {
      headers: headers({ id: 'pasajero-1', rol: 'pasajero' }),
    });
    assert.equal(res.status, 200);
    const cuerpo = await res.json();
    assert.equal(cuerpo.rol, 'pasajero');
    assert.deepEqual(cuerpo.posicionContraparte, { lat: -27.5, lng: -58.99, timestamp: 100 });
    // No aparece la posicion del chofer-2 ni una "posicion del pasajero".
    assert.equal(JSON.stringify(cuerpo).includes('-26.1'), false);
    assert.equal(JSON.stringify(cuerpo).includes('-27.9'), false);
  } finally {
    await app.cerrar();
  }
});

test('seguimiento HTTP: el chofer recibe solo el origen de SU pasajero', async () => {
  const app = await montarApp();
  try {
    const res = await fetch(`${app.baseUrl}/viajes/viaje-1/estado`, {
      headers: headers({ id: 'chofer-1', rol: 'chofer' }),
    });
    assert.equal(res.status, 200);
    const cuerpo = await res.json();
    assert.equal(cuerpo.rol, 'chofer');
    assert.deepEqual(cuerpo.posicionContraparte, { lat: -27.45, lng: -58.98, timestamp: null });
    assert.equal(JSON.stringify(cuerpo).includes('-26'), false);
    assert.equal(JSON.stringify(cuerpo).includes('-58.99'), false);
  } finally {
    await app.cerrar();
  }
});

test('seguimiento HTTP: un chofer de OTRO viaje no ve al pasajero ajeno (403, sin datos)', async () => {
  const app = await montarApp();
  try {
    const res = await fetch(`${app.baseUrl}/viajes/viaje-1/estado`, {
      headers: headers({ id: 'chofer-2', rol: 'chofer' }),
    });
    assert.equal(res.status, 403);
    const cuerpo = await res.json();
    assert.equal(cuerpo.error.codigo, 'RECURSO_AJENO');
    const texto = textoError(cuerpo);
    for (const datoSensible of ['-27.45', '-58.98', '-27.5', '-58.99', 'pasajero-1']) {
      assert.equal(texto.includes(datoSensible), false, `no debe filtrar '${datoSensible}'`);
    }
  } finally {
    await app.cerrar();
  }
});

test('seguimiento HTTP: un pasajero ajeno y un operador no reciben nada (403)', async () => {
  const app = await montarApp();
  try {
    for (const actor of [
      { id: 'pasajero-2', rol: 'pasajero' },
      { id: 'operador-1', rol: 'operador' },
      { id: 'admin-1', rol: 'administrador' },
    ]) {
      const res = await fetch(`${app.baseUrl}/viajes/viaje-1/estado`, { headers: headers(actor) });
      assert.equal(res.status, 403, `actor ${actor.id}`);
      assert.equal((await res.json()).error.codigo, 'RECURSO_AJENO');
    }
  } finally {
    await app.cerrar();
  }
});

test('seguimiento HTTP: viaje inexistente -> 404 generico, sin repetir el id pedido', async () => {
  const app = await montarApp();
  try {
    const res = await fetch(`${app.baseUrl}/viajes/viaje-fantasma-123/estado`, {
      headers: headers({ id: 'pasajero-1', rol: 'pasajero' }),
    });
    assert.equal(res.status, 404);
    const cuerpo = await res.json();
    assert.equal(cuerpo.error.codigo, 'NO_ENCONTRADO');
    assert.equal(textoError(cuerpo).includes('viaje-fantasma-123'), false);
  } finally {
    await app.cerrar();
  }
});

test('hallazgo documentado: hoy el status distingue viaje ajeno (403) de inexistente (404)', async () => {
  // El CUERPO no filtra datos, pero el CODIGO permite inferir existencia.
  // Propuesta (pendiente de OK): mapear RECURSO_AJENO a 404 en este modulo,
  // como ya hace reasignacion.js, para que ambos casos sean indistinguibles.
  // Este test documenta la regla VIGENTE; si se aprueba el cambio, se invierte.
  const app = await montarApp();
  try {
    const ajeno = await fetch(`${app.baseUrl}/viajes/viaje-1/estado`, {
      headers: headers({ id: 'pasajero-2', rol: 'pasajero' }),
    });
    const inexistente = await fetch(`${app.baseUrl}/viajes/viaje-fantasma-123/estado`, {
      headers: headers({ id: 'pasajero-2', rol: 'pasajero' }),
    });
    assert.equal(ajeno.status, 403);
    assert.equal(inexistente.status, 404);
  } finally {
    await app.cerrar();
  }
});

// --- viaje terminado: regla VIGENTE, documentada a proposito ---

test('regla vigente por HTTP: viaje finalizado o cancelado SIGUE visible para sus participantes', async () => {
  const app = await montarApp();
  try {
    for (const [id, pasajero] of [
      ['viaje-finalizado', 'pasajero-1'],
      ['viaje-cancelado', 'pasajero-2'],
    ]) {
      const res = await fetch(`${app.baseUrl}/viajes/${id}/estado`, {
        headers: headers({ id: pasajero, rol: 'pasajero' }),
      });
      assert.equal(res.status, 200, `${id}: hoy el dominio no mira el estado`);
      const cuerpo = await res.json();
      assert.ok(cuerpo.posicionContraparte, 'la posicion de la contraparte sigue expuesta');

      // Un tercero sigue rechazado.
      const ajeno = await fetch(`${app.baseUrl}/viajes/${id}/estado`, {
        headers: headers({ id: 'pasajero-99', rol: 'pasajero' }),
      });
      assert.equal(ajeno.status, 403);
    }
  } finally {
    await app.cerrar();
  }
});

// --- SSE: canales separados por viaje ---

function abrirStream(baseUrl, viajeId, actor) {
  return fetch(`${baseUrl}/viajes/${viajeId}/seguimiento`, { headers: headers(actor) });
}

// Lee del stream hasta que `predicado(texto)` se cumpla o venza el tiempo.
// Devuelve {texto, alcanzado}. Limpia el timer para no dejar el proceso vivo.
async function leerHasta(reader, predicado, timeoutMs = 2000) {
  const decoder = new TextDecoder();
  let texto = '';
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    const restante = Math.max(1, limite - Date.now());
    let timer;
    const vencimiento = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ vence: true }), restante);
    });
    let resultado;
    try {
      resultado = await Promise.race([reader.read(), vencimiento]);
    } finally {
      clearTimeout(timer);
    }
    if (resultado.vence || resultado.done) break;
    texto += decoder.decode(resultado.value, { stream: true });
    if (predicado(texto)) return { texto, alcanzado: true };
  }
  return { texto, alcanzado: false };
}

test('SSE: dos viajes distintos no se cruzan (solo recibe el dueno del canal)', async () => {
  const app = await montarApp();
  const res1 = await abrirStream(app.baseUrl, 'viaje-1', { id: 'pasajero-1', rol: 'pasajero' });
  const res2 = await abrirStream(app.baseUrl, 'viaje-2', { id: 'pasajero-2', rol: 'pasajero' });
  assert.equal(res1.status, 200);
  assert.equal(res2.status, 200);
  assert.equal(res1.headers.get('content-type'), 'text/event-stream');
  assert.equal(res2.headers.get('content-type'), 'text/event-stream');

  const r1 = res1.body.getReader();
  const r2 = res2.body.getReader();
  try {
    const snap1 = await leerHasta(r1, (t) => t.includes('event: snapshot'));
    const snap2 = await leerHasta(r2, (t) => t.includes('event: snapshot'));
    assert.ok(snap1.alcanzado, 'viaje-1 recibe su snapshot');
    assert.ok(snap2.alcanzado, 'viaje-2 recibe su snapshot');

    // Cada snapshot trae la contraparte de SU viaje, no la del otro.
    assert.ok(snap1.texto.includes('"lat":-27.5'));
    assert.equal(snap1.texto.includes('"lat":-26.1'), false);
    assert.ok(snap2.texto.includes('"lat":-26.1'));
    assert.equal(snap2.texto.includes('"lat":-27.5'), false);

    // Se publica una posicion SOLO en el canal del viaje-1.
    await app.entorno.bus.publicar('seguimiento:viaje:viaje-1', {
      tipo: 'posicion',
      datos: { choferId: 'chofer-1', lat: 11, lng: 11 },
    });

    const evento1 = await leerHasta(r1, (t) => t.includes('event: posicion'));
    assert.ok(evento1.alcanzado, 'el pasajero-1 recibe la posicion del chofer-1');
    assert.ok(evento1.texto.includes('"lat":11'));

    // El stream del viaje-2 no debe recibir NADA de ese evento.
    const evento2 = await leerHasta(r2, () => false, 400);
    assert.equal(evento2.texto.includes('event: posicion'), false);
    assert.equal(evento2.texto.includes('"lat":11'), false);
  } finally {
    await r1.cancel().catch(() => {});
    await r2.cancel().catch(() => {});
    await app.cerrar();
  }
});

test('SSE: el chofer suscripto a su viaje recibe el origen de SU pasajero', async () => {
  const app = await montarApp();
  const res = await abrirStream(app.baseUrl, 'viaje-1', { id: 'chofer-1', rol: 'chofer' });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  try {
    const snap = await leerHasta(reader, (t) => t.includes('event: snapshot'));
    assert.ok(snap.alcanzado);
    assert.ok(snap.texto.includes('"rol":"chofer"'));
    assert.ok(snap.texto.includes('"lat":-27.45'));
    assert.equal(snap.texto.includes('"lat":-26'), false);
    assert.equal(snap.texto.includes('"lat":-27.9'), false);
  } finally {
    await reader.cancel().catch(() => {});
    await app.cerrar();
  }
});

test('SSE: un actor ajeno no abre el stream (403, sin content-type de evento)', async () => {
  const app = await montarApp();
  try {
    for (const actor of [
      { id: 'chofer-2', rol: 'chofer' },
      { id: 'pasajero-2', rol: 'pasajero' },
    ]) {
      const res = await abrirStream(app.baseUrl, 'viaje-1', actor);
      assert.equal(res.status, 403);
      assert.equal(res.headers.get('content-type')?.includes('text/event-stream'), false);
      assert.equal((await res.json()).error.codigo, 'RECURSO_AJENO');
    }
  } finally {
    await app.cerrar();
  }
});
