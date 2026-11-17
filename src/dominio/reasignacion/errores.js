// Errores de dominio del módulo de reasignación (variante H).

import { ErrorDominio } from '../viajes/errores.js';

export class ErrorReasignacion extends ErrorDominio {}

// El viaje no está en un estado reasignable o no existe asignación abierta.
export class ErrorViajeNoReasignable extends ErrorReasignacion {
  constructor(mensaje = 'El viaje no admite reasignación en su estado actual.') {
    super(mensaje, 'VIAJE_NO_REASIGNABLE');
  }
}

// No hay ningún chofer candidato disponible en este momento. La asignación
// vigente NO se cierra: cerrar sin reemplazo dejaría al pasajero sin chofer
// y la máquina de estados de viajes no tiene una vuelta desde 'asignado' a
// 'solicitado'. El worker reintenta en el próximo ciclo.
export class ErrorSinCandidatos extends ErrorReasignacion {
  constructor() {
    super('No hay choferes disponibles para reasignar el viaje.', 'SIN_CANDIDATOS');
  }
}
