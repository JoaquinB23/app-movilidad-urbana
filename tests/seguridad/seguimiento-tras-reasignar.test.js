// Privacidad del seguimiento SSE tras una REASIGNACION (variante H, P1).
//
// Problema: el SSE autorizaba solo al conectarse y despues reenviaba todo lo
// del canal del viaje. Si el viaje se reasignaba, el chofer ANTERIOR seguia
// conectado y empezaba a recibir las posiciones del chofer NUEVO.
//
// Reglas que se verifican:
//   * reasignarViaje publica `reasignado` solo DESPUES de confirmar.
//   * Al recibir `reasignado`, el SSE revalida: quien ya no participa recibe
//     `acceso_revocado` y se le cierra el stream; el pasajero sigue.
//   * `posicion` (posicion de un chofer) solo le llega al pasajero, en vivo y
//     al reenviar pendientes por Last-Event-ID.
//   * El chofer anterior no puede volver a conectarse.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import express from 'express';

import { crearRutasUbicaciones, MAPEO_HTTP } from '../../src/infra/http/rutas/ubicaciones.js';
import { crearMonitoreoMetricas } from '../../src/infra/http/metricas.js';
import { crearRepositorioChoferesMemoria } from '../../src/infra/memoria/repositorio-choferes-memoria.js';
import { crearRepositorioUbicacionesMemoria } from '../../src/infra/memoria/repositorio-ubicaciones-memoria.js';
import { crearRepositorioViajesMemoria } from '../../src/infra/memoria/repositorio-viajes-memoria.js';
import { crearColaHistorial } from '../../src/infra/memoria/cola-historial-memoria.js';
import { crearBusEventosMemoria } from '../../src/infra/memoria/bus-eventos-memoria.js';
import { crearRegistroMetricasMemoria } from '../../src/infra/memoria/registro-metricas-memoria.js';
import { debeRecibirEvento } from '../../src/dominio/ubicaciones/servicios.js';
import { crearReasignarViaje } from '../../src/dominio/reasignacion/reasignar-viaje.js';

const VIAJE_ID = 'viaje-h';
const CANAL = `seguimiento:viaje:${VIAJE_ID}`;

// --- Dominio ------------------------------------------------------------

test('debeRecibirEvento: las posiciones de chofer son solo para el pasajero', () => {
  const posicion = { tipo: 'posicion', datos: { choferId: 'c2', lat: 1, lng: 1 } };
  assert.equal(debeRecibirEvento({ autorizado: { rol: 'pasajero' }, evento: posicion }), true);
  assert.equal(debeRecibirEvento({ autorizado: { rol: 'chofer' }, evento: posicion }), false);
  const estado = { tipo: 'estado', datos: { viajeId: VIAJE_ID, estado: 'asignado' } };
  assert.equal(debeRecibirEvento({ autorizado: { rol: 'chofer' }, evento: estado }), true);
});

function transaccionFalsa(resultado) {
  return { ejecutar: async () => { if (resultado instanceof Error) throw resultado; return resultado; } };
}
const puertosBase = { reloj: { ahora: () => new Date() }, generadorId: { nuevo: () => 'id' } };

test('reasignarViaje publica "reasignado" despues de confirmar, sin ids de choferes', async () => {
  const publicados = [];
  const reasignarViaje = crearReasignarViaje({
    ...puertosBase,
    transaccion: transaccionFalsa({
      viaje: { id: VIAJE_ID, estado: 'asignado' }, choferAnteriorId: 'c1', choferNuevoId: 'c2',
    }),
    busEventos: { publicar: (canal, evento) => publicados.push({ canal, evento }) },
  });
  await reasignarViaje({ viajeId: VIAJE_ID, motivo: 'prueba' });
  assert.deepEqual(publicados, [{
    canal: CANAL,
    evento: { tipo: 'reasignado', datos: { viajeId: VIAJE_ID, estado: 'asignado' } },
  }]);
});

test('una reasignacion que falla (rollback) no publica nada', async () => {
  const publicados = [];
  const reasignarViaje = crearReasignarViaje({
    ...puertosBase,
    transaccion: transaccionFalsa(Object.assign(new Error('sin candidatos'), { codigo: 'SIN_CANDIDATOS' })),
    busEventos: { publicar: (...args) => publicados.push(args) },
  });
  await assert.rejects(reasignarViaje({ viajeId: VIAJE_ID, motivo: 'prueba' }));
  assert.equal(publicados.length, 0);
});

// --- HTTP / SSE ---------------------------------------------------------

async function montarApp() {
  const choferes = crearRepositorioChoferesMemoria({
    choferes: [
      { id: 'chofer-1', habilitado: true, disponible: true },
      { id: 'chofer-2', habilitado: true, disponible: true },
    ],
  });
  const ubicaciones = crearRepositorioUbicacionesMemoria();
  const viajes = crearRepositorioViajesMemoria({
    viajes: [{ id: VIAJE_ID, pasajeroId: 'pasajero-1', choferId: 'chofer-1', estado: 'chofer_en_camino', origen: { lat: -27.45, lng: -58.98 } }],
  });
  const cola = crearColaHistorial({ escribirLote: (l) => ubicaciones.agregarHistorialEnLote(l) });
  const bus = crearBusEventosMemoria();
  const monitoreo = crearMonitoreoMetricas({ registroMetricas: crearRegistroMetricasMemoria() });

  const autenticar = (req, res, next) => {
    req.actor = { id: String(req.headers['x-actor-id']), rol: String(req.headers['x-actor-rol']) };
    next();
  };
  const app = express();
  app.use(express.json());
  app.use(crearRutasUbicaciones({
    autenticar,
    rateLimitUbicacion: (req, res, next) => next(),
    repositorioChoferes: choferes,
    repositorioUbicaciones: ubicaciones,
    repositorioViajes: viajes,
    colaHistorial: cola,
    busEventos: bus,
    metricas: monitoreo,
  }));
   
  app.use((err, req, res, next) => {
    res.status(MAPEO_HTTP[err.codigo] ?? 500).json({ error: { codigo: err.codigo ?? 'ERROR_INTERNO' } });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    viajes,
    bus,
    cerrar: async () => {
      monitoreo.detener();
      cola.detener();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// Abre el SSE y junta los eventos hasta que el servidor cierra el stream.
async function abrirSse(baseUrl, actor, headersExtra = {}) {
  const controlador = new AbortController();
  const res = await fetch(`${baseUrl}/viajes/${VIAJE_ID}/seguimiento`, {
    headers: { 'x-actor-id': actor.id, 'x-actor-rol': actor.rol, ...headersExtra },
    signal: controlador.signal,
  });
  const eventos = [];
  let terminado = false;
  const fin = (async () => {
    if (res.status !== 200) return;
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
          if (tipo && datos) eventos.push({ tipo, datos: JSON.parse(datos) });
        }
      }
    } catch (error) {
      if (error.name !== 'AbortError') throw error;
    } finally {
      terminado = true;
    }
  })();
  return { status: res.status, eventos, fin, terminado: () => terminado, cerrar: () => controlador.abort() };
}

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pasajero = { id: 'pasajero-1', rol: 'pasajero' };
const choferViejo = { id: 'chofer-1', rol: 'chofer' };
const choferNuevo = { id: 'chofer-2', rol: 'chofer' };

test('tras reasignar: el chofer anterior recibe acceso_revocado, se le cierra el stream y no ve al nuevo', async () => {
  const app = await montarApp();
  const sseViejo = await abrirSse(app.baseUrl, choferViejo);
  const ssePasajero = await abrirSse(app.baseUrl, pasajero);
  try {
    assert.equal(sseViejo.status, 200);
    await esperar(50);

    // El chofer anterior reporta: el pasajero lo ve, el propio chofer no.
    app.bus.publicar(CANAL, { tipo: 'posicion', datos: { choferId: 'chofer-1', lat: -27.45, lng: -58.98 } });

    // Reasignacion confirmada en la base -> el caso de uso publica.
    app.viajes._sembrar({ id: VIAJE_ID, pasajeroId: 'pasajero-1', choferId: 'chofer-2', estado: 'asignado', origen: { lat: -27.45, lng: -58.98 } });
    app.bus.publicar(CANAL, { tipo: 'reasignado', datos: { viajeId: VIAJE_ID, estado: 'asignado' } });
    // Posicion del chofer NUEVO inmediatamente despues.
    app.bus.publicar(CANAL, { tipo: 'posicion', datos: { choferId: 'chofer-2', lat: -27.46, lng: -58.99 } });

    await Promise.race([sseViejo.fin, esperar(2000)]);
    assert.ok(sseViejo.terminado(), 'el servidor tiene que cerrar el stream del chofer anterior');

    const tiposViejo = sseViejo.eventos.map((e) => e.tipo);
    assert.deepEqual(tiposViejo, ['snapshot', 'acceso_revocado']);
    assert.ok(!JSON.stringify(sseViejo.eventos).includes('chofer-2'), 'no se filtra nada del chofer nuevo');

    await esperar(50);
    const tiposPasajero = ssePasajero.eventos.map((e) => e.tipo);
    assert.deepEqual(tiposPasajero, ['snapshot', 'posicion', 'reasignado', 'posicion']);
    assert.equal(ssePasajero.eventos.at(-1).datos.choferId, 'chofer-2');
  } finally {
    sseViejo.cerrar();
    ssePasajero.cerrar();
    await app.cerrar();
  }
});

test('el chofer anterior no puede volver a conectarse (403), el nuevo si', async () => {
  const app = await montarApp();
  try {
    app.viajes._sembrar({ id: VIAJE_ID, pasajeroId: 'pasajero-1', choferId: 'chofer-2', estado: 'asignado', origen: { lat: -27.45, lng: -58.98 } });
    const viejo = await abrirSse(app.baseUrl, choferViejo);
    assert.equal(viejo.status, 403);
    const nuevo = await abrirSse(app.baseUrl, choferNuevo);
    assert.equal(nuevo.status, 200);
    nuevo.cerrar();
  } finally {
    await app.cerrar();
  }
});

test('Last-Event-ID: al reconectarse el chofer tampoco recibe posiciones pendientes', async () => {
  const app = await montarApp();
  try {
    app.bus.publicar(CANAL, { tipo: 'estado', datos: { viajeId: VIAJE_ID, estado: 'asignado' } });
    app.bus.publicar(CANAL, { tipo: 'posicion', datos: { choferId: 'chofer-1', lat: -27.45, lng: -58.98 } });
    const sse = await abrirSse(app.baseUrl, choferViejo, { 'last-event-id': '0' });
    await esperar(100);
    sse.cerrar();
    assert.deepEqual(sse.eventos.map((e) => e.tipo), ['snapshot', 'estado']);
  } finally {
    await app.cerrar();
  }
});

test('un reasignado que no cambia al pasajero no le corta el stream', async () => {
  const app = await montarApp();
  const sse = await abrirSse(app.baseUrl, pasajero);
  try {
    await esperar(50);
    app.viajes._sembrar({ id: VIAJE_ID, pasajeroId: 'pasajero-1', choferId: 'chofer-2', estado: 'asignado', origen: { lat: -27.45, lng: -58.98 } });
    app.bus.publicar(CANAL, { tipo: 'reasignado', datos: { viajeId: VIAJE_ID, estado: 'asignado' } });
    await esperar(100);
    assert.equal(sse.terminado(), false);
    assert.deepEqual(sse.eventos.map((e) => e.tipo), ['snapshot', 'reasignado']);
  } finally {
    sse.cerrar();
    await app.cerrar();
  }
});
