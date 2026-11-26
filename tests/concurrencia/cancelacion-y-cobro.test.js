// Carreras del ciclo de vida contra PostgreSQL real (enunciado 6.3 y bloque 6).
//
// 1. CANCELACION SIMULTANEA A LA ACEPTACION (50 rondas). Las dos operaciones
//    bloquean primero la fila del viaje, asi que se serializan. El resultado
//    es SIEMPRE uno de dos estados definidos:
//      A) gana la cancelacion: viaje cancelado_pasajero, la aceptacion se
//         rechaza (OFERTA_NO_VIGENTE o VIAJE_NO_DISPONIBLE) y nunca hubo
//         asignacion;
//      B) gana la aceptacion: el viaje llega a asignado y la cancelacion lo
//         deja cancelado_pasajero cerrando la asignacion.
//    En ningun caso queda un viaje asignado sin pasajero ni un chofer con una
//    asignacion abierta a un viaje cancelado.
// 2. COBRO: 50 cobros simultaneos con la MISMA Idempotency-Key -> un cobro y
//    50 respuestas iguales; 50 con claves DISTINTAS -> un cobro y 49 YA_COBRADO.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import pg from 'pg';

import { crearAceptarOferta } from '../../src/dominio/viajes/casos-de-uso/aceptar-oferta.js';
import { crearTransicionarViaje } from '../../src/dominio/viajes/casos-de-uso/transicionar-viaje.js';
import { crearRegistrarCobro } from '../../src/dominio/viajes/casos-de-uso/registrar-cobro.js';
import { crearGeneradorIdPg } from '../../src/infra/db/generador-id-pg.js';
import { crearRelojPg } from '../../src/infra/db/reloj-pg.js';
import { crearTransaccionPg } from '../../src/infra/db/transaccion-pg.js';
import { crearMedidorRecorridoPg } from '../../src/infra/db/medidor-recorrido-pg.js';
import { crearRepositorioAdministracionPg } from '../../src/infra/db/repo-administracion-pg.js';
import { crearParametrosViajes } from '../../src/infra/parametros-viajes.js';
import { migrar } from '../../src/infra/db/migrar.js';
import { crearEscenarioPg, limpiarDatosViajes } from '../integracion/ayudante-viajes.js';

const urlTest = process.env.DATABASE_URL_TEST;
const urlPrincipal = process.env.DATABASE_URL;

function identificarBase(url) {
  const parsed = new URL(url);
  return [parsed.protocol, parsed.hostname.toLowerCase(), parsed.port || '5432', decodeURIComponent(parsed.pathname)].join('|');
}

if (!urlTest || urlTest.trim() === '') {
  throw new Error('Falta DATABASE_URL_TEST; definila para ejecutar las pruebas de concurrencia.');
}
if (urlPrincipal && identificarBase(urlPrincipal) === identificarBase(urlTest)) {
  throw new Error('DATABASE_URL_TEST no puede ser igual a DATABASE_URL; se rechazó la ejecución.');
}

const pool = new pg.Pool({ connectionString: urlTest.trim(), max: 60 });
const consulta = (sql, valores) => pool.query(sql, valores);
const transaccion = crearTransaccionPg({ pool });
const reloj = crearRelojPg();
const generadorId = crearGeneradorIdPg();
const aceptarOferta = crearAceptarOferta({ transaccion, reloj, generadorId });
const transicionarViaje = crearTransicionarViaje({
  transaccion,
  reloj,
  parametrosViajes: crearParametrosViajes({ repositorioAdministracion: crearRepositorioAdministracionPg({ pool }) }),
  medidorRecorrido: crearMedidorRecorridoPg({ consulta }),
});
const registrarCobro = crearRegistrarCobro({ transaccion, reloj, generadorId });

before(async () => {
  const urlOriginal = process.env.DATABASE_URL;
  try {
    process.env.DATABASE_URL = urlTest;
    await migrar(); // idempotente: aplica la 105 (cobros) si falta
  } finally {
    if (urlOriginal === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = urlOriginal;
  }
});
beforeEach(() => limpiarDatosViajes(consulta));
after(async () => {
  await limpiarDatosViajes(consulta);
  await pool.end();
});

async function estadoFinal(viajeId, choferId) {
  const { rows: [viaje] } = await consulta('SELECT estado FROM viajes WHERE id = $1', [viajeId]);
  const { rows: asignaciones } = await consulta(
    'SELECT hasta FROM asignaciones_viaje WHERE viaje_id = $1', [viajeId]);
  const { rows: abiertasChofer } = await consulta(
    'SELECT 1 FROM asignaciones_viaje WHERE chofer_id = $1 AND hasta IS NULL', [choferId]);
  const { rows: pendientes } = await consulta(
    "SELECT 1 FROM ofertas_viaje WHERE viaje_id = $1 AND estado = 'pendiente'", [viajeId]);
  return { estado: viaje.estado, asignaciones, abiertasChofer: abiertasChofer.length, pendientes: pendientes.length };
}

test('cancelacion simultanea a la aceptacion: 50 rondas, siempre uno de los dos resultados definidos', async () => {
  const resultados = { ganaCancelacion: 0, ganaAceptacion: 0 };
  for (let ronda = 0; ronda < 50; ronda += 1) {
    const { pasajeroId, choferId, viajeId, ofertaId } = await crearEscenarioPg(pool);
    const [aceptacion, cancelacion] = await Promise.allSettled([
      aceptarOferta({ actor: { id: choferId, rol: 'chofer' }, ofertaId }),
      transicionarViaje({ actor: { id: pasajeroId, rol: 'pasajero' }, viajeId, evento: 'cancelar_pasajero' }),
    ]);
    const final = await estadoFinal(viajeId, choferId);

    // La cancelacion es valida desde solicitado Y desde asignado: siempre gana.
    assert.equal(cancelacion.status, 'fulfilled', `ronda ${ronda}: ${cancelacion.reason?.codigo}`);
    assert.equal(final.estado, 'cancelado_pasajero', `ronda ${ronda}`);
    // Invariantes: ningun chofer ocupado por un viaje cancelado, ninguna oferta viva.
    assert.equal(final.abiertasChofer, 0, `ronda ${ronda}: el chofer quedo ocupado`);
    assert.equal(final.pendientes, 0, `ronda ${ronda}: quedo una oferta pendiente`);

    if (aceptacion.status === 'rejected') {
      // Resultado A: la cancelacion llego primero.
      assert.ok(['OFERTA_NO_VIGENTE', 'VIAJE_NO_DISPONIBLE'].includes(aceptacion.reason.codigo),
        `ronda ${ronda}: rechazo inesperado ${aceptacion.reason.codigo}`);
      assert.equal(final.asignaciones.length, 0, `ronda ${ronda}: no debio haber asignacion`);
      resultados.ganaCancelacion += 1;
    } else {
      // Resultado B: la aceptacion llego primero y la cancelacion cerro la asignacion.
      assert.equal(final.asignaciones.length, 1);
      assert.notEqual(final.asignaciones[0].hasta, null, `ronda ${ronda}: asignacion sin cerrar`);
      resultados.ganaAceptacion += 1;
    }
    await limpiarDatosViajes(consulta);
  }
  assert.equal(resultados.ganaCancelacion + resultados.ganaAceptacion, 50);
});

async function viajeFinalizadoPg() {
  const escenario = await crearEscenarioPg(pool);
  const chofer = { id: escenario.choferId, rol: 'chofer' };
  await aceptarOferta({ actor: chofer, ofertaId: escenario.ofertaId });
  for (const evento of ['salir_en_camino', 'iniciar', 'finalizar']) {
    await transicionarViaje({ actor: chofer, viajeId: escenario.viajeId, evento });
  }
  return escenario;
}

test('50 cobros simultaneos con la misma Idempotency-Key: un solo cobro y la misma respuesta', async () => {
  const { pasajeroId, viajeId } = await viajeFinalizadoPg();
  const actor = { id: pasajeroId, rol: 'pasajero' };
  const idempotencia = { clave: `cobro-${randomUUID()}`, hash: 'hash-del-cobro' };
  const respuestas = await Promise.all(
    Array.from({ length: 50 }, () => registrarCobro({ actor, viajeId, idempotencia }))
  );

  const { rows } = await consulta('SELECT id, importe_centavos FROM cobros WHERE viaje_id = $1', [viajeId]);
  assert.equal(rows.length, 1, 'un solo cobro en la base');
  assert.ok(respuestas.every((r) => r.cobroId === rows[0].id), 'todas devuelven el mismo cobro');
  assert.equal(respuestas.filter((r) => !r.repetido).length, 1, 'uno solo lo creo');
  const { rows: [viaje] } = await consulta('SELECT tarifa_final_centavos FROM viajes WHERE id = $1', [viajeId]);
  assert.equal(rows[0].importe_centavos, viaje.tarifa_final_centavos);
});

test('50 cobros simultaneos con claves distintas: un cobro y 49 YA_COBRADO', async () => {
  const { pasajeroId, viajeId } = await viajeFinalizadoPg();
  const actor = { id: pasajeroId, rol: 'pasajero' };
  const resultados = await Promise.allSettled(
    Array.from({ length: 50 }, (_, i) =>
      registrarCobro({ actor, viajeId, idempotencia: { clave: `clave-${i}-${randomUUID()}`, hash: 'h' } }))
  );

  const exitos = resultados.filter((r) => r.status === 'fulfilled');
  const rechazos = resultados.filter((r) => r.status === 'rejected');
  assert.equal(exitos.length, 1);
  assert.ok(rechazos.every((r) => r.reason.codigo === 'YA_COBRADO'),
    `rechazos: ${[...new Set(rechazos.map((r) => r.reason.codigo))]}`);
  const { rows } = await consulta('SELECT count(*)::int AS n FROM cobros WHERE viaje_id = $1', [viajeId]);
  assert.equal(rows[0].n, 1);
});
