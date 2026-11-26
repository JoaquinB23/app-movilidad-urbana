// Busqueda continua de chofer (regla de dominio, sin infraestructura).
//
// Un viaje sin chofer no se da por perdido enseguida: sigue "solicitado"
// mientras no haya pasado tiempoBusquedaSegundos desde que se pidio. Con 0 (o
// sin el parametro) se vuelve al comportamiento anterior: sin_choferes en
// cuanto se agota la lista de candidatos.

export function sigueBuscando(viaje, parametros, ahora) {
  const limite = Number(parametros?.tiempoBusquedaSegundos ?? 0);
  if (!(limite > 0) || !viaje?.creadoEn) return false;
  return ahora.getTime() - new Date(viaje.creadoEn).getTime() < limite * 1000;
}
