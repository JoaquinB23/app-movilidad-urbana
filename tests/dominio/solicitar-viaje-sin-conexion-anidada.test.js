// Regresion: solicitarViaje no puede pedir otra conexion mientras tiene la
// transaccion abierta. Con PostgreSQL, buscarCandidatos y parametros usan el
// POOL (no el cliente de la transaccion): bajo carga, las 10 conexiones
// quedaban "idle in transaction" esperando una conexion mas que nunca se
// liberaba, y la API dejaba de responder para siempre.

import test from 'node:test';
import assert from 'node:assert/strict';

import { crearSolicitarViaje } from '../../src/dominio/viajes/casos-de-uso/solicitar-viaje.js';
import {
  crearEstimadorRutaEnMemoria,
  crearGeneradorIdEnMemoria,
  crearParametrosViajesEnMemoria,
  crearRelojEnMemoria,
  crearRepositorioAsignacionesEnMemoria,
  crearRepositorioChoferesEnMemoria,
  crearRepositorioOfertasEnMemoria,
  crearRepositorioViajesEnMemoria,
  crearServicioGeoEnMemoria,
  crearTransaccionEnMemoria,
} from '../../src/infra/memoria/index.js';

const ORIGEN = { lat: -27.4514, lng: -58.9866 };
const DESTINO = { lat: -27.46, lng: -58.99 };
const PASAJERO = { id: 'pasajero-1', rol: 'pasajero' };

function escenario() {
  const reloj = crearRelojEnMemoria(new Date('2026-11-27T12:00:00.000Z'));
  const ofertas = crearRepositorioOfertasEnMemoria();
  const asignaciones = crearRepositorioAsignacionesEnMemoria({ reloj });
  const viajes = crearRepositorioViajesEnMemoria({ asignaciones, ofertas });
  const choferes = crearRepositorioChoferesEnMemoria([]);
  const servicioGeo = crearServicioGeoEnMemoria();
  servicioGeo.cargarUbicacion('chofer-1', { lat: ORIGEN.lat + 0.001, lng: ORIGEN.lng });
  const parametrosViajes = crearParametrosViajesEnMemoria({
    tarifa: { tarifaBaseCentavos: 100, porKmCentavos: 10, porMinutoCentavos: 5, tarifaMinimaCentavos: 100, distanciaMaximaMetros: 50000 },
    tiempoOfertaSegundos: 30,
    radioBusquedaMetros: 5000,
    maxCandidatos: 5,
    tiempoBusquedaSegundos: 0,
  });

  // Registra cada llamada que use una conexion propia mientras la
  // transaccion esta abierta.
  let transaccionAbierta = false;
  const llamadasDentro = [];
  const base = crearTransaccionEnMemoria({ viajes, ofertas, choferes, asignaciones });
  const transaccion = {
    async ejecutar(fn) {
      return base.ejecutar(async (repos) => {
        transaccionAbierta = true;
        try {
          return await fn(repos);
        } finally {
          transaccionAbierta = false;
        }
      });
    },
  };
  const espiar = (objeto, metodo, nombre) => {
    const original = objeto[metodo].bind(objeto);
    objeto[metodo] = (...args) => {
      if (transaccionAbierta) llamadasDentro.push(nombre);
      return original(...args);
    };
  };
  espiar(servicioGeo, 'buscarCandidatos', 'servicioGeo.buscarCandidatos');
  espiar(parametrosViajes, 'obtener', 'parametrosViajes.obtener');

  const solicitar = crearSolicitarViaje({
    repositorioViajes: viajes,
    repositorioOfertas: ofertas,
    transaccion,
    reloj,
    generadorId: crearGeneradorIdEnMemoria(),
    estimadorRuta: crearEstimadorRutaEnMemoria(),
    parametrosViajes,
    servicioGeo,
  });
  return { solicitar, llamadasDentro, viajes, ofertas };
}

test('busca candidatos y lee parametros FUERA de la transaccion, y el viaje queda ofertado al chofer cercano', async () => {
  const e = escenario();
  const { viaje, oferta } = await e.solicitar({ pasajero: PASAJERO, origen: ORIGEN, destino: DESTINO });

  assert.deepEqual(e.llamadasDentro, [], 'ninguna lectura con conexion propia dentro de la transaccion');
  // Dato final: el viaje quedo guardado y con una oferta pendiente al chofer.
  assert.equal(e.viajes.estado.viajes.get(viaje.id).estado, 'solicitado');
  const guardada = e.ofertas.estado.ofertas.get(oferta.id);
  assert.equal(guardada.choferId, 'chofer-1');
  assert.equal(guardada.estado, 'pendiente');
});

test('con clave de idempotencia tampoco hay lecturas dentro de la transaccion', async () => {
  const e = escenario();
  const idempotencia = { clave: 'clave-1', hash: 'h1' };
  const primero = await e.solicitar({ pasajero: PASAJERO, origen: ORIGEN, destino: DESTINO, idempotencia });
  const repetido = await e.solicitar({ pasajero: PASAJERO, origen: ORIGEN, destino: DESTINO, idempotencia });

  assert.deepEqual(e.llamadasDentro, []);
  assert.equal(repetido.viaje.id, primero.viaje.id, 'el reintento devuelve el mismo viaje');
  assert.equal(e.viajes.estado.viajes.size, 1, 'el reintento no crea un segundo viaje');
});

// Mismo problema en finalizar: la tarifa final lee parametros y el recorrido
// (historial de ubicaciones) con el pool. Se leen antes de la transaccion.
test('finalizar lee tarifa y recorrido FUERA de la transaccion y guarda la tarifa final correcta', async () => {
  const { crearTransicionarViaje } = await import('../../src/dominio/viajes/casos-de-uso/transicionar-viaje.js');
  const { calcularTarifa } = await import('../../src/dominio/viajes/tarifa.js');
  const { crearMedidorRecorridoEnMemoria } = await import('../../src/infra/memoria/index.js');
  const INICIO = new Date('2026-11-27T12:00:00.000Z');
  const TARIFA = { tarifaBaseCentavos: 1000, porKmCentavos: 500, porMinutoCentavos: 100, tarifaMinimaCentavos: 1000, distanciaMaximaMetros: 50000 };

  const reloj = crearRelojEnMemoria(new Date(INICIO.getTime() + 600_000));
  const asignaciones = crearRepositorioAsignacionesEnMemoria({ reloj });
  const repos = {
    viajes: crearRepositorioViajesEnMemoria({ asignaciones }),
    ofertas: crearRepositorioOfertasEnMemoria(),
    choferes: crearRepositorioChoferesEnMemoria([{ id: 'chofer-1', habilitado: true, disponible: false }]),
    asignaciones,
  };
  repos.viajes.estado.viajes.set('viaje-1', {
    id: 'viaje-1', pasajeroId: 'pasajero-1', estado: 'en_curso', origen: ORIGEN, destino: DESTINO,
    distanciaEstimadaMetros: 1500, duracionEstimadaSegundos: 180, tarifaEstimadaCentavos: 3000,
    tarifaFinalCentavos: null, motivoCierre: null, creadoEn: INICIO, actualizadoEn: INICIO,
    historial: [{ evento: 'iniciar', en: INICIO }],
  });
  asignaciones.estado.asignaciones.set('asig-1', {
    id: 'asig-1', viajeId: 'viaje-1', choferId: 'chofer-1', desde: INICIO, hasta: null, motivoFin: null,
  });

  let abierta = false;
  const llamadasDentro = [];
  const base = crearTransaccionEnMemoria(repos);
  const transaccion = {
    ejecutar: (fn) => base.ejecutar(async (r) => {
      abierta = true;
      try { return await fn(r); } finally { abierta = false; }
    }),
  };
  const parametrosViajes = crearParametrosViajesEnMemoria({ tarifa: TARIFA });
  const medidor = crearMedidorRecorridoEnMemoria();
  medidor.cargar('viaje-1', 4200);
  for (const [objeto, metodo, nombre] of [
    [parametrosViajes, 'obtener', 'parametrosViajes.obtener'],
    [medidor, 'distanciaRecorridaMetros', 'medidorRecorrido.distanciaRecorridaMetros'],
  ]) {
    const original = objeto[metodo].bind(objeto);
    objeto[metodo] = (...args) => { if (abierta) llamadasDentro.push(nombre); return original(...args); };
  }

  const transicionar = crearTransicionarViaje({ transaccion, reloj, parametrosViajes, medidorRecorrido: medidor });
  const fin = await transicionar({ actor: { id: 'chofer-1', rol: 'chofer' }, viajeId: 'viaje-1', evento: 'finalizar' });

  assert.deepEqual(llamadasDentro, []);
  const esperada = calcularTarifa({ distanciaMetros: 4200, duracionSegundos: 600, parametros: TARIFA }).totalCentavos;
  assert.equal(fin.estado, 'finalizado');
  assert.equal(repos.viajes.estado.viajes.get('viaje-1').tarifaFinalCentavos, esperada);
});
