// Calculo de tarifa del viaje (modulo de dominio, sin dependencias externas).
//
// Decisiones de diseno (defendibles):
// 1) TODO se maneja en ENTEROS (centavos y segundos/metros). Nunca floats para
//    dinero: evita errores de coma flotante en importes.
// 2) Redondeo: al entero mas cercano con MITAD HACIA ARRIBA (half-up). Como
//    todos los operandos son no negativos, Math.round implementa exactamente
//    ese criterio. Se aplica por componente (distancia y tiempo), no al total,
//    para que el desglose sea consistente con el total.
// 3) La tarifa final nunca es menor a `tarifaMinimaCentavos`. La estimacion
//    previa y la tarifa final usan ESTA MISMA funcion (mismos parametros).
// 4) La validacion es del dominio: negativos, no enteros o parametros faltantes
//    lanzan ErrorDatosInvalidos; superar la distancia maxima lanza
//    ErrorViajeFueraDeLimite.

import { ErrorDatosInvalidos, ErrorViajeFueraDeLimite } from './errores.js';

function exigirEnteroNoNegativo(valor, nombre) {
  if (!Number.isInteger(valor) || valor < 0) {
    throw new ErrorDatosInvalidos(
      `'${nombre}' debe ser un entero no negativo; se recibio ${JSON.stringify(valor)}.`
    );
  }
}

function validarParametros(parametros) {
  if (parametros === null || typeof parametros !== 'object') {
    throw new ErrorDatosInvalidos('Los parametros de tarifa son obligatorios.');
  }
  exigirEnteroNoNegativo(parametros.tarifaBaseCentavos, 'tarifaBaseCentavos');
  exigirEnteroNoNegativo(parametros.porKmCentavos, 'porKmCentavos');
  exigirEnteroNoNegativo(parametros.porMinutoCentavos, 'porMinutoCentavos');
  exigirEnteroNoNegativo(parametros.tarifaMinimaCentavos, 'tarifaMinimaCentavos');
  if (!Number.isInteger(parametros.distanciaMaximaMetros) || parametros.distanciaMaximaMetros <= 0) {
    throw new ErrorDatosInvalidos(
      `'distanciaMaximaMetros' debe ser un entero positivo; se recibio ${JSON.stringify(parametros.distanciaMaximaMetros)}.`
    );
  }
}

// Redondeo half-up. Valido porque los operandos son no negativos.
function redondearMitadHaciaArriba(valor) {
  return Math.round(valor);
}

export function calcularTarifa({ distanciaMetros, duracionSegundos, parametros } = {}) {
  exigirEnteroNoNegativo(distanciaMetros, 'distanciaMetros');
  exigirEnteroNoNegativo(duracionSegundos, 'duracionSegundos');
  validarParametros(parametros);

  const {
    tarifaBaseCentavos,
    porKmCentavos,
    porMinutoCentavos,
    tarifaMinimaCentavos,
    distanciaMaximaMetros,
  } = parametros;

  // Se rechaza antes de cotizar: el borde exacto (== maximo) es valido.
  if (distanciaMetros > distanciaMaximaMetros) {
    throw new ErrorViajeFueraDeLimite(distanciaMetros, distanciaMaximaMetros);
  }

  // Multiplico primero (enteros) y divido al final para concentrar el redondeo.
  const porDistanciaCentavos = redondearMitadHaciaArriba(
    (distanciaMetros * porKmCentavos) / 1000
  );
  const porTiempoCentavos = redondearMitadHaciaArriba(
    (duracionSegundos * porMinutoCentavos) / 60
  );

  const subtotalCentavos = tarifaBaseCentavos + porDistanciaCentavos + porTiempoCentavos;
  const totalCentavos = Math.max(subtotalCentavos, tarifaMinimaCentavos);
  const ajusteTarifaMinimaCentavos = totalCentavos - subtotalCentavos;

  return {
    totalCentavos,
    desglose: {
      tarifaBaseCentavos,
      porDistanciaCentavos,
      porTiempoCentavos,
      subtotalCentavos,
      ajusteTarifaMinimaCentavos,
      totalCentavos,
    },
  };
}
