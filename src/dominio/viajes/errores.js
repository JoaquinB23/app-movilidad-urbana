// Errores de dominio del modulo de viajes.
//
// Decision de diseno: el dominio no conoce HTTP. Cada error lleva un `codigo`
// estable (string) para que la capa web lo traduzca a un status sin tener que
// inspeccionar el mensaje. Asi el mapeo HTTP vive SOLO en infra/http y el
// dominio queda libre de express.

export class ErrorDominio extends Error {
  constructor(mensaje, codigo) {
    super(mensaje);
    this.name = new.target.name;
    this.codigo = codigo;
  }
}

// Se lanza cuando (estado, evento) no existe en la tabla de transiciones.
export class ErrorTransicionInvalida extends ErrorDominio {
  constructor(estadoActual, evento) {
    super(
      `Transicion invalida: no se puede aplicar '${evento}' desde '${estadoActual}'.`,
      'TRANSICION_INVALIDA'
    );
    this.estadoActual = estadoActual;
    this.evento = evento;
  }
}

// Se lanza cuando el actor que dispara no es el que el evento exige.
// Se valida ANTES de mirar el estado para dar un error preciso (por ejemplo un
// pasajero intentando 'iniciar').
export class ErrorActorNoAutorizado extends ErrorDominio {
  constructor(actor, evento, actorEsperado) {
    super(
      `Actor '${actor}' no autorizado para '${evento}': se esperaba '${actorEsperado}'.`,
      'ACTOR_NO_AUTORIZADO'
    );
    this.actor = actor;
    this.evento = evento;
    this.actorEsperado = actorEsperado;
  }
}

// Error de validacion de datos de entrada del dominio (campos faltantes,
// tipos o rangos invalidos). Distinto de una transicion invalida.
export class ErrorDatosInvalidos extends ErrorDominio {
  constructor(mensaje) {
    super(mensaje, 'DATOS_INVALIDOS');
  }
}

// La distancia supera el maximo configurado: no se puede cotizar el viaje.
export class ErrorViajeFueraDeLimite extends ErrorDominio {
  constructor(distanciaMetros, distanciaMaximaMetros) {
    super(
      `La distancia ${distanciaMetros} m supera el maximo permitido de ${distanciaMaximaMetros} m.`,
      'VIAJE_FUERA_DE_LIMITE'
    );
    this.distanciaMetros = distanciaMetros;
    this.distanciaMaximaMetros = distanciaMaximaMetros;
  }
}
