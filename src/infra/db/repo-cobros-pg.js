// Repositorio de cobros (migracion 105). Se instancia dentro de transaccion-pg.

function mapearCobro(fila) {
  if (!fila) return null;
  return {
    id: fila.id,
    viajeId: fila.viaje_id,
    pasajeroId: fila.pasajero_id,
    importeCentavos: Number(fila.importe_centavos),
    estado: fila.estado,
    creadoEn: fila.creado_en,
  };
}

export function crearRepositorioCobrosPg({ consulta }) {
  return {
    async buscarPorViaje(viajeId) {
      const { rows } = await consulta('SELECT * FROM cobros WHERE viaje_id = $1', [viajeId]);
      return mapearCobro(rows[0]);
    },
    async crear(cobro) {
      const { rows } = await consulta(
        `INSERT INTO cobros (id, viaje_id, pasajero_id, importe_centavos, estado, creado_en)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [cobro.id, cobro.viajeId, cobro.pasajeroId, cobro.importeCentavos, cobro.estado, cobro.creadoEn]
      );
      return mapearCobro(rows[0]);
    },
  };
}
