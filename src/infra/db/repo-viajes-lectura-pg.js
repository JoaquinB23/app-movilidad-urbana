// Adaptador PostgreSQL de SOLO LECTURA del puerto RepositorioViajes de
// ubicaciones (src/dominio/ubicaciones/puertos.js): buscarPorId y
// buscarActivoPorChofer, ambos con el chofer ASIGNADO.
//
// Por que un adaptador aparte y no ampliar repo-viajes-pg.js:
//   * El chofer actual vive en asignaciones_viaje (fila con hasta IS NULL), no
//     en viajes. Hace falta un LEFT JOIN, y repo-viajes-pg se usa dentro de la
//     transaccion de aceptarOferta con SELECT ... FOR UPDATE: PostgreSQL no
//     permite FOR UPDATE sobre el lado nullable de un outer join, y cambiar la
//     forma de ese repo arriesga el bloqueo ordenado del modulo de viajes.
//   * Ubicaciones solo necesita una vista de lectura; mantenerla separada deja
//     el contrato de viajes intacto.
//
// La asignacion CERRADA no cuenta: tras una reasignacion (variante H) el chofer
// anterior deja de ser el chofer del viaje y pierde acceso al seguimiento.

const ESTADOS_ACTIVOS = ['asignado', 'chofer_en_camino', 'en_curso'];

const SQL_VIAJE_CON_CHOFER = `
  SELECT v.id, v.pasajero_id, v.estado, v.origen_lat, v.origen_lng, a.chofer_id
  FROM viajes v
  LEFT JOIN asignaciones_viaje a ON a.viaje_id = v.id AND a.hasta IS NULL
`;

export const SQL_BUSCAR_VIAJE_CON_CHOFER = `${SQL_VIAJE_CON_CHOFER} WHERE v.id = $1`;

// Usa el indice unico parcial asignaciones_viaje_una_abierta_por_chofer_idx:
// a lo sumo una fila, consulta indexada (corre en cada POST /ubicacion).
export const SQL_BUSCAR_ACTIVO_POR_CHOFER = `
  SELECT v.id, v.pasajero_id, v.estado, v.origen_lat, v.origen_lng, a.chofer_id
  FROM asignaciones_viaje a
  JOIN viajes v ON v.id = a.viaje_id
  WHERE a.chofer_id = $1 AND a.hasta IS NULL AND v.estado = ANY($2::text[])
  LIMIT 1
`;

function mapear(fila) {
  if (!fila) return null;
  return {
    id: fila.id,
    pasajeroId: fila.pasajero_id,
    choferId: fila.chofer_id ?? null,
    estado: fila.estado,
    origen: { lat: Number(fila.origen_lat), lng: Number(fila.origen_lng) },
  };
}

export function crearRepositorioViajesLecturaPg({ consulta }) {
  if (typeof consulta !== 'function') {
    throw new TypeError('crearRepositorioViajesLecturaPg requiere la funcion consulta.');
  }
  return {
    async buscarPorId(viajeId) {
      const { rows } = await consulta(SQL_BUSCAR_VIAJE_CON_CHOFER, [viajeId]);
      return mapear(rows[0]);
    },
    // Preparada: corre en cada POST /ubicacion (camino caliente).
    async buscarActivoPorChofer(choferId) {
      const { rows } = await consulta({
        name: 'viaje_activo_por_chofer',
        text: SQL_BUSCAR_ACTIVO_POR_CHOFER,
        values: [choferId, ESTADOS_ACTIVOS],
      });
      return mapear(rows[0]);
    },
  };
}
