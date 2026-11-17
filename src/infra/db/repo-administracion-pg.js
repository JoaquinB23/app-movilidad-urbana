// Repositorio de configuración administrable: tarifas (singleton), zonas y
// parámetros clave/valor. Lo consumen las rutas /admin/* y el worker de
// reasignación (lee umbral y radio).

function mapearZona(fila) {
  return {
    id: fila.id,
    nombre: fila.nombre,
    multiplicador: Number(fila.multiplicador),
    activa: fila.activa,
    actualizadoEn: fila.actualizado_en,
  };
}

export function crearRepositorioAdministracionPg({ pool }) {
  const consulta = (sql, valores) => pool.query(sql, valores);

  return {
    async obtenerTarifas() {
      const { rows } = await consulta('SELECT * FROM tarifas WHERE id = 1');
      if (!rows[0]) return null;
      return {
        bajadaBanderaCentavos: rows[0].bajada_bandera_centavos,
        precioKmCentavos: rows[0].precio_km_centavos,
        precioMinutoCentavos: rows[0].precio_minuto_centavos,
        actualizadoEn: rows[0].actualizado_en,
      };
    },

    async guardarTarifas({ bajadaBanderaCentavos, precioKmCentavos, precioMinutoCentavos, adminId }) {
      const { rows } = await consulta(
        `INSERT INTO tarifas (id, bajada_bandera_centavos, precio_km_centavos, precio_minuto_centavos, actualizado_en, actualizado_por)
         VALUES (1, $1, $2, $3, now(), $4)
         ON CONFLICT (id) DO UPDATE SET
           bajada_bandera_centavos = EXCLUDED.bajada_bandera_centavos,
           precio_km_centavos = EXCLUDED.precio_km_centavos,
           precio_minuto_centavos = EXCLUDED.precio_minuto_centavos,
           actualizado_en = now(),
           actualizado_por = EXCLUDED.actualizado_por
         RETURNING *`,
        [bajadaBanderaCentavos, precioKmCentavos, precioMinutoCentavos, adminId]
      );
      return {
        bajadaBanderaCentavos: rows[0].bajada_bandera_centavos,
        precioKmCentavos: rows[0].precio_km_centavos,
        precioMinutoCentavos: rows[0].precio_minuto_centavos,
        actualizadoEn: rows[0].actualizado_en,
      };
    },

    async listarZonas() {
      const { rows } = await consulta('SELECT * FROM zonas ORDER BY nombre');
      return rows.map(mapearZona);
    },

    // PUT /admin/zonas reemplaza por nombre (upsert): idempotente.
    async guardarZona({ nombre, multiplicador, activa }) {
      const { rows } = await consulta(
        `INSERT INTO zonas (nombre, multiplicador, activa, actualizado_en)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (nombre) DO UPDATE SET
           multiplicador = EXCLUDED.multiplicador,
           activa = EXCLUDED.activa,
           actualizado_en = now()
         RETURNING *`,
        [nombre, multiplicador, activa]
      );
      return mapearZona(rows[0]);
    },

    async obtenerParametros() {
      const { rows } = await consulta('SELECT clave, valor, descripcion, actualizado_en FROM parametros ORDER BY clave');
      const parametros = {};
      for (const fila of rows) parametros[fila.clave] = fila.valor;
      return parametros;
    },

    async obtenerParametro(clave) {
      const { rows } = await consulta('SELECT valor FROM parametros WHERE clave = $1', [clave]);
      return rows[0] ? rows[0].valor : null;
    },

    // Solo actualiza claves EXISTENTES: el catálogo de parámetros lo define la
    // migración; el admin edita valores, no inventa claves (superficie cerrada).
    async guardarParametro({ clave, valor, adminId }) {
      const { rows } = await consulta(
        `UPDATE parametros
         SET valor = $2::jsonb, actualizado_en = now(), actualizado_por = $3
         WHERE clave = $1
         RETURNING clave, valor`,
        [clave, JSON.stringify(valor), adminId]
      );
      return rows[0] ? { clave: rows[0].clave, valor: rows[0].valor } : null;
    },
  };
}
