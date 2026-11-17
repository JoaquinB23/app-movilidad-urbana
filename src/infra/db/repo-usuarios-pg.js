// Repositorio de usuarios/choferes sobre PostgreSQL (puerto del módulo de
// identidad). La unicidad de email y patente la garantizan los índices únicos
// de la DB; acá solo se TRADUCE la violación 23505 a errores de dominio, para
// que no exista la carrera check-then-insert.

import { ErrorEmailEnUso, ErrorPatenteEnUso } from '../../dominio/identidad/errores.js';

function mapearUsuario(fila) {
  if (!fila) return null;
  const usuario = {
    id: fila.id,
    email: fila.email,
    passwordHash: fila.password_hash,
    nombre: fila.nombre,
    rol: fila.rol,
    activo: fila.activo,
    creadoEn: fila.creado_en,
  };
  if (fila.patente !== undefined && fila.patente !== null) {
    usuario.chofer = {
      patente: fila.patente,
      vehiculoMarca: fila.vehiculo_marca,
      vehiculoModelo: fila.vehiculo_modelo,
      vehiculoColor: fila.vehiculo_color,
      habilitado: fila.habilitado,
      disponible: fila.disponible,
      habilitadoPor: fila.habilitado_por ?? null,
      habilitadoEn: fila.habilitado_en ?? null,
    };
  }
  return usuario;
}

function traducirUnicidad(error) {
  if (error?.code === '23505') {
    if (error.constraint === 'usuarios_email_lower_idx') return new ErrorEmailEnUso();
    if (error.constraint === 'choferes_patente_unique') return new ErrorPatenteEnUso();
  }
  return error;
}

const SQL_USUARIO_CON_CHOFER = `
  SELECT u.*, c.patente, c.vehiculo_marca, c.vehiculo_modelo, c.vehiculo_color,
         c.habilitado, c.habilitado_por, c.habilitado_en, c.disponible
  FROM usuarios u
  LEFT JOIN choferes c ON c.usuario_id = u.id
`;

export function crearRepositorioUsuariosPg({ pool }) {
  const consulta = (sql, valores) => pool.query(sql, valores);

  return {
    async buscarPorEmail(email) {
      const { rows } = await consulta(
        `${SQL_USUARIO_CON_CHOFER} WHERE lower(u.email) = lower($1)`,
        [email]
      );
      return mapearUsuario(rows[0]);
    },

    async buscarPorId(id) {
      const { rows } = await consulta(`${SQL_USUARIO_CON_CHOFER} WHERE u.id = $1`, [id]);
      return mapearUsuario(rows[0]);
    },

    async crearPasajero({ email, passwordHash, nombre }) {
      try {
        const { rows } = await consulta(
          `INSERT INTO usuarios (email, password_hash, nombre, rol)
           VALUES ($1, $2, $3, 'pasajero')
           RETURNING *`,
          [email, passwordHash, nombre]
        );
        return mapearUsuario(rows[0]);
      } catch (error) {
        throw traducirUnicidad(error);
      }
    },

    // usuario + fila de choferes en UNA transacción: no puede existir un
    // usuario con rol chofer sin sus datos de vehículo.
    async crearChofer({ email, passwordHash, nombre }, vehiculo) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `INSERT INTO usuarios (email, password_hash, nombre, rol)
           VALUES ($1, $2, $3, 'chofer')
           RETURNING *`,
          [email, passwordHash, nombre]
        );
        const usuario = rows[0];
        const { rows: filasChofer } = await client.query(
          `INSERT INTO choferes (usuario_id, patente, vehiculo_marca, vehiculo_modelo, vehiculo_color)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [usuario.id, vehiculo.patente, vehiculo.marca, vehiculo.modelo, vehiculo.color]
        );
        await client.query('COMMIT');
        return mapearUsuario({ ...usuario, ...filasChofer[0] });
      } catch (error) {
        await client.query('ROLLBACK');
        throw traducirUnicidad(error);
      } finally {
        client.release();
      }
    },

    async listarChoferes({ habilitado } = {}) {
      const condiciones = ["u.rol = 'chofer'"];
      const valores = [];
      if (typeof habilitado === 'boolean') {
        valores.push(habilitado);
        condiciones.push(`c.habilitado = $${valores.length}`);
      }
      const { rows } = await consulta(
        `${SQL_USUARIO_CON_CHOFER} WHERE ${condiciones.join(' AND ')} ORDER BY u.creado_en DESC`,
        valores
      );
      return rows.map(mapearUsuario);
    },

    async cambiarHabilitacion({ choferId, habilitado, adminId, en }) {
      const { rows } = await consulta(
        `UPDATE choferes
         SET habilitado = $2,
             habilitado_por = CASE WHEN $2 THEN $3 ELSE habilitado_por END,
             habilitado_en  = CASE WHEN $2 THEN $4 ELSE habilitado_en END,
             disponible = CASE WHEN $2 THEN disponible ELSE false END
         WHERE usuario_id = $1
         RETURNING usuario_id, patente, habilitado, habilitado_por, habilitado_en, disponible`,
        [choferId, habilitado, adminId, en]
      );
      if (!rows[0]) return null;
      return {
        id: rows[0].usuario_id,
        patente: rows[0].patente,
        habilitado: rows[0].habilitado,
        habilitadoPor: rows[0].habilitado_por,
        habilitadoEn: rows[0].habilitado_en,
        disponible: rows[0].disponible,
      };
    },
  };
}
