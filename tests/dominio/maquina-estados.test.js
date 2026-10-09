// Tests de la maquina de estados del viaje.
//
// Estrategia: en vez de escribir a mano cada caso, se RECORRE la tabla
// `TRANSICIONES`. Asi, si manana cambia la tabla, los tests se actualizan solos
// y no hay reglas duplicadas entre produccion y test.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ESTADOS,
  EVENTOS,
  TRANSICIONES,
  ESTADOS_TERMINALES,
  ACTORES,
  aplicarTransicion,
  buscarTransicion,
  actorDeEvento,
  esEstadoTerminal,
} from '../../src/dominio/viajes/maquina-estados.js';
import {
  ErrorTransicionInvalida,
  ErrorActorNoAutorizado,
  ErrorDatosInvalidos,
} from '../../src/dominio/viajes/errores.js';

function viajeEn(estado) {
  return {
    id: 'viaje-1',
    pasajeroId: 'p-1',
    estado,
    historial: [],
    puntos: { origen: 'A', destino: 'B' },
  };
}

function datosPara(transicion) {
  return transicion.requiereMotivo ? { motivo: 'cancelado por operador' } : {};
}

// --- Sanidad de la propia tabla (evita tests que pasen por datos mal cargados) ---
test('la tabla solo usa estados y eventos declarados', () => {
  for (const t of TRANSICIONES) {
    assert.ok(ESTADOS.includes(t.estado), `estado desconocido: ${t.estado}`);
    assert.ok(ESTADOS.includes(t.nuevoEstado), `nuevo estado desconocido: ${t.nuevoEstado}`);
    assert.ok(EVENTOS.includes(t.evento), `evento desconocido: ${t.evento}`);
    assert.ok(ACTORES.includes(t.actor), `actor desconocido: ${t.actor}`);
  }
});

test('no hay transiciones duplicadas (mismo estado + evento)', () => {
  const vistas = new Set();
  for (const t of TRANSICIONES) {
    const clave = `${t.estado}|${t.evento}`;
    assert.ok(!vistas.has(clave), `transicion duplicada: ${clave}`);
    vistas.add(clave);
  }
});

test('los estados terminales no tienen salidas en la tabla', () => {
  for (const estado of ESTADOS_TERMINALES) {
    assert.ok(esEstadoTerminal(estado));
    const salidas = TRANSICIONES.filter((t) => t.estado === estado);
    assert.equal(salidas.length, 0, `el estado terminal '${estado}' no debe tener salidas`);
  }
});

// --- Un test por cada transicion valida ---
for (const t of TRANSICIONES) {
  test(`valida: '${t.estado}' + ${t.evento} (${t.actor}) -> '${t.nuevoEstado}'`, () => {
    const viaje = viajeEn(t.estado);
    const resultado = aplicarTransicion(viaje, t.evento, t.actor, datosPara(t));

    assert.equal(resultado.estado, t.nuevoEstado);
    assert.notEqual(resultado, viaje, 'debe devolver un viaje nuevo');

    assert.equal(resultado.historial.length, 1);
    const [entrada] = resultado.historial;
    assert.equal(entrada.evento, t.evento);
    assert.equal(entrada.actor, t.actor);
    assert.equal(entrada.desde, t.estado);
    assert.equal(entrada.hacia, t.nuevoEstado);
    if (t.requiereMotivo) assert.equal(entrada.motivo, 'cancelado por operador');

    // El original no se toca.
    assert.equal(viaje.estado, t.estado);
    assert.equal(viaje.historial.length, 0);
  });
}

// --- Un test por cada combinacion estado x evento que NO este en la tabla ---
for (const estado of ESTADOS) {
  for (const evento of EVENTOS) {
    if (buscarTransicion(estado, evento) !== null) continue;

    // Se usa el actor canonico del evento para aislar el error de TRANSICION
    // (no del actor) y se aporta motivo por si el evento lo requiere.
    const actor = actorDeEvento(evento);
    test(`invalida: '${estado}' + ${evento}`, () => {
      assert.throws(
        () => aplicarTransicion(viajeEn(estado), evento, actor, { motivo: 'motivo de prueba' }),
        (err) => {
          assert.ok(err instanceof ErrorTransicionInvalida);
          assert.equal(err.codigo, 'TRANSICION_INVALIDA');
          assert.equal(err.estadoActual, estado);
          assert.equal(err.evento, evento);
          return true;
        }
      );
    });
  }
}

test('actor no autorizado: pasajero intentando iniciar', () => {
  assert.throws(
    () => aplicarTransicion(viajeEn('chofer_en_camino'), 'iniciar', 'pasajero'),
    (err) => {
      assert.ok(err instanceof ErrorActorNoAutorizado);
      assert.equal(err.codigo, 'ACTOR_NO_AUTORIZADO');
      assert.equal(err.actor, 'pasajero');
      assert.equal(err.actorEsperado, 'chofer');
      assert.equal(err.evento, 'iniciar');
      return true;
    }
  );
});

test('actor no autorizado: chofer intentando cancelar_pasajero', () => {
  assert.throws(
    () => aplicarTransicion(viajeEn('asignado'), 'cancelar_pasajero', 'chofer'),
    ErrorActorNoAutorizado
  );
});

test('evento desconocido -> ErrorTransicionInvalida', () => {
  assert.throws(
    () => aplicarTransicion(viajeEn('solicitado'), 'teletransportar', 'chofer'),
    ErrorTransicionInvalida
  );
});

test('cancelar_operador sin motivo -> ErrorDatosInvalidos', () => {
  assert.throws(
    () => aplicarTransicion(viajeEn('en_curso'), 'cancelar_operador', 'operador', { motivo: '   ' }),
    ErrorDatosInvalidos
  );
});

test('aplicarTransicion no muta el viaje original (comparacion profunda)', () => {
  const viaje = {
    id: 'viaje-9',
    estado: 'en_curso',
    historial: [{ evento: 'iniciar', actor: 'chofer' }],
    puntos: { origen: 'A', destino: 'B' },
  };
  const copia = structuredClone(viaje);

  const resultado = aplicarTransicion(viaje, 'finalizar', 'chofer');

  assert.deepEqual(viaje, copia, 'el original debe quedar intacto');
  assert.notEqual(resultado, viaje);
  assert.notEqual(resultado.historial, viaje.historial, 'el historial no debe ser el mismo array');
  assert.equal(resultado.historial.length, 2);
  assert.equal(resultado.puntos, viaje.puntos, 'copia superficial: referencias internas se comparten (documentado)');
});
