// Ids DETERMINISTICOS de los choferes de carga. El seed de carga y el
// simulador calculan el mismo UUID para el chofer i sin compartir archivos:
// con eso el simulador firma su JWT ({ sub: id, rol: 'chofer' }) y la base
// reconoce al chofer.
//
// Formato UUID v4 valido (version 4, variante 8): pasa la validacion
// z.uuid() de las rutas y el tipo UUID de PostgreSQL. El prefijo 5a3c0000
// los distingue a simple vista de los usuarios reales.

export const MAX_CHOFERES_CARGA = 0xffffffff;

export function idChoferCarga(indice) {
  if (!Number.isInteger(indice) || indice < 0 || indice > MAX_CHOFERES_CARGA) {
    throw new RangeError(`Indice de chofer de carga invalido: ${indice}`);
  }
  return `5a3c0000-0000-4000-8000-${indice.toString(16).padStart(12, '0')}`;
}

// Pasajeros de carga (k6 pide viajes con ellos): mismo esquema, otro prefijo.
export function idPasajeroCarga(indice) {
  if (!Number.isInteger(indice) || indice < 0 || indice > MAX_CHOFERES_CARGA) {
    throw new RangeError(`Indice de pasajero de carga invalido: ${indice}`);
  }
  return `5a3c0001-0000-4000-8000-${indice.toString(16).padStart(12, '0')}`;
}

export function emailPasajeroCarga(indice) {
  return `carga-pasajero-${indice}@carga.invalid`;
}

export function emailChoferCarga(indice) {
  return `carga-chofer-${indice}@carga.invalid`;
}

export function patenteChoferCarga(indice) {
  // choferes.patente es VARCHAR(10) y UNIQUE.
  return `SIM${String(indice).padStart(7, '0')}`;
}
