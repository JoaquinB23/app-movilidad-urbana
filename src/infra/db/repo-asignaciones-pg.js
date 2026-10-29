function mapearAsignacion(fila) {
  if (!fila) return null;
  return {
    id: fila.id,
    viajeId: fila.viaje_id,
    choferId: fila.chofer_id,
    desde: fila.desde,
    hasta: fila.hasta,
    motivoFin: fila.motivo_fin,
  };
}

export const SQL_BUSCAR_ASIGNACION_ABIERTA_POR_VIAJE = `
  SELECT id, viaje_id, chofer_id, desde, hasta, motivo_fin
  FROM asignaciones_viaje
  WHERE viaje_id = $1 AND hasta IS NULL
`;

export const SQL_BUSCAR_ASIGNACION_ABIERTA_POR_CHOFER = `
  SELECT id, viaje_id, chofer_id, desde, hasta, motivo_fin
  FROM asignaciones_viaje
  WHERE chofer_id = $1 AND hasta IS NULL
`;

export function crearRepositorioAsignacionesPg({ consulta }) {
  async function buscarAbierta(sql, id) {
    const { rows } = await consulta(sql, [id]);
    return mapearAsignacion(rows[0]);
  }

  return {
    async abrir(asignacion) {
      const { rows } = await consulta(
        `INSERT INTO asignaciones_viaje (id, viaje_id, chofer_id, desde, hasta, motivo_fin)
         VALUES ($1, $2, $3, $4, NULL, NULL)
         RETURNING id, viaje_id, chofer_id, desde, hasta, motivo_fin`,
        [asignacion.id, asignacion.viajeId, asignacion.choferId, asignacion.desde]
      );
      return mapearAsignacion(rows[0]);
    },
    async cerrar(id, motivo) {
      const { rows } = await consulta(
        `UPDATE asignaciones_viaje
         SET hasta = $2, motivo_fin = $3
         WHERE id = $1 AND hasta IS NULL
         RETURNING id, viaje_id, chofer_id, desde, hasta, motivo_fin`,
        [id, new Date(), motivo ?? null]
      );
      return mapearAsignacion(rows[0]);
    },
    buscarAbiertaPorViaje: (viajeId) =>
      buscarAbierta(SQL_BUSCAR_ASIGNACION_ABIERTA_POR_VIAJE, viajeId),
    buscarAbiertaPorChofer: (choferId) =>
      buscarAbierta(SQL_BUSCAR_ASIGNACION_ABIERTA_POR_CHOFER, choferId),
  };
}
