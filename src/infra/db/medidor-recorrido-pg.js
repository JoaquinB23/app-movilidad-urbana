// Puerto MedidorRecorrido sobre PostGIS: distancia REALMENTE recorrida en un
// viaje, a partir del historial de ubicaciones del chofer desde que se inicio.
// Lo usa la tarifa final (transicionarViaje, evento finalizar).
//
// ST_MakeLine arma la polilinea ordenada por tiempo y ST_Length sobre
// geography la mide en METROS sobre el elipsoide. Con menos de dos puntos no
// hay recorrido medible y se devuelve null: la tarifa usa la distancia
// estimada (y la diferencia queda explicada por eso).

export const SQL_DISTANCIA_RECORRIDA = `
  SELECT count(*)::int AS puntos,
         ST_Length(ST_MakeLine(geom::geometry ORDER BY timestamp)::geography) AS metros
  FROM ubicaciones_historial
  WHERE viaje_id = $1 AND timestamp >= $2
`;

export function crearMedidorRecorridoPg({ consulta }) {
  return {
    async distanciaRecorridaMetros(viajeId, desde) {
      const { rows } = await consulta(SQL_DISTANCIA_RECORRIDA, [viajeId, desde]);
      if (!rows[0] || rows[0].puntos < 2 || rows[0].metros === null) return null;
      return Math.round(Number(rows[0].metros));
    },
  };
}
