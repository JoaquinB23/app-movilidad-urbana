export function crearIdempotenciaPg({ consulta }) {
  return {
    async reservar(usuario, clave, hash) {
      // La PK hace esperar al reintento hasta que la primera transacción termine.
      const reserva = await consulta(
        `INSERT INTO claves_idempotencia (usuario_id, clave, hash_pedido)
         VALUES ($1, $2, $3) ON CONFLICT (usuario_id, clave) DO NOTHING`, [usuario, clave, hash]
      );
      if (reserva.rowCount === 1) return null;
      const { rows } = await consulta(
        'SELECT hash_pedido AS hash, respuesta FROM claves_idempotencia WHERE usuario_id = $1 AND clave = $2',
        [usuario, clave]
      );
      return rows[0];
    },
    async completar(usuario, clave, respuesta) {
      await consulta(
        'UPDATE claves_idempotencia SET estado_http = 201, respuesta = $3 WHERE usuario_id = $1 AND clave = $2',
        [usuario, clave, respuesta]
      );
    },
  };
}
