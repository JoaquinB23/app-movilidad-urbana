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

export const SQL_CAMBIAR_DISPONIBILIDAD = `
  UPDATE choferes
  SET disponible = $2
  WHERE usuario_id = $1 AND (habilitado OR $2 = false)
  RETURNING usuario_id, habilitado, disponible
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
    // Puerto RepositorioChoferes de ubicaciones. Devuelve null si el chofer no
    // existe o si se pide disponible=true para uno NO habilitado: la condicion
    // va en el UPDATE para cerrar la carrera con un admin que lo deshabilita
    // entre la lectura del servicio y esta escritura. Apagarse siempre se puede.
    async cambiarDisponibilidad(id, disponible) {
      const { rows } = await consulta(SQL_CAMBIAR_DISPONIBILIDAD, [id, Boolean(disponible)]);
      return mapearChofer(rows[0]);
    },
  };
}
