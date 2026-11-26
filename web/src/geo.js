// Distancia en linea recta (haversine), solo para mostrar en pantalla. Los
// calculos que importan (tarifa, candidatos) los hace el servidor.
const RADIO_TIERRA_METROS = 6_371_000;
const rad = (grados) => (grados * Math.PI) / 180;

export function distanciaMetros(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * RADIO_TIERRA_METROS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function formatearDistancia(metros) {
  return metros < 1000 ? `${Math.round(metros / 10) * 10} m` : `${(metros / 1000).toFixed(1)} km`;
}
