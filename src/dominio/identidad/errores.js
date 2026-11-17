// Errores de dominio del módulo de identidad. Mismo contrato que el resto del
// proyecto: cada error lleva un `codigo` estable y la capa HTTP lo traduce a un
// status. El dominio no conoce HTTP.

export class ErrorIdentidad extends Error {
  constructor(mensaje, codigo) {
    super(mensaje);
    this.name = new.target.name;
    this.codigo = codigo;
  }
}

export class ErrorDatosInvalidos extends ErrorIdentidad {
  constructor(mensaje) {
    super(mensaje, 'DATOS_INVALIDOS');
  }
}

// Un solo código para "email ya usado" y "credenciales malas" allí donde
// corresponda no revelar existencia de cuentas.
export class ErrorCredencialesInvalidas extends ErrorIdentidad {
  constructor() {
    super('Email o contraseña incorrectos.', 'CREDENCIALES_INVALIDAS');
  }
}

export class ErrorEmailEnUso extends ErrorIdentidad {
  constructor() {
    super('El email ya está registrado.', 'EMAIL_EN_USO');
  }
}

export class ErrorPatenteEnUso extends ErrorIdentidad {
  constructor() {
    super('La patente ya está registrada.', 'PATENTE_EN_USO');
  }
}

export class ErrorNoEncontrado extends ErrorIdentidad {
  constructor(mensaje = 'El recurso solicitado no fue encontrado.') {
    super(mensaje, 'NO_ENCONTRADO');
  }
}

// Cuenta desactivada o chofer no habilitado intentando operar.
export class ErrorCuentaInactiva extends ErrorIdentidad {
  constructor() {
    super('La cuenta está desactivada.', 'CUENTA_INACTIVA');
  }
}
