import test from 'node:test';
import assert from 'node:assert/strict';

import {
  crearEstimadorRutaEnMemoria,
  crearGeneradorIdEnMemoria,
  crearParametrosViajesEnMemoria,
  crearRelojEnMemoria,
  crearRepositorioAsignacionesEnMemoria,
  crearRepositorioOfertasEnMemoria,
  crearRepositorioViajesEnMemoria,
  crearServicioGeoEnMemoria,
  crearTransaccionEnMemoria,
} from '../../src/infra/memoria/index.js';
import { crearEstimarViaje } from '../../src/dominio/viajes/casos-de-uso/estimar-viaje.js';
import { crearObtenerViaje } from '../../src/dominio/viajes/casos-de-uso/obtener-viaje.js';
import { crearSolicitarViaje } from '../../src/dominio/viajes/casos-de-uso/solicitar-viaje.js';
import { ErrorDatosInvalidos, ErrorViajeNoEncontrado } from '../../src/dominio/viajes/errores.js';

const PARAMETROS = {
  tarifa: {
    tarifaBaseCentavos: 50000,
    porKmCentavos: 20000,
    porMinutoCentavos: 3000,
    tarifaMinimaCentavos: 80000,
    distanciaMaximaMetros: 50000,
  },
  tiempoOfertaSegundos: 30,
  radioBusquedaMetros: 5000,
  maxCandidatos: 5,
};
const ORIGEN = { lat: -27.45, lng: -58.98 };
const DESTINO = { lat: -27.46, lng: -58.97 };
const FECHA = new Date('2026-10-09T12:00:00.000Z');

function crearDependencias({ sinCandidatos = false } = {}) {
  const repositorioViajes = crearRepositorioViajesEnMemoria();
  const repositorioOfertas = crearRepositorioOfertasEnMemoria();
  const repositorioAsignaciones = crearRepositorioAsignacionesEnMemoria({
    reloj: crearRelojEnMemoria(FECHA),
  });
  const reloj = crearRelojEnMemoria(FECHA);
  const parametrosViajes = crearParametrosViajesEnMemoria(PARAMETROS);
  const servicioGeo = crearServicioGeoEnMemoria();
  if (!sinCandidatos) {
    servicioGeo.cargarUbicacion('chofer-cercano', ORIGEN);
    servicioGeo.cargarUbicacion('chofer-lejano', { lat: -27.47, lng: -58.99 });
  }
  const estimadorRuta = crearEstimadorRutaEnMemoria({ velocidadPromedioKmH: 30 });
  const transaccion = crearTransaccionEnMemoria();
  const generadorId = crearGeneradorIdEnMemoria();
  const estimarViaje = crearEstimarViaje({ estimadorRuta, parametrosViajes });
  const solicitarViaje = crearSolicitarViaje({
    repositorioViajes,
    repositorioOfertas,
    transaccion,
    reloj,
    generadorId,
    estimadorRuta,
    parametrosViajes,
    servicioGeo,
  });
  return {
    repositorioViajes,
    repositorioOfertas,
    repositorioAsignaciones,
    reloj,
    estimarViaje,
    solicitarViaje,
    obtenerViaje: crearObtenerViaje({ repositorioViajes, repositorioAsignaciones }),
  };
}

test('estimarViaje y solicitarViaje aplican la misma tarifa al trayecto', async () => {
  const deps = crearDependencias();
  const estimacion = await deps.estimarViaje({ origen: ORIGEN, destino: DESTINO });
  const { viaje } = await deps.solicitarViaje({
    pasajero: { id: 'pasajero-1', rol: 'pasajero' },
    origen: ORIGEN,
    destino: DESTINO,
  });

  assert.equal(viaje.tarifaEstimadaCentavos, estimacion.precioCentavos);
  assert.equal(viaje.distanciaEstimadaMetros, estimacion.distanciaMetros);
  assert.equal(viaje.duracionEstimadaSegundos, estimacion.duracionSegundos);
});

test('solicitarViaje crea oferta para el candidato más cercano con vencimiento del reloj', async () => {
  const deps = crearDependencias();
  const { viaje, oferta } = await deps.solicitarViaje({
    pasajero: { id: 'pasajero-1', rol: 'pasajero' },
    origen: ORIGEN,
    destino: DESTINO,
  });

  assert.equal(viaje.estado, 'solicitado');
  assert.equal(oferta.choferId, 'chofer-cercano');
  assert.equal(oferta.expiraEn.getTime(), FECHA.getTime() + 30_000);
  assert.equal(deps.repositorioOfertas.estado.ofertas.size, 1);
});

test('sin candidatos agota la búsqueda y registra el evento de transición', async () => {
  const deps = crearDependencias({ sinCandidatos: true });
  const { viaje, oferta } = await deps.solicitarViaje({
    pasajero: { id: 'pasajero-1', rol: 'pasajero' },
    origen: ORIGEN,
    destino: DESTINO,
  });

  assert.equal(viaje.estado, 'sin_choferes');
  assert.equal(oferta, null);
  assert.equal(deps.repositorioViajes.estado.eventos.at(-1).evento, 'agotar_candidatos');
});

test('datos inválidos de solicitud y estimación se rechazan', async () => {
  const deps = crearDependencias();
  await assert.rejects(
    deps.solicitarViaje({
      pasajero: { id: 'pasajero-1', rol: 'pasajero' },
      origen: { lat: 91, lng: 0 },
      destino: DESTINO,
    }),
    (error) => error instanceof ErrorDatosInvalidos && error.codigo === 'DATOS_INVALIDOS'
  );
  await assert.rejects(
    deps.solicitarViaje({ pasajero: null, origen: ORIGEN, destino: DESTINO }),
    ErrorDatosInvalidos
  );
  await assert.rejects(
    deps.estimarViaje({ origen: ORIGEN, destino: { lat: 0, lng: 181 } }),
    ErrorDatosInvalidos
  );
  assert.equal(deps.repositorioViajes.estado.viajes.size, 0);
});

test('obtenerViaje autoriza al pasajero dueño y al chofer asignado', async () => {
  const deps = crearDependencias();
  const { viaje } = await deps.solicitarViaje({
    pasajero: { id: 'pasajero-1', rol: 'pasajero' },
    origen: ORIGEN,
    destino: DESTINO,
  });
  await deps.repositorioAsignaciones.abrir({
    id: 'asignacion-1',
    viajeId: viaje.id,
    choferId: 'chofer-asignado',
    desde: FECHA,
  });

  assert.equal((await deps.obtenerViaje({ actor: { id: 'pasajero-1', rol: 'pasajero' }, viajeId: viaje.id })).id, viaje.id);
  assert.equal((await deps.obtenerViaje({ actor: { id: 'chofer-asignado', rol: 'chofer' }, viajeId: viaje.id })).id, viaje.id);
  assert.equal((await deps.obtenerViaje({ actor: { id: 'operador-1', rol: 'operador' }, viajeId: viaje.id })).id, viaje.id);
  assert.equal((await deps.obtenerViaje({ actor: { id: 'admin-1', rol: 'administrador' }, viajeId: viaje.id })).id, viaje.id);
});

test('obtenerViaje oculta la existencia ante otros pasajeros y choferes', async () => {
  const deps = crearDependencias();
  const { viaje } = await deps.solicitarViaje({
    pasajero: { id: 'pasajero-1', rol: 'pasajero' },
    origen: ORIGEN,
    destino: DESTINO,
  });

  for (const actor of [
    { id: 'pasajero-2', rol: 'pasajero' },
    { id: 'chofer-otro', rol: 'chofer' },
    { id: 'chofer-sin-asignacion', rol: 'chofer' },
  ]) {
    await assert.rejects(
      deps.obtenerViaje({ actor, viajeId: viaje.id }),
      (error) => error instanceof ErrorViajeNoEncontrado && error.codigo === 'VIAJE_NO_ENCONTRADO'
    );
  }
  await assert.rejects(
    deps.obtenerViaje({ actor: { id: 'pasajero-1', rol: 'pasajero' }, viajeId: 'inexistente' }),
    (error) => error instanceof ErrorViajeNoEncontrado && error.codigo === 'VIAJE_NO_ENCONTRADO'
  );
});
