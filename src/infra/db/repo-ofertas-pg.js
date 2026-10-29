function mapearOferta(fila) {
  if (!fila) return null;
  return {
    id: fila.id,
    viajeId: fila.viaje_id,
    choferId: fila.chofer_id,
    estado: fila.estado,
    orden: Number(fila.orden),
    expiraEn: fila.expira_en,
    creadaEn: fila.creada_en,
    respondidaEn: fila.respondida_en,
  };
}

export const SQL_BUSCAR_OFERTA_PARA_ACTUALIZAR = `
  SELECT * FROM ofertas_viaje WHERE id = $1 FOR UPDATE
`;

export const SQL_CANCELAR_OFERTAS_PENDIENTES = `
  UPDATE ofertas_viaje
  SET estado = 'cancelada', respondida_en = $3
  WHERE viaje_id = $1 AND id <> $2 AND estado = 'pendiente'
`;

export function crearRepositorioOfertasPg({ consulta }) {
  return {
    async crear(oferta) {
      const { rows } = await consulta(
        `INSERT INTO ofertas_viaje (
          id, viaje_id, chofer_id, estado, orden, expira_en, creada_en, respondida_en
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          oferta.id,
          oferta.viajeId,
          oferta.choferId,
          oferta.estado,
          oferta.orden,
          oferta.expiraEn,
          oferta.creadaEn,
          oferta.respondidaEn,
        ]
      );
      return mapearOferta(rows[0]);
    },
    async buscarPorId(id) {
      const { rows } = await consulta('SELECT * FROM ofertas_viaje WHERE id = $1', [id]);
      return mapearOferta(rows[0]);
    },
    async buscarPorIdParaActualizar(id) {
      const { rows } = await consulta(SQL_BUSCAR_OFERTA_PARA_ACTUALIZAR, [id]);
      return mapearOferta(rows[0]);
    },
    async actualizar(oferta) {
      const { rows } = await consulta(
        `UPDATE ofertas_viaje
         SET estado = $2, respondida_en = $3
         WHERE id = $1
         RETURNING *`,
        [oferta.id, oferta.estado, oferta.respondidaEn]
      );
      return mapearOferta(rows[0]);
    },
    async cancelarPendientesPorViaje(viajeId, exceptoOfertaId, respondidaEn) {
      await consulta(SQL_CANCELAR_OFERTAS_PENDIENTES, [
        viajeId,
        exceptoOfertaId,
        respondidaEn,
      ]);
    },
  };
}
