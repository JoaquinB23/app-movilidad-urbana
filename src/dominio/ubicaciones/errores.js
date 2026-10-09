// Errores de dominio del modulo de ubicaciones.
//
// Decision de diseno: igual que en el modulo de viajes, el dominio no conoce
// HTTP. Cada error lleva un `codigo` estable (string) para que la capa web lo
// traduzca a un status sin inspeccionar el mensaje. Se define una base propia
// (en vez de importar la de viajes) para que los modulos de dominio no se
// acoplen entre si: la composicion es la unica que conoce a los dos.

export class ErrorDominio extends Error {
  constructor(mensaje, codigo) {
    super(mensaje);
    this.name = new.target.name;
    this.codigo = codigo;
  }
}

// Datos de entrada invalidos (tipos, rangos, faltantes).
export class ErrorDatosInvalidos extends ErrorDominio {
  constructor(mensaje) {
    super(mensaje, 'DATOS_INVALIDOS');
  }
}

// Coordenada fuera de rango (lat en [-90,90], lng en [-180,180]) o no numerica.
export class ErrorCoordenadaInvalida extends ErrorDatosInvalidos {
  constructor(mensaje) {
    super(mensaje);
    this.codigo = 'COORDENADA_INVALIDA';
  }
}

// El actor autenticado no es dueno ni contraparte del recurso. La capa web lo
// traduce a 403 (o 404 si se prefiere no revelar la existencia del recurso).
export class ErrorRecursoAjeno extends ErrorDominio {
  constructor(recurso, actor) {
    super(
      `El actor '${actor}' no tiene acceso al recurso '${recurso}'.`,
      'RECURSO_AJENO'
    );
    this.recurso = recurso;
    this.actor = actor;
  }
}

// El recurso pedido no existe (o no es visible para el actor).
export class ErrorNoEncontrado extends ErrorDominio {
  constructor(recurso) {
    super(`No se encontro el recurso '${recurso}'.`, 'NO_ENCONTRADO');
    this.recurso = recurso;
  }
}

// Se intenta publicar/actualizar ubicacion de un chofer que no esta disponible.
// Es una regla de negocio: no se acepta tracking de quien no esta en servicio.
export class ErrorChoferNoDisponible extends ErrorDominio {
  constructor(choferId) {
    super(`El chofer '${choferId}' no esta disponible para enviar ubicacion.`, 'CHOFER_NO_DISPONIBLE');
    this.choferId = choferId;
  }
}
