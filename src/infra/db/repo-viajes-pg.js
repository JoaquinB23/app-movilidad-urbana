function mapearViaje(fila) {
  if (!fila) return null;
  return {
    id: fila.id,
    pasajeroId: fila.pasajero_id,
    estado: fila.estado,
    origen: { lat: Number(fila.origen_lat), lng: Number(fila.origen_lng) },
    destino: { lat: Number(fila.destino_lat), lng: Number(fila.destino_lng) },
    distanciaEstimadaMetros: Number(fila.distancia_estimada_m),
    duracionEstimadaSegundos: Number(fila.duracion_estimada_s),
    tarifaEstimadaCentavos: Number(fila.tarifa_estimada_centavos),
    tarifaFinalCentavos:
      fila.tarifa_final_centavos === null ? null : Number(fila.tarifa_final_centavos),
    motivoCierre: fila.motivo_cierre,
    creadoEn: fila.creado_en,
    actualizadoEn: fila.actualizado_en,
    historial: [],
  };
}

export const SQL_GUARDAR_VIAJE = `
  INSERT INTO viajes (
    id, pasajero_id, estado, origen_lat, origen_lng, destino_lat, destino_lng,
    distancia_estimada_m, duracion_estimada_s, tarifa_estimada_centavos,
    tarifa_final_centavos, motivo_cierre, creado_en, actualizado_en
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
  ON CONFLICT (id) DO UPDATE SET
    estado = EXCLUDED.estado,
    tarifa_final_centavos = EXCLUDED.tarifa_final_centavos,
    motivo_cierre = EXCLUDED.motivo_cierre,
    actualizado_en = EXCLUDED.actualizado_en
  RETURNING *
`;

export const SQL_BUSCAR_VIAJE_PARA_ACTUALIZAR = `
  SELECT * FROM viajes WHERE id = $1 FOR UPDATE
`;

export const SQL_REGISTRAR_EVENTO_VIAJE = `
  INSERT INTO viajes_eventos (
    viaje_id, evento, actor_tipo, actor_id, estado_anterior, estado_nuevo, motivo, en
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  RETURNING id, viaje_id, evento, actor_tipo, actor_id, estado_anterior, estado_nuevo, motivo, en
`;

export const SQL_HISTORIAL_EVENTOS_VIAJE = `
  SELECT evento, actor_tipo, estado_anterior, estado_nuevo, motivo, en
  FROM viajes_eventos
  WHERE viaje_id = $1
  ORDER BY en ASC, id ASC
`;

export function crearRepositorioViajesPg({ consulta }) {
  async function buscar(id, sql) {
    const { rows } = await consulta(sql, [id]);
    if (!rows[0]) return null;
    const viaje = mapearViaje(rows[0]);
    const eventos = await consulta(SQL_HISTORIAL_EVENTOS_VIAJE, [id]);
    viaje.historial = eventos.rows.map((fila) => ({
      evento: fila.evento,
      actor: fila.actor_tipo,
      desde: fila.estado_anterior,
      hacia: fila.estado_nuevo,
      motivo: fila.motivo,
      en: fila.en,
    }));
    return viaje;
  }

  return {
    async guardar(viaje) {
      const valores = [
        viaje.id,
        viaje.pasajeroId,
        viaje.estado,
        viaje.origen.lat,
        viaje.origen.lng,
        viaje.destino.lat,
        viaje.destino.lng,
        viaje.distanciaEstimadaMetros,
        viaje.duracionEstimadaSegundos,
        viaje.tarifaEstimadaCentavos,
        viaje.tarifaFinalCentavos,
        viaje.motivoCierre,
        viaje.creadoEn,
        viaje.actualizadoEn,
      ];
      const { rows } = await consulta(SQL_GUARDAR_VIAJE, valores);
      return mapearViaje(rows[0]);
    },
    async buscarPorId(id) {
      return buscar(id, 'SELECT * FROM viajes WHERE id = $1');
    },
    async buscarPorIdParaActualizar(id) {
      return buscar(id, SQL_BUSCAR_VIAJE_PARA_ACTUALIZAR);
    },
    async registrarEvento(evento) {
      const valores = [
        evento.viajeId,
        evento.evento,
        evento.actorTipo,
        evento.actorId,
        evento.estadoAnterior,
        evento.estadoNuevo,
        evento.motivo,
        evento.en,
      ];
      const { rows } = await consulta(SQL_REGISTRAR_EVENTO_VIAJE, valores);
      return {
        id: rows[0].id,
        viajeId: rows[0].viaje_id,
        evento: rows[0].evento,
        actorTipo: rows[0].actor_tipo,
        actorId: rows[0].actor_id,
        estadoAnterior: rows[0].estado_anterior,
        estadoNuevo: rows[0].estado_nuevo,
        motivo: rows[0].motivo,
        en: rows[0].en,
      };
    },
  };
}
