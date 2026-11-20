// Privacidad del seguimiento (requisito 6.4), a nivel de DOMINIO.
//
// Regla que se verifica: el seguimiento solo expone la posicion de la
// CONTRAPARTE del viaje.
//   * pasajero -> ve la ultima posicion del chofer ASIGNADO a su viaje;
//   * chofer   -> ve la posicion del pasajero de SU viaje (hoy: el origen,
//                 porque el pasajero no reporta ubicacion por esta API);
//   * cualquier otro actor (otro pasajero, otro chofer, operador, admin) NO
//     obtiene NADA, y ademas la ubicacion ni siquiera se consulta.
//
// No se usa base ni HTTP: se inyectan los adaptadores en memoria, igual que el
// resto de los tests de dominio del modulo.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  autorizarSeguimiento,
  autorizarRecorrido,
  construirSeguimiento,
} from '../../src/dominio/ubicaciones/servicios.js';
import {
  ErrorNoEncontrado,
  ErrorRecursoAjeno,
} from '../../src/dominio/ubicaciones/errores.js';
import { crearRepositorioUbicacionesMemoria } from '../../src/infra/memoria/repositorio-ubicaciones-memoria.js';

const VIAJE_1 = {
  id: 'viaje-1',
  pasajeroId: 'pasajero-1',
  choferId: 'chofer-1',
  estado: 'en_curso',
  origen: { lat: -27.45, lng: -58.98 },
};

const VIAJE_2 = {
  id: 'viaje-2',
  pasajeroId: 'pasajero-2',
  choferId: 'chofer-2',
  estado: 'en_curso',
  origen: { lat: -26.0, lng: -57.0 },
};

async function crearUbicaciones() {
  const ubicaciones = crearRepositorioUbicacionesMemoria();
  // Posicion en vivo de cada chofer.
  await ubicaciones.actualizarActual({ choferId: 'chofer-1', lat: -27.5, lng: -58.99, timestamp: 100 });
  await ubicaciones.actualizarActual({ choferId: 'chofer-2', lat: -26.1, lng: -57.1, timestamp: 200 });
  // Aunque existiera una "posicion" del pasajero-1, no debe usarse ni leerse.
  await ubicaciones.actualizarActual({ choferId: 'pasajero-1', lat: -27.9, lng: -58.8, timestamp: 300 });
  return ubicaciones;
}

// --- lo que SI ve cada participante ---

test('el pasajero ve solo la posicion del chofer asignado a SU viaje', async () => {
  const ubicaciones = await crearUbicaciones();

  const seguimiento = await construirSeguimiento({
    viaje: VIAJE_1,
    actor: { id: 'pasajero-1', rol: 'pasajero' },
    repositorioUbicaciones: ubicaciones,
  });

  assert.equal(seguimiento.rol, 'pasajero');
  assert.deepEqual(seguimiento.posicionContraparte, {
    lat: -27.5,
    lng: -58.99,
    timestamp: 100,
  });
  // La posicion del chofer del OTRO viaje no aparece por ningun lado.
  assert.notDeepEqual(seguimiento.posicionContraparte, {
    lat: -26.1,
    lng: -57.1,
    timestamp: 200,
  });
});

test('el chofer asignado ve solo la posicion del pasajero de SU viaje (origen)', async () => {
  const ubicaciones = await crearUbicaciones();

  const seguimiento = await construirSeguimiento({
    viaje: VIAJE_1,
    actor: { id: 'chofer-1', rol: 'chofer' },
    repositorioUbicaciones: ubicaciones,
  });

  assert.equal(seguimiento.rol, 'chofer');
  // Hoy el pasajero no reporta ubicacion por esta API: su posicion es el
  // origen del viaje, y NO la ultima posicion de un chofer ni de otro viaje.
  assert.deepEqual(seguimiento.posicionContraparte, {
    lat: -27.45,
    lng: -58.98,
    timestamp: null,
  });
  assert.notDeepEqual(seguimiento.posicionContraparte, {
    lat: -26.0,
    lng: -57.0,
    timestamp: null,
  });
});

// --- lo que NO ve nadie mas ---

test('un pasajero ajeno no obtiene nada, y la ubicacion ni se consulta', async () => {
  let consultas = 0;
  const espia = {
    async obtenerActual() {
      consultas += 1;
      return { lat: -27.5, lng: -58.99, timestamp: 100 };
    },
  };

  await assert.rejects(
    () =>
      construirSeguimiento({
        viaje: VIAJE_1,
        actor: { id: 'pasajero-2', rol: 'pasajero' },
        repositorioUbicaciones: espia,
      }),
    ErrorRecursoAjeno
  );
  // Fail-closed: se autoriza ANTES de tocar el repositorio. Si se consultara
  // primero y se filtrara despues, una excepcion en el filtro ya expuso el dato.
  assert.equal(consultas, 0, 'no debe consultarse la ubicacion de un actor ajeno');
});

test('un chofer de OTRO viaje no puede ver al pasajero del viaje ajeno', async () => {
  const ubicaciones = await crearUbicaciones();

  // chofer-2 es chofer de viaje-2: pedir viaje-1 es RECURSO_AJENO.
  await assert.rejects(
    () =>
      construirSeguimiento({
        viaje: VIAJE_1,
        actor: { id: 'chofer-2', rol: 'chofer' },
        repositorioUbicaciones: ubicaciones,
      }),
    ErrorRecursoAjeno
  );

  // Y al reves: chofer-1 no puede ver el pasajero de viaje-2.
  await assert.rejects(
    () =>
      construirSeguimiento({
        viaje: VIAJE_2,
        actor: { id: 'chofer-1', rol: 'chofer' },
        repositorioUbicaciones: ubicaciones,
      }),
    ErrorRecursoAjeno
  );
});

test('un operador o administrador sin ser participe tampoco ve el seguimiento', async () => {
  const ubicaciones = await crearUbicaciones();

  for (const rol of ['operador', 'administrador']) {
    await assert.rejects(
      () =>
        construirSeguimiento({
          viaje: VIAJE_1,
          actor: { id: `${rol}-1`, rol },
          repositorioUbicaciones: ubicaciones,
        }),
      ErrorRecursoAjeno
    );
  }
});

test('el recorrido usa la misma regla de acceso que el seguimiento', async () => {
  assert.doesNotThrow(() =>
    autorizarRecorrido({ viaje: VIAJE_1, actor: { id: 'pasajero-1', rol: 'pasajero' } })
  );
  assert.throws(
    () => autorizarRecorrido({ viaje: VIAJE_1, actor: { id: 'chofer-2', rol: 'chofer' } }),
    ErrorRecursoAjeno
  );
  assert.throws(
    () => autorizarRecorrido({ viaje: VIAJE_1, actor: { id: 'pasajero-2', rol: 'pasajero' } }),
    ErrorRecursoAjeno
  );
});

// --- viaje terminado: regla VIGENTE, documentada a proposito ---

test('regla vigente: un viaje finalizado o cancelado SIGUE visible para sus participantes', async () => {
  const ubicaciones = await crearUbicaciones();

  for (const estado of ['finalizado', 'cancelado']) {
    const viaje = { ...VIAJE_1, estado };

    // Hoy `autorizarSeguimiento` NO mira `viaje.estado`: solo compara ids.
    const seguimiento = await construirSeguimiento({
      viaje,
      actor: { id: 'pasajero-1', rol: 'pasajero' },
      repositorioUbicaciones: ubicaciones,
    });
    assert.equal(seguimiento.estado, estado);
    assert.deepEqual(seguimiento.posicionContraparte, {
      lat: -27.5,
      lng: -58.99,
      timestamp: 100,
    });

    // Un tercero sigue rechazado, tambien en viajes terminados.
    assert.throws(
      () => autorizarSeguimiento({ viaje, actor: { id: 'pasajero-2', rol: 'pasajero' } }),
      ErrorRecursoAjeno
    );
  }
  // PENDIENTE DE DECISION: si se aprueba, viaje finalizado/cancelado debe
  // dejar de exponer la posicion (ver la propuesta en el resumen del paso).
  // Cuando se cambie la regla, este test debe afirmar el rechazo, no el 200.
});

// --- el error no agrega datos que confirmen el viaje ---

test('el error de recurso ajeno no incluye ids de participantes ni coordenadas', () => {
  try {
    autorizarSeguimiento({ viaje: VIAJE_1, actor: { id: 'intruso', rol: 'pasajero' } });
    assert.fail('deberia haber lanzado ErrorRecursoAjeno');
  } catch (error) {
    assert.ok(error instanceof ErrorRecursoAjeno);
    const texto = `${error.message} ${JSON.stringify({
      codigo: error.codigo,
      recurso: error.recurso,
      actor: error.actor,
    })}`;
    for (const datoSensible of ['pasajero-1', 'chofer-1', '-27.45', '-58.98', '-27.5', '-58.99']) {
      assert.equal(
        texto.includes(datoSensible),
        false,
        `el error no debe contener '${datoSensible}': ${texto}`
      );
    }
  }
});

test('el error de viaje inexistente es generico y no repite el id pedido', () => {
  try {
    autorizarSeguimiento({ viaje: null, actor: { id: 'pasajero-1', rol: 'pasajero' } });
    assert.fail('deberia haber lanzado ErrorNoEncontrado');
  } catch (error) {
    assert.ok(error instanceof ErrorNoEncontrado);
    assert.equal(error.codigo, 'NO_ENCONTRADO');
    assert.equal(error.message.includes('viaje-fantasma'), false);
    assert.equal(error.message.includes('pasajero-1'), false);
  }
});
