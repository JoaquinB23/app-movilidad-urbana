import test from 'node:test';
import assert from 'node:assert/strict';

import { crearAceptarOferta } from '../../src/dominio/viajes/casos-de-uso/aceptar-oferta.js';
import {
  crearGeneradorIdEnMemoria,
  crearRelojEnMemoria,
  crearRepositorioAsignacionesEnMemoria,
  crearRepositorioChoferesEnMemoria,
  crearRepositorioOfertasEnMemoria,
  crearRepositorioViajesEnMemoria,
  crearTransaccionEnMemoria,
} from '../../src/infra/memoria/index.js';

const AHORA = new Date('2026-10-29T04:00:00.000Z');

function crearEscenario({
  estadoViaje = 'solicitado',
  ofertaExpiraEn = new Date(AHORA.getTime() + 60_000),
  choferHabilitado = true,
  choferDisponible = true,
  asignacionAbierta = false,
} = {}) {
  const repositorios = {
    viajes: crearRepositorioViajesEnMemoria(),
    ofertas: crearRepositorioOfertasEnMemoria(),
    choferes: crearRepositorioChoferesEnMemoria([
      { id: 'chofer-1', habilitado: choferHabilitado, disponible: choferDisponible },
      { id: 'chofer-2', habilitado: true, disponible: true },
      { id: 'chofer-ocupado', habilitado: true, disponible: true },
    ]),
    asignaciones: crearRepositorioAsignacionesEnMemoria({
      reloj: crearRelojEnMemoria(AHORA),
    }),
  };
  const viaje = {
    id: 'viaje-1',
    pasajeroId: 'pasajero-1',
    estado: estadoViaje,
    origen: { lat: -27, lng: -58 },
    destino: { lat: -27.1, lng: -58.1 },
    distanciaEstimadaMetros: 1000,
    duracionEstimadaSegundos: 120,
    tarifaEstimadaCentavos: 1000,
    tarifaFinalCentavos: null,
    motivoCierre: null,
    creadoEn: AHORA,
    actualizadoEn: AHORA,
    historial: [],
  };
  const oferta = {
    id: 'oferta-1',
    viajeId: viaje.id,
    choferId: 'chofer-1',
    estado: 'pendiente',
    orden: 1,
    expiraEn: ofertaExpiraEn,
    creadaEn: AHORA,
    respondidaEn: null,
  };
  repositorios.viajes.estado.viajes.set(viaje.id, viaje);
  repositorios.ofertas.estado.ofertas.set(oferta.id, oferta);
  repositorios.ofertas.estado.ofertas.set('oferta-2', {
    ...oferta,
    id: 'oferta-2',
    choferId: 'chofer-2',
    orden: 2,
  });
  if (asignacionAbierta) {
    repositorios.asignaciones.estado.asignaciones.set('asignacion-existente', {
      id: 'asignacion-existente',
      viajeId: 'otro-viaje',
      choferId: 'chofer-1',
      desde: AHORA,
      hasta: null,
      motivoFin: null,
    });
  }
  const reloj = crearRelojEnMemoria(AHORA);
  const aceptarOferta = crearAceptarOferta({
    transaccion: crearTransaccionEnMemoria(repositorios),
    reloj,
    generadorId: crearGeneradorIdEnMemoria(),
  });
  return { aceptarOferta, repositorios, oferta };
}

function errorConCodigo(codigo) {
  return (error) => error?.codigo === codigo;
}

test('aceptarOferta asigna viaje, acepta oferta, cancela otras y registra evento', async () => {
  const escenario = crearEscenario();
  const resultado = await escenario.aceptarOferta({
    actor: { id: 'chofer-1', rol: 'chofer' },
    ofertaId: 'oferta-1',
  });

  assert.equal(resultado.viaje.estado, 'asignado');
  assert.equal(resultado.viaje.actualizadoEn.getTime(), AHORA.getTime());
  assert.equal(resultado.oferta.estado, 'aceptada');
  assert.equal(escenario.repositorios.ofertas.estado.ofertas.get('oferta-2').estado, 'cancelada');
  assert.equal(resultado.asignacion.choferId, 'chofer-1');
  assert.equal(resultado.asignacion.hasta, null);
  assert.equal(escenario.repositorios.viajes.estado.eventos.length, 1);
  assert.equal(escenario.repositorios.viajes.estado.eventos[0].evento, 'aceptar_oferta');
  assert.equal(escenario.repositorios.choferes.estado.choferes.get('chofer-1').disponible, true);
});

test('rechaza una oferta vencida', async () => {
  const escenario = crearEscenario({ ofertaExpiraEn: new Date(AHORA.getTime() - 1) });
  await assert.rejects(
    escenario.aceptarOferta({ actor: { id: 'chofer-1', rol: 'chofer' }, ofertaId: 'oferta-1' }),
    errorConCodigo('OFERTA_NO_VIGENTE')
  );
});

test('rechaza una oferta cuando el viaje ya no está solicitado', async () => {
  const escenario = crearEscenario({ estadoViaje: 'asignado' });
  await assert.rejects(
    escenario.aceptarOferta({ actor: { id: 'chofer-1', rol: 'chofer' }, ofertaId: 'oferta-1' }),
    errorConCodigo('VIAJE_NO_DISPONIBLE')
  );
});

test('rechaza un chofer con una asignación abierta', async () => {
  const escenario = crearEscenario({ asignacionAbierta: true });
  await assert.rejects(
    escenario.aceptarOferta({ actor: { id: 'chofer-1', rol: 'chofer' }, ofertaId: 'oferta-1' }),
    errorConCodigo('CHOFER_OCUPADO')
  );
});

test('rechaza un chofer no habilitado o no disponible', async (t) => {
  for (const caso of [
    { nombre: 'no habilitado', choferHabilitado: false },
    { nombre: 'no disponible', choferDisponible: false },
  ]) {
    await t.test(caso.nombre, async () => {
      const escenario = crearEscenario(caso);
      await assert.rejects(
        escenario.aceptarOferta({ actor: { id: 'chofer-1', rol: 'chofer' }, ofertaId: 'oferta-1' }),
        errorConCodigo('CHOFER_NO_DISPONIBLE')
      );
    });
  }
});

test('oculta la oferta a un chofer que intenta aceptar la oferta de otro', async () => {
  const escenario = crearEscenario();
  await assert.rejects(
    escenario.aceptarOferta({ actor: { id: 'chofer-2', rol: 'chofer' }, ofertaId: 'oferta-1' }),
    errorConCodigo('OFERTA_NO_ENCONTRADA')
  );
});
