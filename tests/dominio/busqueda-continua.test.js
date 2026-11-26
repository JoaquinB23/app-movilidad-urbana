// Busqueda continua de chofer (parametro tiempo_busqueda_s), con adaptadores
// en memoria. Por defecto esta APAGADA (0): el comportamiento del enunciado
// (sin_choferes en cuanto se agota la lista) no cambia.

import test from 'node:test';
import assert from 'node:assert/strict';

import { crearSolicitarViaje } from '../../src/dominio/viajes/casos-de-uso/solicitar-viaje.js';
import { crearRechazarOferta } from '../../src/dominio/viajes/casos-de-uso/continuar-oferta.js';
import { crearReintentarBusqueda } from '../../src/dominio/viajes/casos-de-uso/reintentar-busqueda.js';
import { crearTransicionarViaje } from '../../src/dominio/viajes/casos-de-uso/transicionar-viaje.js';
import { crearWorkerBusqueda } from '../../src/workers/busqueda-choferes.js';
import {
  crearEstimadorRutaEnMemoria,
  crearGeneradorIdEnMemoria,
  crearMedidorRecorridoEnMemoria,
  crearParametrosViajesEnMemoria,
  crearRelojEnMemoria,
  crearRepositorioAsignacionesEnMemoria,
  crearRepositorioChoferesEnMemoria,
  crearRepositorioOfertasEnMemoria,
  crearRepositorioViajesEnMemoria,
  crearServicioGeoEnMemoria,
  crearTransaccionEnMemoria,
} from '../../src/infra/memoria/index.js';

const AHORA = new Date('2026-11-26T12:00:00.000Z');
const ORIGEN = { lat: -27.4514, lng: -58.9866 };
const DESTINO = { lat: -27.46, lng: -58.99 };
const PASAJERO = { id: 'pasajero-1', rol: 'pasajero' };

function escenario({ tiempoBusquedaSegundos }) {
  const reloj = crearRelojEnMemoria(AHORA);
  const ofertas = crearRepositorioOfertasEnMemoria();
  const asignaciones = crearRepositorioAsignacionesEnMemoria({ reloj });
  const viajes = crearRepositorioViajesEnMemoria({ asignaciones, ofertas });
  const choferes = crearRepositorioChoferesEnMemoria([]);
  const servicioGeo = crearServicioGeoEnMemoria();
  const publicados = [];
  const deps = {
    repositorioViajes: viajes,
    repositorioOfertas: ofertas,
    transaccion: crearTransaccionEnMemoria({ viajes, ofertas, choferes, asignaciones }),
    reloj,
    generadorId: crearGeneradorIdEnMemoria(),
    estimadorRuta: crearEstimadorRutaEnMemoria(),
    servicioGeo,
    busEventos: { publicar: (canal, evento) => publicados.push(evento) },
    parametrosViajes: crearParametrosViajesEnMemoria({
      tarifa: { tarifaBaseCentavos: 100, porKmCentavos: 10, porMinutoCentavos: 5, tarifaMinimaCentavos: 100, distanciaMaximaMetros: 50000 },
      tiempoOfertaSegundos: 30,
      radioBusquedaMetros: 5000,
      maxCandidatos: 5,
      tiempoBusquedaSegundos,
    }),
  };
  const worker = crearWorkerBusqueda({
    transaccion: deps.transaccion,
    reintentarBusqueda: crearReintentarBusqueda(deps),
    parametrosViajes: deps.parametrosViajes,
    logger: { error() {} },
  });
  // Un chofer que se conecta: habilitado, disponible y con posicion cerca.
  function conectarChofer(id) {
    choferes.estado.choferes.set(id, { id, habilitado: true, disponible: true });
    servicioGeo.cargarUbicacion(id, { lat: ORIGEN.lat + 0.001, lng: ORIGEN.lng });
  }
  return {
    deps, reloj, worker, publicados, conectarChofer,
    solicitar: crearSolicitarViaje(deps),
    rechazar: crearRechazarOferta(deps),
    cancelar: crearTransicionarViaje({ ...deps, medidorRecorrido: crearMedidorRecorridoEnMemoria() }),
    viaje: (id) => viajes.estado.viajes.get(id),
    ofertasDe: (id) => [...ofertas.estado.ofertas.values()].filter((o) => o.viajeId === id),
  };
}

test('apagada (por defecto): sin choferes el viaje pasa enseguida a sin_choferes y el worker no hace nada', async () => {
  const e = escenario({ tiempoBusquedaSegundos: 0 });
  const { viaje } = await e.solicitar({ pasajero: PASAJERO, origen: ORIGEN, destino: DESTINO });
  assert.equal(viaje.estado, 'sin_choferes');
  assert.deepEqual(await e.worker.ejecutarCiclo(), { procesados: 0, apagado: true });
});

test('prendida: sin choferes el viaje queda buscando y se ofrece al primer chofer que aparece', async () => {
  const e = escenario({ tiempoBusquedaSegundos: 300 });
  const { viaje } = await e.solicitar({ pasajero: PASAJERO, origen: ORIGEN, destino: DESTINO });
  assert.equal(viaje.estado, 'solicitado');
  assert.equal(e.ofertasDe(viaje.id).length, 0);

  // Nadie disponible todavia: el ciclo no cambia nada.
  await e.worker.ejecutarCiclo();
  assert.equal(e.viaje(viaje.id).estado, 'solicitado');
  assert.equal(e.ofertasDe(viaje.id).length, 0);

  // Aparece un chofer: el siguiente ciclo le ofrece el viaje.
  e.reloj.establecer(new Date(AHORA.getTime() + 60_000));
  e.conectarChofer('chofer-1');
  const ciclo = await e.worker.ejecutarCiclo();
  assert.equal(ciclo.ofertados, 1);
  const [oferta] = e.ofertasDe(viaje.id);
  assert.equal(oferta.choferId, 'chofer-1');
  assert.equal(oferta.estado, 'pendiente');

  // Mientras la oferta esta pendiente, el worker no crea otra.
  e.conectarChofer('chofer-2');
  await e.worker.ejecutarCiclo();
  assert.equal(e.ofertasDe(viaje.id).length, 1);
});

test('si el chofer rechaza, el viaje sigue buscando; vencido el tiempo pasa a sin_choferes y se avisa', async () => {
  const e = escenario({ tiempoBusquedaSegundos: 300 });
  e.conectarChofer('chofer-1');
  const { viaje } = await e.solicitar({ pasajero: PASAJERO, origen: ORIGEN, destino: DESTINO });
  const [oferta] = e.ofertasDe(viaje.id);

  // Rechaza el unico chofer: dentro del tiempo, NO pasa a sin_choferes.
  const r = await e.rechazar({ ofertaId: oferta.id, actor: { id: 'chofer-1', rol: 'chofer' } });
  assert.equal(r.estado, 'solicitado');
  // Al que rechazo no se le vuelve a ofrecer.
  await e.worker.ejecutarCiclo();
  assert.equal(e.ofertasDe(viaje.id).length, 1);
  assert.equal(e.viaje(viaje.id).estado, 'solicitado');

  // Pasan los 5 minutos sin nadie mas: sin_choferes, con evento y aviso por SSE.
  e.reloj.establecer(new Date(AHORA.getTime() + 301_000));
  await e.worker.ejecutarCiclo();
  assert.equal(e.viaje(viaje.id).estado, 'sin_choferes');
  assert.equal(e.deps.repositorioViajes.estado.eventos.at(-1).evento, 'agotar_candidatos');
  assert.deepEqual(e.publicados.at(-1), { tipo: 'estado', datos: { viajeId: viaje.id, estado: 'sin_choferes' } });
});

test('un viaje cancelado mientras buscaba no recibe ofertas', async () => {
  const e = escenario({ tiempoBusquedaSegundos: 300 });
  const { viaje } = await e.solicitar({ pasajero: PASAJERO, origen: ORIGEN, destino: DESTINO });
  await e.cancelar({ actor: PASAJERO, viajeId: viaje.id, evento: 'cancelar_pasajero' });
  e.conectarChofer('chofer-1');
  await e.worker.ejecutarCiclo();
  assert.equal(e.viaje(viaje.id).estado, 'cancelado_pasajero');
  assert.equal(e.ofertasDe(viaje.id).length, 0);
});
