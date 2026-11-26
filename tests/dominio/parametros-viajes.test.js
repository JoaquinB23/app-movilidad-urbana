// Adaptador ParametrosViajes sobre la configuracion administrable. Se prueba
// con el repo en memoria (mismos defaults que las migraciones 300 y 301) y
// contra el caso de uso REAL de estimacion de viajes.

import test from 'node:test';
import assert from 'node:assert/strict';

import { crearParametrosViajes } from '../../src/infra/parametros-viajes.js';
import { crearRepositorioAdministracionMemoria } from '../../src/infra/memoria/repositorio-administracion-memoria.js';
import { crearEstimarViaje } from '../../src/dominio/viajes/casos-de-uso/estimar-viaje.js';

test('traduce tarifas y parametros a la forma que pide viajes', async () => {
  const admin = crearRepositorioAdministracionMemoria();
  const parametros = await crearParametrosViajes({ repositorioAdministracion: admin }).obtener();
  assert.deepEqual(parametros, {
    tarifa: {
      tarifaBaseCentavos: 150000,
      porKmCentavos: 80000,
      porMinutoCentavos: 10000,
      tarifaMinimaCentavos: 200000,
      distanciaMaximaMetros: 50000,
    },
    tiempoOfertaSegundos: 30,
    radioBusquedaMetros: 5000,
    maxCandidatos: 5,
  });
});

test('un cambio del administrador aplica a la proxima estimacion sin reiniciar', async () => {
  const admin = crearRepositorioAdministracionMemoria();
  const estimarViaje = crearEstimarViaje({
    estimadorRuta: { estimar: async () => ({ distanciaMetros: 1000, duracionSegundos: 120 }) },
    parametrosViajes: crearParametrosViajes({ repositorioAdministracion: admin }),
  });
  const trayecto = { origen: { lat: -27.45, lng: -58.98 }, destino: { lat: -27.46, lng: -58.99 } };

  // 150000 base + 80000 por 1 km + 10000 por 2 min = 250000.
  assert.equal((await estimarViaje(trayecto)).precioCentavos, 250000);

  await admin.guardarTarifas({ bajadaBanderaCentavos: 0, precioKmCentavos: 100000, precioMinutoCentavos: 0 });
  // 100000 queda por debajo del minimo (200000): se cobra el minimo.
  assert.equal((await estimarViaje(trayecto)).precioCentavos, 200000);

  await admin.guardarParametro({ clave: 'distancia_maxima_m', valor: 500 });
  await assert.rejects(estimarViaje(trayecto), (error) => error.codigo === 'VIAJE_FUERA_DE_LIMITE');
});

test('falla cerrado si falta un parametro, en vez de cotizar con un valor inventado', async () => {
  const admin = crearRepositorioAdministracionMemoria();
  const sinMaximo = {
    ...admin,
    obtenerParametros: async () => {
      const { max_candidatos: _omitido, ...resto } = await admin.obtenerParametros();
      return resto;
    },
  };
  await assert.rejects(
    crearParametrosViajes({ repositorioAdministracion: sinMaximo }).obtener(),
    /max_candidatos/
  );
});
