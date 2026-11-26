// Ciclo de vida despues de la asignacion (P1 de Viajes), con adaptadores en
// memoria: transiciones del chofer, tarifa final, cancelaciones (pasajero,
// chofer, operador), cierre de la asignacion, cobro idempotente, historiales
// y panel del operador. Verifican el DATO FINAL en los repositorios.

import test from 'node:test';
import assert from 'node:assert/strict';

import { crearTransicionarViaje } from '../../src/dominio/viajes/casos-de-uso/transicionar-viaje.js';
import { crearRegistrarCobro } from '../../src/dominio/viajes/casos-de-uso/registrar-cobro.js';
import { crearConsultasViajes } from '../../src/dominio/viajes/casos-de-uso/consultar-viajes.js';
import { calcularTarifa } from '../../src/dominio/viajes/tarifa.js';
import {
  crearGeneradorIdEnMemoria,
  crearMedidorRecorridoEnMemoria,
  crearParametrosViajesEnMemoria,
  crearRelojEnMemoria,
  crearRepositorioAsignacionesEnMemoria,
  crearRepositorioChoferesEnMemoria,
  crearRepositorioCobrosEnMemoria,
  crearRepositorioOfertasEnMemoria,
  crearRepositorioViajesEnMemoria,
  crearTransaccionEnMemoria,
} from '../../src/infra/memoria/index.js';

const AHORA = new Date('2026-11-26T12:00:00.000Z');
const TARIFA = {
  tarifaBaseCentavos: 150000,
  porKmCentavos: 80000,
  porMinutoCentavos: 10000,
  tarifaMinimaCentavos: 200000,
  distanciaMaximaMetros: 50000,
};
const PASAJERO = { id: 'pasajero-1', rol: 'pasajero' };
const CHOFER = { id: 'chofer-1', rol: 'chofer' };
const OPERADOR = { id: 'operador-1', rol: 'operador' };

function escenario({ estado = 'asignado', conAsignacion = true, ofertaPendiente = false } = {}) {
  const reloj = crearRelojEnMemoria(AHORA);
  const asignaciones = crearRepositorioAsignacionesEnMemoria({ reloj });
  const repos = {
    viajes: crearRepositorioViajesEnMemoria({ asignaciones }),
    ofertas: crearRepositorioOfertasEnMemoria(),
    choferes: crearRepositorioChoferesEnMemoria([{ id: 'chofer-1', habilitado: true, disponible: true }]),
    asignaciones,
    cobros: crearRepositorioCobrosEnMemoria(),
  };
  repos.viajes.estado.viajes.set('viaje-1', {
    id: 'viaje-1',
    pasajeroId: 'pasajero-1',
    estado,
    origen: { lat: -27.45, lng: -58.98 },
    destino: { lat: -27.46, lng: -58.99 },
    distanciaEstimadaMetros: 1500,
    duracionEstimadaSegundos: 180,
    tarifaEstimadaCentavos: 300000,
    tarifaFinalCentavos: null,
    motivoCierre: null,
    creadoEn: AHORA,
    actualizadoEn: AHORA,
    historial: [],
  });
  if (conAsignacion) {
    asignaciones.estado.asignaciones.set('asig-1', {
      id: 'asig-1', viajeId: 'viaje-1', choferId: 'chofer-1', desde: AHORA, hasta: null, motivoFin: null,
    });
  }
  if (ofertaPendiente) {
    repos.ofertas.estado.ofertas.set('oferta-1', {
      id: 'oferta-1', viajeId: 'viaje-1', choferId: 'chofer-1', estado: 'pendiente', orden: 1,
      expiraEn: new Date(AHORA.getTime() + 30_000), creadaEn: AHORA, respondidaEn: null,
    });
  }
  const transaccion = crearTransaccionEnMemoria(repos);
  const medidor = crearMedidorRecorridoEnMemoria();
  const publicados = [];
  const transicionar = crearTransicionarViaje({
    transaccion,
    reloj,
    parametrosViajes: crearParametrosViajesEnMemoria({ tarifa: TARIFA }),
    medidorRecorrido: medidor,
    busEventos: { publicar: (canal, evento) => publicados.push({ canal, evento }) },
  });
  const cobrar = crearRegistrarCobro({ transaccion, reloj, generadorId: crearGeneradorIdEnMemoria() });
  return { repos, reloj, medidor, publicados, transicionar, cobrar };
}

const viajeEnBase = (e) => e.repos.viajes.estado.viajes.get('viaje-1');
const asignacion = (e) => e.repos.asignaciones.estado.asignaciones.get('asig-1');

// --- Transiciones del chofer y tarifa final ----------------------------

test('el chofer lleva el viaje de asignado a finalizado; la tarifa final usa lo recorrido y la duracion real', async () => {
  const e = escenario();
  await e.transicionar({ actor: CHOFER, viajeId: 'viaje-1', evento: 'salir_en_camino' });
  await e.transicionar({ actor: CHOFER, viajeId: 'viaje-1', evento: 'iniciar' });
  e.reloj.establecer(new Date(AHORA.getTime() + 600_000)); // 10 minutos de viaje
  e.medidor.cargar('viaje-1', 4200); // 4,2 km recorridos (la estimacion decia 1,5 km)
  const fin = await e.transicionar({ actor: CHOFER, viajeId: 'viaje-1', evento: 'finalizar' });

  const esperada = calcularTarifa({ distanciaMetros: 4200, duracionSegundos: 600, parametros: TARIFA }).totalCentavos;
  assert.equal(fin.estado, 'finalizado');
  assert.equal(fin.tarifaFinalCentavos, esperada);
  assert.equal(viajeEnBase(e).tarifaFinalCentavos, esperada);
  // La asignacion se cierra: el chofer queda libre para otro viaje.
  assert.notEqual(asignacion(e).hasta, null);
  assert.equal(asignacion(e).motivoFin, 'finalizar');
  assert.deepEqual(e.publicados.map((p) => p.evento.datos.estado), ['chofer_en_camino', 'en_curso', 'finalizado']);
  assert.deepEqual(e.repos.viajes.estado.eventos.map((ev) => ev.evento), ['salir_en_camino', 'iniciar', 'finalizar']);
});

test('sin recorrido medido, la tarifa final usa la distancia estimada; el exceso sobre el maximo se acota', async () => {
  const e = escenario({ estado: 'en_curso' });
  viajeEnBase(e).historial = [{ evento: 'iniciar', en: AHORA }];
  e.reloj.establecer(new Date(AHORA.getTime() + 60_000));
  const fin = await e.transicionar({ actor: CHOFER, viajeId: 'viaje-1', evento: 'finalizar' });
  assert.equal(fin.tarifaFinalCentavos,
    calcularTarifa({ distanciaMetros: 1500, duracionSegundos: 60, parametros: TARIFA }).totalCentavos);

  const otro = escenario({ estado: 'en_curso' });
  viajeEnBase(otro).historial = [{ evento: 'iniciar', en: AHORA }];
  otro.medidor.cargar('viaje-1', 90_000); // un desvio enorme: no puede romper la tarifa final
  const acotado = await otro.transicionar({ actor: CHOFER, viajeId: 'viaje-1', evento: 'finalizar' });
  assert.equal(acotado.tarifaFinalCentavos,
    calcularTarifa({ distanciaMetros: 50000, duracionSegundos: 0, parametros: TARIFA }).totalCentavos);
});

test('saltear un estado es transicion invalida y no cambia nada', async () => {
  const e = escenario();
  await assert.rejects(
    e.transicionar({ actor: CHOFER, viajeId: 'viaje-1', evento: 'finalizar' }),
    (err) => err.codigo === 'TRANSICION_INVALIDA'
  );
  assert.equal(viajeEnBase(e).estado, 'asignado');
  assert.equal(asignacion(e).hasta, null);
});

// --- Autorizacion por recurso --------------------------------------------

test('un chofer que no es el asignado, otro pasajero o un rol sin ese evento reciben 404', async () => {
  const e = escenario();
  for (const [actor, evento] of [
    [{ id: 'chofer-2', rol: 'chofer' }, 'salir_en_camino'],
    [{ id: 'pasajero-2', rol: 'pasajero' }, 'cancelar_pasajero'],
    [PASAJERO, 'finalizar'],
    [{ id: 'admin-1', rol: 'administrador' }, 'cancelar_operador'],
  ]) {
    await assert.rejects(
      e.transicionar({ actor, viajeId: 'viaje-1', evento, motivo: 'x' }),
      (err) => err.codigo === 'VIAJE_NO_ENCONTRADO',
      `${actor.id} ${evento}`
    );
  }
  assert.equal(viajeEnBase(e).estado, 'asignado');
});

// --- Cancelaciones ------------------------------------------------------

test('el pasajero cancela un viaje asignado: se cierra la asignacion y el chofer queda libre', async () => {
  const e = escenario();
  const r = await e.transicionar({ actor: PASAJERO, viajeId: 'viaje-1', evento: 'cancelar_pasajero' });
  assert.equal(r.estado, 'cancelado_pasajero');
  assert.equal(asignacion(e).motivoFin, 'cancelar_pasajero');
  assert.equal(await e.repos.asignaciones.buscarAbiertaPorChofer('chofer-1'), null);
});

test('cancelar un viaje solicitado cancela sus ofertas pendientes', async () => {
  const e = escenario({ estado: 'solicitado', conAsignacion: false, ofertaPendiente: true });
  await e.transicionar({ actor: PASAJERO, viajeId: 'viaje-1', evento: 'cancelar_pasajero' });
  assert.equal(e.repos.ofertas.estado.ofertas.get('oferta-1').estado, 'cancelada');
});

test('el chofer cancela; un viaje en curso ya no lo puede cancelar el chofer', async () => {
  const e = escenario();
  assert.equal((await e.transicionar({ actor: CHOFER, viajeId: 'viaje-1', evento: 'cancelar_chofer' })).estado, 'cancelado_chofer');

  const enCurso = escenario({ estado: 'en_curso' });
  await assert.rejects(
    enCurso.transicionar({ actor: CHOFER, viajeId: 'viaje-1', evento: 'cancelar_chofer' }),
    (err) => err.codigo === 'TRANSICION_INVALIDA'
  );
});

test('el operador cancela cualquier viaje no terminal, con motivo obligatorio', async () => {
  const e = escenario({ estado: 'en_curso' });
  await assert.rejects(
    e.transicionar({ actor: OPERADOR, viajeId: 'viaje-1', evento: 'cancelar_operador' }),
    (err) => err.codigo === 'DATOS_INVALIDOS'
  );
  const r = await e.transicionar({ actor: OPERADOR, viajeId: 'viaje-1', evento: 'cancelar_operador', motivo: 'Reclamo de seguridad' });
  assert.equal(r.estado, 'cancelado_pasajero');
  assert.equal(r.motivoCierre, 'Reclamo de seguridad');
  assert.equal(e.repos.viajes.estado.eventos.at(-1).actorTipo, 'operador');
});

// --- Cobro idempotente ----------------------------------------------------

async function viajeFinalizado() {
  const e = escenario({ estado: 'en_curso' });
  viajeEnBase(e).historial = [{ evento: 'iniciar', en: AHORA }];
  e.reloj.establecer(new Date(AHORA.getTime() + 300_000));
  await e.transicionar({ actor: CHOFER, viajeId: 'viaje-1', evento: 'finalizar' });
  return e;
}

test('cobrar un viaje finalizado registra un cobro por la tarifa final', async () => {
  const e = await viajeFinalizado();
  const cobro = await e.cobrar({ actor: PASAJERO, viajeId: 'viaje-1', idempotencia: { clave: 'k1', hash: 'h' } });
  assert.equal(cobro.importeCentavos, viajeEnBase(e).tarifaFinalCentavos);
  assert.equal(cobro.repetido, false);
  assert.equal(e.repos.cobros.estado.cobros.size, 1);
});

test('reintentar con la misma clave devuelve el mismo cobro sin cobrar de nuevo', async () => {
  const e = await viajeFinalizado();
  const primero = await e.cobrar({ actor: PASAJERO, viajeId: 'viaje-1', idempotencia: { clave: 'k1', hash: 'h' } });
  const segundo = await e.cobrar({ actor: PASAJERO, viajeId: 'viaje-1', idempotencia: { clave: 'k1', hash: 'h' } });
  assert.equal(segundo.cobroId, primero.cobroId);
  assert.equal(segundo.repetido, true);
  assert.equal(e.repos.cobros.estado.cobros.size, 1);

  await assert.rejects(
    e.cobrar({ actor: PASAJERO, viajeId: 'viaje-1', idempotencia: { clave: 'k1', hash: 'otro' } }),
    (err) => err.codigo === 'CLAVE_REUTILIZADA'
  );
});

test('otra clave para el mismo viaje es YA_COBRADO; un viaje sin finalizar o ajeno no se cobra', async () => {
  const e = await viajeFinalizado();
  await e.cobrar({ actor: PASAJERO, viajeId: 'viaje-1', idempotencia: { clave: 'k1', hash: 'h' } });
  await assert.rejects(
    e.cobrar({ actor: PASAJERO, viajeId: 'viaje-1', idempotencia: { clave: 'k2', hash: 'h' } }),
    (err) => err.codigo === 'YA_COBRADO'
  );
  assert.equal(e.repos.cobros.estado.cobros.size, 1);

  const sinFinalizar = escenario();
  await assert.rejects(
    sinFinalizar.cobrar({ actor: PASAJERO, viajeId: 'viaje-1', idempotencia: { clave: 'k', hash: 'h' } }),
    (err) => err.codigo === 'VIAJE_NO_FINALIZADO'
  );
  await assert.rejects(
    e.cobrar({ actor: { id: 'pasajero-2', rol: 'pasajero' }, viajeId: 'viaje-1', idempotencia: { clave: 'k9', hash: 'h' } }),
    (err) => err.codigo === 'VIAJE_NO_ENCONTRADO'
  );
});

// --- Historiales y panel del operador ------------------------------------

test('historiales del pasajero y del chofer, panel del operador y eventos del viaje', async () => {
  const e = escenario();
  const consultas = crearConsultasViajes({ repositorioViajes: e.repos.viajes, repositorioAsignaciones: e.repos.asignaciones });
  assert.deepEqual((await consultas.historialPasajero({ actor: PASAJERO })).map((v) => v.id), ['viaje-1']);
  assert.deepEqual((await consultas.historialChofer({ actor: CHOFER })).map((v) => v.id), ['viaje-1']);
  assert.deepEqual((await consultas.viajesEnCurso({ actor: OPERADOR })).map((v) => v.id), ['viaje-1']);
  assert.deepEqual(await consultas.historialChofer({ actor: { id: 'chofer-9', rol: 'chofer' } }), []);

  await e.transicionar({ actor: PASAJERO, viajeId: 'viaje-1', evento: 'cancelar_pasajero' });
  assert.deepEqual(await consultas.viajesEnCurso({ actor: OPERADOR }), [], 'un viaje terminado sale del panel');
  // El chofer de una asignacion ya cerrada sigue viendo el viaje en su historial.
  assert.deepEqual((await consultas.historialChofer({ actor: CHOFER })).map((v) => v.id), ['viaje-1']);

  await assert.rejects(consultas.viajesEnCurso({ actor: PASAJERO }), (err) => err.codigo === 'ACTOR_NO_AUTORIZADO');
  await assert.rejects(
    consultas.eventosDeViaje({ actor: { id: 'pasajero-2', rol: 'pasajero' }, viajeId: 'viaje-1' }),
    (err) => err.codigo === 'VIAJE_NO_ENCONTRADO'
  );
});
