import { randomUUID } from 'node:crypto';

const PREFIJO_EMAIL = 'it-viajes-';

export async function limpiarDatosViajes(consulta) {
  const patron = `${PREFIJO_EMAIL}%@test.invalid`;
  await consulta('TRUNCATE TABLE viajes_eventos, asignaciones_viaje, ofertas_viaje');
  // ubicaciones_historial referencia viajes, así que los viajes del fixture se borran por pasajero.
  await consulta(`DELETE FROM viajes WHERE pasajero_id IN (
    SELECT id FROM usuarios WHERE email LIKE $1
  )`, [patron]);
  await consulta(`DELETE FROM choferes WHERE usuario_id IN (
    SELECT id FROM usuarios WHERE email LIKE $1
  )`, [patron]);
  await consulta('DELETE FROM usuarios WHERE email LIKE $1', [patron]);
}

export async function crearEscenarioPg(pool, { ofertaExpiraEn = new Date(Date.now() + 60_000) } = {}) {
  const consulta = (sql, valores) => pool.query(sql, valores);
  const pasajeroId = randomUUID();
  const choferId = randomUUID();
  const viajeId = randomUUID();
  const ofertaId = randomUUID();
  const sufijo = randomUUID();

  await consulta(
    `INSERT INTO usuarios (id, email, password_hash, nombre, rol)
     VALUES ($1, $2, $3, $4, 'pasajero')`,
    [pasajeroId, `${PREFIJO_EMAIL}pasajero-${sufijo}@test.invalid`, 'hash-test', 'Pasajero de prueba']
  );
  await consulta(
    `INSERT INTO usuarios (id, email, password_hash, nombre, rol)
     VALUES ($1, $2, $3, $4, 'chofer')`,
    [choferId, `${PREFIJO_EMAIL}chofer-${sufijo}@test.invalid`, 'hash-test', 'Chofer de prueba']
  );
  await consulta(
    `INSERT INTO choferes (
       usuario_id, patente, vehiculo_marca, vehiculo_modelo, vehiculo_color, habilitado, disponible
     ) VALUES ($1, $2, 'Marca', 'Modelo', 'Color', true, true)`,
    [choferId, `T${sufijo.slice(0, 7)}`]
  );
  const ahora = new Date();
  await consulta(
    `INSERT INTO viajes (
       id, pasajero_id, estado, origen_lat, origen_lng, destino_lat, destino_lng,
       distancia_estimada_m, duracion_estimada_s, tarifa_estimada_centavos,
       creado_en, actualizado_en
     ) VALUES ($1, $2, 'solicitado', -27.45, -58.98, -27.46, -58.97, 1000, 120, 5000, $3, $3)`,
    [viajeId, pasajeroId, ahora]
  );
  await consulta(
    `INSERT INTO ofertas_viaje (id, viaje_id, chofer_id, estado, orden, expira_en, creada_en)
     VALUES ($1, $2, $3, 'pendiente', 1, $4, $5)`,
    [ofertaId, viajeId, choferId, ofertaExpiraEn, ahora]
  );

  return { pasajeroId, choferId, viajeId, ofertaId };
}
