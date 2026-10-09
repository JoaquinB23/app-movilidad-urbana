import { ErrorDatosInvalidos } from '../errores.js';
import { calcularTarifa } from '../tarifa.js';

function validarPunto(punto, nombre) {
  if (
    punto === null ||
    typeof punto !== 'object' ||
    !Number.isFinite(punto.lat) ||
    punto.lat < -90 ||
    punto.lat > 90 ||
    !Number.isFinite(punto.lng) ||
    punto.lng < -180 ||
    punto.lng > 180
  ) {
    throw new ErrorDatosInvalidos(`'${nombre}' debe contener latitud y longitud válidas.`);
  }
}

export function crearEstimarViaje({ estimadorRuta, parametrosViajes }) {
  if (!estimadorRuta || typeof estimadorRuta.estimar !== 'function') {
    throw new ErrorDatosInvalidos('El estimador de ruta es obligatorio.');
  }
  if (!parametrosViajes || typeof parametrosViajes.obtener !== 'function') {
    throw new ErrorDatosInvalidos('Los parámetros de viajes son obligatorios.');
  }

  return async function estimarViaje({ origen, destino } = {}) {
    validarPunto(origen, 'origen');
    validarPunto(destino, 'destino');

    const [ruta, parametros] = await Promise.all([
      estimadorRuta.estimar(origen, destino),
      parametrosViajes.obtener(),
    ]);
    const tarifa = calcularTarifa({
      distanciaMetros: ruta.distanciaMetros,
      duracionSegundos: ruta.duracionSegundos,
      parametros: parametros.tarifa,
    });

    return {
      distanciaMetros: ruta.distanciaMetros,
      duracionSegundos: ruta.duracionSegundos,
      precioCentavos: tarifa.totalCentavos,
      tarifa,
    };
  };
}

export { validarPunto };
