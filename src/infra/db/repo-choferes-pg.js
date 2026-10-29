function mapearChofer(fila) {
  if (!fila) return null;
  return {
    id: fila.usuario_id,
    habilitado: fila.habilitado,
    disponible: fila.disponible,
  };
}

export const SQL_BUSCAR_CHOFER_PARA_ACTUALIZAR = `
  SELECT usuario_id, habilitado, disponible
  FROM choferes
  WHERE usuario_id = $1
  FOR UPDATE
`;

export function crearRepositorioChoferesPg({ consulta }) {
  return {
    async buscarPorId(id) {
      const { rows } = await consulta(
        'SELECT usuario_id, habilitado, disponible FROM choferes WHERE usuario_id = $1',
        [id]
      );
      return mapearChofer(rows[0]);
    },
    async buscarPorIdParaActualizar(id) {
      const { rows } = await consulta(SQL_BUSCAR_CHOFER_PARA_ACTUALIZAR, [id]);
      return mapearChofer(rows[0]);
    },
  };
}
