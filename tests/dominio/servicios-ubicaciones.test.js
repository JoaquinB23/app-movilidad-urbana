// Tests de los casos de uso del modulo de ubicaciones (dominio, sin express ni DB).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  autorizarSeguimiento,
  autorizarRecorrido,
  cambiarDisponibilidadChofer,
  registrarUbicacionChofer,
  construirSeguimiento,
} from '../../src/dominio/ubicaciones/servicios.js';
import {
  ErrorRecursoAjeno,
  ErrorNoEncontrado,
  ErrorChoferNoDisponible,
} from '../../src/dominio/ubicaciones/errores.js';
import { crearRepositorioChoferesMemoria } from '../../src/infra/memoria/repositorio-choferes-memoria.js';
import { crearRepositorioUbicacionesMemoria } from '../../src/infra/memoria/repositorio-ubicaciones-memoria.js';
import { crearRepositorioViajesMemoria } from '../../src/infra/memoria/repositorio-viajes-memoria.js';
import { crearColaHistorial } from '../../src/infra/memoria/cola-historial-memoria.js';
import { crearBusEventosMemoria } from '../../src/infra/memoria/bus-eventos-memoria.js';

const ESTADO_BASE = {
  estado: 'en_curso',
  pasajeroId: 'pasajero-1',
  choferId: 'chofer-1',
};

function crearEntorno() {
  const choferes = crearRepositorioChoferesMemoria({
    choferes: [
      { id: 'chofer-1', habilitado: true, disponible: true },
      { id: 'chofer-2', habilitado: true, disponible: false },
      { id: 'chofer-inhabilitado', habilitado: false, disponible: false },
    ],
  });
  const ubicaciones = crearRepositorioUbicacionesMemoria();
  const viajes = crearRepositorioViajesMemoria({
    viajes: [{ id: 'viaje-1', ...ESTADO_BASE }],
  });
  const cola = crearColaHistorial({ escribirLote: (lote) => ubicaciones.agregarHistorialEnLote(lote) });
  const bus = crearBusEventosMemoria();
  return { choferes, ubicaciones, viajes, cola, bus };
}

// --- seguimiento: autorizacion por recurso ---

test('el pasajero del viaje ve al chofer como contraparte', () => {
  const r = autorizarSeguimiento({ viaje: { id: 'v', pasajeroId: 'p', choferId: 'c' }, actor: { id: 'p' } });
  assert.equal(r.rol, 'pasajero');
  assert.equal(r.aQuienVe, 'chofer');
  assert.equal(r.contraparteId, 'c');
});

test('el chofer asignado ve al pasajero como contraparte', () => {
  const r = autorizarSeguimiento({ viaje: { id: 'v', pasajeroId: 'p', choferId: 'c' }, actor: { id: 'c' } });
  assert.equal(r.rol, 'chofer');
  assert.equal(r.aQuienVe, 'pasajero');
  assert.equal(r.contraparteId, 'p');
});

test('un chofer ajeno -> RECURSO_AJENO (el test que se mira primero)', () => {
  const viaje = { id: 'v', pasajeroId: 'p', choferId: 'c1' };
  assert.throws(() => autorizarSeguimiento({ viaje, actor: { id: 'c2' } }), ErrorRecursoAjeno);
});

test('un pasajero que no es del viaje -> RECURSO_AJENO', () => {
  const viaje = { id: 'v', pasajeroId: 'p1', choferId: 'c' };
  assert.throws(() => autorizarSeguimiento({ viaje, actor: { id: 'p2' } }), ErrorRecursoAjeno);
});

test('un operador sin viaje asignado -> RECURSO_AJENO aunque tenga rol', () => {
  const viaje = { id: 'v', pasajeroId: 'p', choferId: 'c' };
  assert.throws(
    () => autorizarSeguimiento({ viaje, actor: { id: 'operador', rol: 'operador' } }),
    ErrorRecursoAjeno
  );
});

test('un viaje inexistente -> NO_ENCONTRADO', () => {
  assert.throws(() => autorizarSeguimiento({ viaje: null, actor: { id: 'p' } }), ErrorNoEncontrado);
  assert.throws(() => autorizarRecorrido({ viaje: null, actor: { id: 'p' } }), ErrorNoEncontrado);
});

// --- disponibilidad ---

test('un chofer habilitado puede cambiar su disponibilidad', async () => {
  const { choferes } = crearEntorno();
  const r = await cambiarDisponibilidadChofer({ repositorioChoferes: choferes, choferId: 'chofer-1', disponible: false });
  assert.equal(r.disponible, false);
  const chofer = await choferes.buscarPorId('chofer-1');
  assert.equal(chofer.disponible, false);
});

test('un chofer inexistente no puede cambiar disponibilidad (NO_ENCONTRADO)', async () => {
  const { choferes } = crearEntorno();
  await assert.rejects(
    () => cambiarDisponibilidadChofer({ repositorioChoferes: choferes, choferId: 'fantasma', disponible: true }),
    ErrorNoEncontrado
  );
});

test('un chofer inhabilitado no puede declararse disponible (NO_ENCONTRADO)', async () => {
  const { choferes } = crearEntorno();
  await assert.rejects(
    () => cambiarDisponibilidadChofer({ repositorioChoferes: choferes, choferId: 'chofer-inhabilitado', disponible: true }),
    ErrorNoEncontrado
  );
});

// --- registro de ubicacion ---

test('un chofer disponible registra ubicacion: actualiza actual y encola historial', async () => {
  const { choferes, ubicaciones, viajes, cola, bus } = crearEntorno();
  const r = await registrarUbicacionChofer({
    repositorioChoferes: choferes,
    repositorioUbicaciones: ubicaciones,
    colaHistorial: cola,
    repositorioViajes: viajes,
    busEventos: bus,
    choferId: 'chofer-1',
    lat: -27.5,
    lng: -58.99,
    timestamp: 1700000000000,
  });

  assert.equal(r.viajeId, 'viaje-1'); // tenia viaje activo
  const actual = await ubicaciones.obtenerActual('chofer-1');
  assert.equal(actual.lat, -27.5);

  await cola.drenar();
  assert.equal(ubicaciones._tamanoHistorial(), 1);
  const recorrido = await ubicaciones.historialDeViaje('viaje-1');
  assert.equal(recorrido.length, 1);
  assert.equal(recorrido[0].choferId, 'chofer-1');
});

test('un chofer NO disponible -> CHOFER_NO_DISPONIBLE y nada se persiste', async () => {
  const { choferes, ubicaciones, cola } = crearEntorno();
  await assert.rejects(
    () =>
      registrarUbicacionChofer({
        repositorioChoferes: choferes,
        repositorioUbicaciones: ubicaciones,
        colaHistorial: cola,
        choferId: 'chofer-2',
        lat: 0,
        lng: 0,
        timestamp: 1,
      }),
    ErrorChoferNoDisponible
  );
  await cola.drenar();
  assert.equal(ubicaciones._tamanoHistorial(), 0);
});

test('un chofer inexistente reportando ubicacion -> CHOFER_NO_DISPONIBLE', async () => {
  const { choferes, ubicaciones, cola } = crearEntorno();
  await assert.rejects(
    () =>
      registrarUbicacionChofer({
        repositorioChoferes: choferes,
        repositorioUbicaciones: ubicaciones,
        colaHistorial: cola,
        choferId: 'fantasma',
        lat: 0,
        lng: 0,
        timestamp: 1,
      }),
    ErrorChoferNoDisponible
  );
});

test('la ubicacion duplicada (misma clave natural) se descarta del historial', async () => {
  const { choferes, ubicaciones, cola } = crearEntorno();
  const args = {
    repositorioChoferes: choferes,
    repositorioUbicaciones: ubicaciones,
    colaHistorial: cola,
    choferId: 'chofer-1',
    lat: 0,
    lng: 0,
  };
  await registrarUbicacionChofer({ ...args, timestamp: 1234 });
  await registrarUbicacionChofer({ ...args, timestamp: 1234 }); // reintento
  await cola.drenar();
  assert.equal(ubicaciones._tamanoHistorial(), 1, 'el reintento no duplica el historial');
});

test('construirSeguimiento: el pasajero recibe la posicion del chofer', async () => {
  const { choferes, ubicaciones, viajes, cola } = crearEntorno();
  await registrarUbicacionChofer({
    repositorioChoferes: choferes,
    repositorioUbicaciones: ubicaciones,
    colaHistorial: cola,
    repositorioViajes: viajes,
    choferId: 'chofer-1',
    lat: -27.5,
    lng: -58.99,
    timestamp: 1700000000000,
  });
  const viaje = await viajes.buscarPorId('viaje-1');
  const sn = await construirSeguimiento({ viaje, actor: { id: 'pasajero-1' }, repositorioUbicaciones: ubicaciones });
  assert.equal(sn.rol, 'pasajero');
  assert.equal(sn.estado, 'en_curso');
  assert.equal(sn.posicionContraparte.lat, -27.5);
});

test('la ubicacion publica al SSE del viaje activo', async () => {
  const { choferes, ubicaciones, viajes, cola, bus } = crearEntorno();
  const recibidos = [];
  bus.suscribir('seguimiento:viaje:viaje-1', (e) => recibidos.push(e));

  await registrarUbicacionChofer({
    repositorioChoferes: choferes,
    repositorioUbicaciones: ubicaciones,
    colaHistorial: cola,
    repositorioViajes: viajes,
    busEventos: bus,
    choferId: 'chofer-1',
    lat: 1,
    lng: 2,
    timestamp: 1,
  });

  assert.equal(recibidos.length, 1);
  assert.equal(recibidos[0].tipo, 'posicion');
  assert.equal(recibidos[0].datos.choferId, 'chofer-1');
});