// Regla de retencion del historial de ubicaciones.
//
// Vive en el dominio (no en los adaptadores) porque es una regla de negocio:
// `dias` es un entero positivo que representa la ventana de conservacion. Los
// adaptadores (PostgreSQL y memoria) y el worker la reutilizan, asi el mensaje y
// el codigo de error son los mismos sin importar donde se valide.

import { ErrorDatosInvalidos } from './errores.js';

export const RETENCION_DIAS_POR_DEFECTO = 90;

export function validarDiasRetencion(dias) {
  if (!Number.isInteger(dias) || dias <= 0) {
    throw new ErrorDatosInvalidos(
      `'dias' debe ser un entero positivo; se recibio ${JSON.stringify(dias)}.`
    );
  }
  return dias;
}
