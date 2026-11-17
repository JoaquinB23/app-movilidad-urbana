// Repositorio transaccional de la reasignación (variante H). Se instancia
// DENTRO de transaccion-pg: todas sus consultas corren en la transacción del
// caso de uso reasignarViaje.

export const SQL_ELEGIR_CANDIDATO = `
  SELECT c.usuario_id
  FROM choferes c
  JOIN ubicaciones_actuales ua ON ua.chofer_id = c.usuario_id
  WHERE c.habilitado = true
    AND c.disponible = true
    AND c.usuario_id <> $1
    AND NOT EXISTS (
      SELECT 1 FROM asignaciones_viaje a
      WHERE a.chofer_id = c.usuario_id AND a.hasta IS NULL
    )
    AND ST_DWithin(ua.geom, ST_MakePoint($3, $2)::geography, $4)
  ORDER BY ST_Distance(ua.geom, ST_MakePoint($3, $2)::geography)
  FOR UPDATE OF c SKIP LOCKED
  LIMIT 1
`;

// Viajes cuyo chofer asignado no reporta hace más del umbral (o nunca reportó
// desde que se le asignó). FOR UPDATE SKIP LOCKED sobre el viaje: dos corridas
// del worker (o el worker y un rechazar-continuar) nunca procesan el mismo
// viaje, y nadie espera locks ajenos.
export const SQL_VIAJES_CON_CHOFER_INACTIVO = `
  SELECT v.id AS viaje_id, a.chofer_id,
         EXTRACT(EPOCH FROM (now() - COALESCE(ua.timestamp, a.desde))) AS segundos_sin_reportar
  FROM viajes v
  JOIN asignaciones_viaje a ON a.viaje_id = v.id AND a.hasta IS NULL
  LEFT JOIN ubicaciones_actuales ua ON ua.chofer_id = a.chofer_id
  WHERE v.estado IN ('asignado', 'chofer_en_camino')
    AND COALESCE(ua.timestamp, a.desde) < now() - make_interval(secs => $1)
  ORDER BY COALESCE(ua.timestamp, a.desde) ASC
  FOR UPDATE OF v SKIP LOCKED
  LIMIT $2
`;

export function crearRepositorioReasignacionPg({ consulta }) {
  return {
    async elegirCandidato({ origen, excluirChoferId, radioM }) {
      const { rows } = await consulta(SQL_ELEGIR_CANDIDATO, [
        excluirChoferId,
        origen.lat,
        origen.lng,
        radioM,
      ]);
      return rows[0] ? { id: rows[0].usuario_id } : null;
    },

    // Segundos desde el último reporte del chofer, o null si nunca reportó.
    // Lo usa reasignarViaje para REVALIDAR el umbral dentro de la transacción.
    async segundosSinReportar(choferId) {
      const { rows } = await consulta(
        `SELECT EXTRACT(EPOCH FROM (now() - timestamp)) AS segundos
         FROM ubicaciones_actuales WHERE chofer_id = $1`,
        [choferId]
      );
      return rows[0] ? Number(rows[0].segundos) : null;
    },

    async detectarViajesConChoferInactivo({ umbralS, limite = 20 }) {
      const { rows } = await consulta(SQL_VIAJES_CON_CHOFER_INACTIVO, [umbralS, limite]);
      return rows.map((fila) => ({
        viajeId: fila.viaje_id,
        choferId: fila.chofer_id,
        segundosSinReportar: Number(fila.segundos_sin_reportar),
      }));
    },
  };
}
