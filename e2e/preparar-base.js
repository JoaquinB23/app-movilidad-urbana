// Setup global de Playwright: deja la base de TEST en un estado conocido.
//   1. Migraciones pendientes.
//   2. Usuarios del seed (contrasena SEED_PASSWORD).
//   3. Sin viajes, ofertas ni asignaciones de los usuarios del seed, sin
//      posiciones de otros choferes (solo el chofer del seed es candidato) y
//      el tiempo de oferta en su valor por defecto.

import pg from 'pg';

import { migrar } from '../src/infra/db/migrar.js';
import { sembrarDatosBase } from '../src/infra/db/seed.js';
import { crearHasherArgon2 } from '../src/infra/seguridad/hasher-argon2.js';

export default async function prepararBase() {
  const url = process.env.DATABASE_URL_TEST;
  const original = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url;
  try {
    await migrar();
  } finally {
    process.env.DATABASE_URL = original;
  }

  const pool = new pg.Pool({ connectionString: url });
  try {
    await sembrarDatosBase({ pool, hasher: await crearHasherArgon2(), password: process.env.SEED_PASSWORD });
    const seed = `SELECT id FROM usuarios WHERE email LIKE '%@movilidad.invalid'`;
    const viajes = `SELECT id FROM viajes WHERE pasajero_id IN (${seed})`;
    for (const tabla of ['cobros', 'viajes_eventos', 'ofertas_viaje', 'asignaciones_viaje']) {
      await pool.query(`DELETE FROM ${tabla} WHERE viaje_id IN (${viajes})`);
    }
    await pool.query(`UPDATE ubicaciones_historial SET viaje_id = NULL WHERE viaje_id IN (${viajes})`);
    await pool.query(`DELETE FROM viajes WHERE id IN (${viajes})`);
    await pool.query('DELETE FROM ubicaciones_actuales');
    await pool.query("UPDATE parametros SET valor = '30'::jsonb WHERE clave = 'tiempo_limite_oferta_s'");
  } finally {
    await pool.end();
  }
}
