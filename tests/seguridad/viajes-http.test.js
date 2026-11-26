import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { estadosHttpViajes } from '../../src/infra/http/rutas/viajes.js';
import { montarViajes } from '../../src/composicion.js';
import { crearAutenticar, requerirRol } from '../../src/infra/http/autenticacion.js';
import * as memoria from '../../src/infra/memoria/index.js';

test('dos sesiones completan el primer viaje y los reintentos conservan un único resultado', async (t) => {
  const pasajero = randomUUID();
  const chofer = randomUUID();
  const otro = randomUUID();
  const actores = new Map([[pasajero, 'pasajero'], [chofer, 'chofer'], [otro, 'chofer']]);
  const origen = { lat: -27.45, lng: -58.98 };
  const destino = { lat: -27.46, lng: -58.97 };
  const viajes = memoria.crearRepositorioViajesEnMemoria();
  const ofertas = memoria.crearRepositorioOfertasEnMemoria();
  const asignaciones = memoria.crearRepositorioAsignacionesEnMemoria();
  const choferes = memoria.crearRepositorioChoferesEnMemoria([{ id: chofer, habilitado: true, disponible: true }]);
  const reloj = memoria.crearRelojEnMemoria();
  const servicioGeo = memoria.crearServicioGeoEnMemoria();
  servicioGeo.cargarUbicacion(chofer, origen);
  const eventos = [];
  const deps = {
    reloj, servicioGeo,
    transaccion: memoria.crearTransaccionEnMemoria({ viajes, ofertas, choferes, asignaciones }),
    generadorId: memoria.crearGeneradorIdEnMemoria(),
    estimadorRuta: memoria.crearEstimadorRutaEnMemoria(),
    parametrosViajes: memoria.crearParametrosViajesEnMemoria({
      tarifa: { tarifaBaseCentavos: 100, porKmCentavos: 10, porMinutoCentavos: 5,
        tarifaMinimaCentavos: 100, distanciaMaximaMetros: 50000 },
      tiempoOfertaSegundos: 30, radioBusquedaMetros: 1000, maxCandidatos: 5,
    }),
    busEventos: { publicar: (canal, evento) => eventos.push({ canal, evento }) },
  };
  const app = express();
  app.use(express.json());
  montarViajes(app, {
    ...deps,
    autenticar: crearAutenticar({ tokens: { verificar: id => actores.has(id) && { sub: id, rol: actores.get(id) } } }),
    requerirRol, repositorioViajes: viajes, repositorioOfertas: ofertas, repositorioAsignaciones: asignaciones,
  });
  app.use((error, req, res, next) => res.status(estadosHttpViajes[error.codigo] ?? 500).json({ codigo: error.codigo }));
  const servidor = app.listen(0, '127.0.0.1');
  await once(servidor, 'listening');
  t.after(() => new Promise(resolve => servidor.close(resolve)));
  async function pedir(ruta, actor, cuerpo, clave) {
    return fetch('http://127.0.0.1:' + servidor.address().port + ruta, {
      method: cuerpo === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(actor && { authorization: 'Bearer ' + actor }),
        ...(clave && { 'Idempotency-Key': clave }) }, body: JSON.stringify(cuerpo),
    });
  }
  const puntos = { origen, destino };
  assert.equal((await pedir('/viajes/estimacion', pasajero, puntos)).status, 200);
  assert.equal((await pedir('/viajes', pasajero, puntos)).status, 400);
  assert.equal((await pedir('/viajes', pasajero, { ...puntos, pasajeroId: otro }, 'k')).status, 400);
  const pedidos = await Promise.all(Array.from({ length: 50 }, () => pedir('/viajes', pasajero, puntos, 'k')));
  const resultados = await Promise.all(pedidos.map(async r => { assert.equal(r.status, 201); return r.json(); }));
  const viaje = resultados[0];
  for (const resultado of resultados) assert.deepEqual(resultado, viaje);
  assert.equal(viajes.estado.viajes.size, 1);
  assert.equal(ofertas.estado.ofertas.size, 1);
  assert.equal((await pedir('/viajes', pasajero, { origen, destino: origen }, 'k')).status, 409);
  const listado = '/choferes/me/ofertas';
  assert.equal((await pedir(listado)).status, 401);
  assert.equal((await pedir(listado, pasajero)).status, 403);
  assert.deepEqual(await (await pedir(listado, otro)).json(), { ofertas: [] });
  const { ofertas: [oferta] } = await (await pedir(listado, chofer)).json();
  const aceptar = '/ofertas/' + oferta.id + '/aceptar';
  const rechazo = '/ofertas/' + oferta.id + '/rechazar';
  assert.equal((await pedir(rechazo, undefined, {})).status, 401);
  assert.equal((await pedir(rechazo, pasajero, {})).status, 403);
  const ajena = await pedir(rechazo, otro, {});
  const inexistente = await pedir('/ofertas/' + randomUUID() + '/rechazar', otro, {});
  assert.equal(ajena.status, 404);
  assert.equal(inexistente.status, 404);
  assert.deepEqual(await ajena.json(), await inexistente.json());
  assert.equal((await pedir(aceptar, otro, {})).status, 404);
  assert.equal((await pedir(aceptar, chofer, {})).status, 200);
  assert.equal((await pedir(aceptar, chofer, {})).status, 409);
  assert.equal((await asignaciones.buscarAbiertaPorViaje(viaje.id)).choferId, chofer);
  assert.deepEqual(await (await pedir('/viajes/' + viaje.id, pasajero)).json(), { id: viaje.id, estado: 'asignado' });
  assert.equal((await pedir('/viajes/' + viaje.id, otro)).status, 404);
  assert.deepEqual(await (await pedir(listado, chofer)).json(), { ofertas: [] });
  assert.deepEqual(eventos, [{ canal: 'seguimiento:viaje:' + viaje.id,
    evento: { tipo: 'estado', datos: { viajeId: viaje.id, estado: 'asignado' } } }]);
});
