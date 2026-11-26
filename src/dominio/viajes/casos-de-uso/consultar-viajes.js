// Consultas de lectura de Viajes: historial del pasajero, historial del
// chofer, panel del operador (viajes en curso) y eventos de un viaje.
// Todas con autorizacion por rol y, cuando hay recurso, por recurso.

import { ErrorActorNoAutorizado, ErrorDatosInvalidos, ErrorViajeNoEncontrado } from '../errores.js';

const LIMITE_MAXIMO = 100;

function limiteValido(limite) {
  const valor = limite ?? 20;
  if (!Number.isInteger(valor) || valor < 1 || valor > LIMITE_MAXIMO) {
    throw new ErrorDatosInvalidos(`El limite debe ser un entero entre 1 y ${LIMITE_MAXIMO}.`);
  }
  return valor;
}

export function crearConsultasViajes({ repositorioViajes, repositorioAsignaciones }) {
  for (const metodo of ['listarPorPasajero', 'listarPorChofer', 'listarActivos', 'buscarPorId']) {
    if (typeof repositorioViajes?.[metodo] !== 'function') {
      throw new ErrorDatosInvalidos(`Falta RepositorioViajes.${metodo}.`);
    }
  }
  if (typeof repositorioAsignaciones?.listarPorViaje !== 'function') {
    throw new ErrorDatosInvalidos('Falta RepositorioAsignaciones.listarPorViaje.');
  }

  return {
    // Historial propio del pasajero (los ids vienen del token, nunca del cliente).
    async historialPasajero({ actor, limite }) {
      if (actor?.rol !== 'pasajero') throw new ErrorActorNoAutorizado(actor?.rol, 'historial_pasajero', 'pasajero');
      return repositorioViajes.listarPorPasajero(actor.id, limiteValido(limite));
    },

    // Historial del chofer: todo viaje en el que tuvo una asignacion, incluso
    // si despues se lo reasignaron (variante H: el historial conserva todos).
    async historialChofer({ actor, limite }) {
      if (actor?.rol !== 'chofer') throw new ErrorActorNoAutorizado(actor?.rol, 'historial_chofer', 'chofer');
      return repositorioViajes.listarPorChofer(actor.id, limiteValido(limite));
    },

    // Panel del operador: viajes no terminales, opcionalmente de un estado.
    async viajesEnCurso({ actor, estado, limite }) {
      if (actor?.rol !== 'operador' && actor?.rol !== 'administrador') {
        throw new ErrorActorNoAutorizado(actor?.rol, 'panel_operador', 'operador');
      }
      return repositorioViajes.listarActivos({ estado: estado ?? null, limite: limiteValido(limite) });
    },

    // Eventos del viaje (quien hizo que, cuando, por que). Lo ven el pasajero
    // dueno, quien sea o haya sido su chofer, operador y administrador.
    async eventosDeViaje({ actor, viajeId }) {
      const viaje = await repositorioViajes.buscarPorId(viajeId);
      if (!viaje) throw new ErrorViajeNoEncontrado();
      let permitido = actor?.rol === 'operador' || actor?.rol === 'administrador' ||
        (actor?.rol === 'pasajero' && actor.id === viaje.pasajeroId);
      if (!permitido && actor?.rol === 'chofer') {
        const asignaciones = await repositorioAsignaciones.listarPorViaje(viaje.id);
        permitido = asignaciones.some((a) => a.choferId === actor.id);
      }
      if (!permitido) throw new ErrorViajeNoEncontrado();
      return viaje.historial.map(({ evento, actor: tipo, desde, hacia, motivo, en }) => ({
        evento, actor: tipo, desde, hacia, motivo, en,
      }));
    },
  };
}
