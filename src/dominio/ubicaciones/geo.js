// Geometria y validacion geografica (dominio puro, sin dependencias externas).
//
// Decisiones de diseno (defendibles):
// 1) El dominio solo entiende latitud/longitud en grados (WGS84) y distancias en
//    METROS. No conoce tipos de PostGIS (geometry/geography) ni de otras
//    librerias: eso vive en los adaptadores.
// 2) La formula de Haversine modela la Tierra como esfera. Para distancias
//    urbanas (radio de pocos km) el error frente a un elipsoide es despreciable
//    (menor al 0.5%) y es determinista, lo que permite testear la seleccion de
//    candidatos sin base de datos. El adaptador PostGIS usa `geography`, que
//    calcula sobre elipsoide; por eso los adaptadores pueden diferir en metros
//    de borde y los tests de integracion usan tolerancia.
// 3) Se usa el radio medio terrestre de la IUGG. Al ser una constante
//    documentada, cambiar el modelo es un solo punto de cambio.

import { ErrorCoordenadaInvalida, ErrorDatosInvalidos } from './errores.js';

// Radio medio terrestre segun la Union Geodesica y Geofisica Internacional.
export const RADIO_MEDIO_TIERRA_METROS = 6371008.8;

export function esLatitudValida(lat) {
  return typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90;
}

export function esLongitudValida(lng) {
  return typeof lng === 'number' && Number.isFinite(lng) && lng >= -180 && lng <= 180;
}

// Normaliza y valida un punto. Devuelve SIEMPRE un objeto nuevo {lat, lng} para
// no exponer la referencia del llamador (evita mutaciones externas).
export function validarPunto(punto) {
  if (punto === null || typeof punto !== 'object') {
    throw new ErrorCoordenadaInvalida('La ubicacion debe ser un objeto {lat, lng}.');
  }
  const { lat, lng } = punto;
  if (!esLatitudValida(lat)) {
    throw new ErrorCoordenadaInvalida(`'lat' fuera de rango o no numerica: ${JSON.stringify(lat)}.`);
  }
  if (!esLongitudValida(lng)) {
    throw new ErrorCoordenadaInvalida(`'lng' fuera de rango o no numerica: ${JSON.stringify(lng)}.`);
  }
  return { lat, lng };
}

function aRadianes(grados) {
  return (grados * Math.PI) / 180;
}

// Distancia de gran circulo entre dos puntos, en metros. Acepta objetos
// {lat,lng} ya validados o crudos: valida igual para fallar rapido.
export function distanciaHaversineMetros(a, b) {
  const p1 = validarPunto(a);
  const p2 = validarPunto(b);

  const dLat = aRadianes(p2.lat - p1.lat);
  const dLng = aRadianes(p2.lng - p1.lng);
  const lat1 = aRadianes(p1.lat);
  const lat2 = aRadianes(p2.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  // clamp por seguridad numerica: asin podria recibir 1+epsilon y dar NaN.
  const c = 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  return RADIO_MEDIO_TIERRA_METROS * c;
}

// Valida el radio de busqueda: numero positivo (en metros). Se permite decimal
// porque un radio de 1500.5 m es valido; lo que NO se acepta es <= 0 ni NaN.
export function validarRadio(radioMetros) {
  if (typeof radioMetros !== 'number' || !Number.isFinite(radioMetros) || radioMetros <= 0) {
    throw new ErrorDatosInvalidos(
      `'radio' debe ser un numero positivo en metros; se recibio ${JSON.stringify(radioMetros)}.`
    );
  }
  return radioMetros;
}

// El limite de resultados debe ser un entero positivo.
export function validarLimite(limite) {
  if (!Number.isInteger(limite) || limite <= 0) {
    throw new ErrorDatosInvalidos(
      `'limite' debe ser un entero positivo; se recibio ${JSON.stringify(limite)}.`
    );
  }
  return limite;
}
