// Maquina de estados del viaje (modulo de dominio, sin dependencias externas).
//
// Decisiones de diseno (defendibles):
// 1) La tabla de transiciones es DATO exportado (`TRANSICIONES`). Los tests y
//    el futuro diagrama se generan recorriendo esa tabla, no duplicando reglas.
// 2) `cancelar_operador` se enumera para CADA estado no terminal aunque sea
//    "cualquier estado no terminal". Asi la tabla queda completa y el test de
//    "todas las combinaciones estado x evento fuera de la tabla deben fallar"
//    es valido y exhaustivo.
// 3) La transicion se valida en este orden: evento conocido -> actor correcto
//    -> (estado, evento) exista -> motivo obligatorio. Validar el actor primero
//    permite distinguir ACTOR_NO_AUTORIZADO de TRANSICION_INVALIDA.
// 4) `aplicarTransicion` es PURA: no muta el viaje recibido, devuelve uno nuevo
//    con el estado actualizado y una entrada agregada al historial.

import {
  ErrorTransicionInvalida,
  ErrorActorNoAutorizado,
  ErrorDatosInvalidos,
} from './errores.js';

export const ESTADOS = Object.freeze([
  'solicitado',
  'asignado',
  'chofer_en_camino',
  'en_curso',
  'finalizado',
  'cancelado_pasajero',
  'cancelado_chofer',
  'sin_choferes',
]);

export const ESTADOS_TERMINALES = Object.freeze([
  'finalizado',
  'cancelado_pasajero',
  'cancelado_chofer',
  'sin_choferes',
]);

export const EVENTOS = Object.freeze([
  'aceptar_oferta',
  'agotar_candidatos',
  'cancelar_pasajero',
  'cancelar_chofer',
  'salir_en_camino',
  'iniciar',
  'finalizar',
  'cancelar_operador',
]);

// Roles del sistema. El evento dice quien puede dispararlo.
export const ACTORES = Object.freeze([
  'pasajero',
  'chofer',
  'operador',
  'sistema',
  'administrador',
]);

// Tabla canonica de transiciones validas. Cada fila es:
//   { estado, evento, actor, nuevoEstado, requiereMotivo? }
export const TRANSICIONES = Object.freeze(
  [
    { estado: 'solicitado', evento: 'aceptar_oferta', actor: 'chofer', nuevoEstado: 'asignado' },
    { estado: 'solicitado', evento: 'agotar_candidatos', actor: 'sistema', nuevoEstado: 'sin_choferes' },

    { estado: 'solicitado', evento: 'cancelar_pasajero', actor: 'pasajero', nuevoEstado: 'cancelado_pasajero' },
    { estado: 'asignado', evento: 'cancelar_pasajero', actor: 'pasajero', nuevoEstado: 'cancelado_pasajero' },
    { estado: 'chofer_en_camino', evento: 'cancelar_pasajero', actor: 'pasajero', nuevoEstado: 'cancelado_pasajero' },

    { estado: 'asignado', evento: 'cancelar_chofer', actor: 'chofer', nuevoEstado: 'cancelado_chofer' },
    { estado: 'chofer_en_camino', evento: 'cancelar_chofer', actor: 'chofer', nuevoEstado: 'cancelado_chofer' },

    { estado: 'asignado', evento: 'salir_en_camino', actor: 'chofer', nuevoEstado: 'chofer_en_camino' },
    { estado: 'chofer_en_camino', evento: 'iniciar', actor: 'chofer', nuevoEstado: 'en_curso' },
    { estado: 'en_curso', evento: 'finalizar', actor: 'chofer', nuevoEstado: 'finalizado' },

    // Operador puede cancelar cualquier estado NO terminal. El destino se
    // registra como cancelado_pasajero y el historial guarda actor=operador y
    // el motivo (requiereMotivo: true).
    { estado: 'solicitado', evento: 'cancelar_operador', actor: 'operador', nuevoEstado: 'cancelado_pasajero', requiereMotivo: true },
    { estado: 'asignado', evento: 'cancelar_operador', actor: 'operador', nuevoEstado: 'cancelado_pasajero', requiereMotivo: true },
    { estado: 'chofer_en_camino', evento: 'cancelar_operador', actor: 'operador', nuevoEstado: 'cancelado_pasajero', requiereMotivo: true },
    { estado: 'en_curso', evento: 'cancelar_operador', actor: 'operador', nuevoEstado: 'cancelado_pasajero', requiereMotivo: true },
  ].map((fila) => Object.freeze(fila))
);

export function esEstadoTerminal(estado) {
  return ESTADOS_TERMINALES.includes(estado);
}

export function buscarTransicion(estado, evento) {
  return TRANSICIONES.find((t) => t.estado === estado && t.evento === evento) ?? null;
}

// Actor canonico de un evento. Devuelve null si el evento no existe.
export function actorDeEvento(evento) {
  const fila = TRANSICIONES.find((t) => t.evento === evento);
  return fila ? fila.actor : null;
}

function motivoValido(motivo) {
  return typeof motivo === 'string' && motivo.trim().length > 0;
}

// Devuelve un viaje NUEVO (sin mutar el original) o lanza un error de dominio.
export function aplicarTransicion(viaje, evento, actor, datos = {}) {
  if (viaje === null || typeof viaje !== 'object') {
    throw new ErrorDatosInvalidos('El viaje es obligatorio para aplicar una transicion.');
  }

  // 1) Evento desconocido: no puede ser una transicion valida.
  const actorEsperado = actorDeEvento(evento);
  if (actorEsperado === null) {
    throw new ErrorTransicionInvalida(viaje.estado, evento);
  }

  // 2) Actor equivocado: se rechaza explicitamente (no se ignora la transicion).
  if (actorEsperado !== actor) {
    throw new ErrorActorNoAutorizado(actor, evento, actorEsperado);
  }

  // 3) El par (estado, evento) debe existir en la tabla.
  const transicion = buscarTransicion(viaje.estado, evento);
  if (transicion === null) {
    throw new ErrorTransicionInvalida(viaje.estado, evento);
  }

  // 4) Motivo obligatorio (operador).
  if (transicion.requiereMotivo && !motivoValido(datos.motivo)) {
    throw new ErrorDatosInvalidos(`El evento '${evento}' requiere un motivo no vacio.`);
  }

  const historial = Array.isArray(viaje.historial) ? viaje.historial : [];
  const entrada = Object.freeze({
    evento,
    actor,
    desde: viaje.estado,
    hacia: transicion.nuevoEstado,
    motivo: motivoValido(datos.motivo) ? datos.motivo.trim() : null,
    // `en` lo aporta quien dispara (fecha/hora) para mantener la funcion pura
    // y determinista: el dominio no llama a Date.now().
    en: datos.en ?? null,
  });

  return {
    ...viaje,
    estado: transicion.nuevoEstado,
    historial: [...historial, entrada],
  };
}
