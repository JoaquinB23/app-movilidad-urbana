// Seed de CARGA: N choferes habilitados (default 500) para el simulador y M
// pasajeros (default 50) para que k6 pida viajes. Para las mediciones de
// docs/mediciones.md. Separado del seed por rol: estos usuarios no son para la
// demo ni para iniciar sesion (el simulador y k6 firman su propio JWT).
//
//   npm run carga:seed                       # 500 choferes y 50 pasajeros
//   CANTIDAD_CHOFERES=1000 CANTIDAD_PASAJEROS=100 npm run carga:seed
//   npm run carga:seed -- --borrar           # quita todo lo de carga
//
// Idempotente: UPSERT por email y por usuario_id, en una transaccion, con
// INSERT ... SELECT FROM unnest (un viaje a la base por tabla, no N).
// Todos quedan habilitados y NO disponibles; el simulador los pone
// disponibles por la API, como haria la app real.

import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import {
  idChoferCarga, emailChoferCarga, patenteChoferCarga, idPasajeroCarga, emailPasajeroCarga,
} from './ids-carga.js';

export async function sembrarChoferesCarga({ pool, hasher, cantidad = 500, cantidadPasajeros = 50 }) {
  if (!Number.isInteger(cantidad) || cantidad <= 0) {
    throw new Error('La cantidad de choferes de carga debe ser un entero positivo.');
  }
  if (!Number.isInteger(cantidadPasajeros) || cantidadPasajeros < 0) {
    throw new Error('La cantidad de pasajeros de carga debe ser un entero no negativo.');
  }
  const idsPasajeros = Array.from({ length: cantidadPasajeros }, (_, i) => idPasajeroCarga(i));
  const emailsPasajeros = Array.from({ length: cantidadPasajeros }, (_, i) => emailPasajeroCarga(i));
  const indices = Array.from({ length: cantidad }, (_, i) => i);
  const ids = indices.map(idChoferCarga);
  const emails = indices.map(emailChoferCarga);
  const patentes = indices.map(patenteChoferCarga);
  // Nadie inicia sesion con estas cuentas: un solo hash de una clave
  // aleatoria que nadie conoce (y no un hash por chofer: 500 argon2 tardan).
  const passwordHash = await hasher.hashear(randomBytes(32).toString('hex'));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO usuarios (id, email, password_hash, nombre, rol, activo)
       SELECT id, email, $3, 'Chofer de carga', 'chofer', true
       FROM unnest($1::uuid[], $2::text[]) AS t(id, email)
       ON CONFLICT ((lower(email))) DO UPDATE SET activo = true, rol = 'chofer'`,
      [ids, emails, passwordHash]
    );
    await client.query(
      `INSERT INTO choferes (usuario_id, patente, vehiculo_marca, vehiculo_modelo, vehiculo_color, habilitado, disponible)
       SELECT id, patente, 'Simulado', 'Carga', 'Gris', true, false
       FROM unnest($1::uuid[], $2::text[]) AS t(id, patente)
       ON CONFLICT (usuario_id) DO UPDATE SET habilitado = true, disponible = false`,
      [ids, patentes]
    );
    await client.query(
      `INSERT INTO usuarios (id, email, password_hash, nombre, rol, activo)
       SELECT id, email, $3, 'Pasajero de carga', 'pasajero', true
       FROM unnest($1::uuid[], $2::text[]) AS t(id, email)
       ON CONFLICT ((lower(email))) DO UPDATE SET activo = true, rol = 'pasajero'`,
      [idsPasajeros, emailsPasajeros, passwordHash]
    );
    await client.query('COMMIT');
    return { choferes: cantidad, pasajeros: cantidadPasajeros, primero: ids[0], ultimo: ids.at(-1) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Borra TODO lo de carga (choferes, pasajeros y sus viajes, cualquier cantidad
// que se haya sembrado). Solo toca cuentas @carga.invalid.
export async function borrarChoferesCarga({ pool }) {
  const deCarga = `SELECT id FROM usuarios WHERE email LIKE 'carga-chofer-%@carga.invalid'`;
  const pasajerosDeCarga = `SELECT id FROM usuarios WHERE email LIKE 'carga-pasajero-%@carga.invalid'`;
  const viajesDeCarga = `SELECT id FROM viajes WHERE pasajero_id IN (${pasajerosDeCarga})`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM viajes_eventos WHERE viaje_id IN (${viajesDeCarga})`);
    await client.query(`DELETE FROM ofertas_viaje WHERE chofer_id IN (${deCarga}) OR viaje_id IN (${viajesDeCarga})`);
    await client.query(`DELETE FROM asignaciones_viaje WHERE chofer_id IN (${deCarga}) OR viaje_id IN (${viajesDeCarga})`);
    await client.query(`UPDATE ubicaciones_historial SET viaje_id = NULL WHERE viaje_id IN (${viajesDeCarga})`);
    await client.query(`DELETE FROM viajes WHERE id IN (${viajesDeCarga})`);
    await client.query(`DELETE FROM claves_idempotencia WHERE usuario_id IN (${pasajerosDeCarga})`);
    await client.query(`DELETE FROM usuarios WHERE id IN (${pasajerosDeCarga})`);
    await client.query(`DELETE FROM ubicaciones_historial WHERE chofer_id IN (${deCarga})`);
    await client.query(`DELETE FROM ubicaciones_actuales WHERE chofer_id IN (${deCarga})`);
    await client.query(`DELETE FROM choferes WHERE usuario_id IN (${deCarga})`);
    const { rowCount } = await client.query(`DELETE FROM usuarios WHERE id IN (${deCarga})`);
    await client.query('COMMIT');
    return { borrados: rowCount };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [{ crearPoolPg }, { crearHasherArgon2 }] = await Promise.all([
    import('../../src/infra/db/pool-pg.js'),
    import('../../src/infra/seguridad/hasher-argon2.js'),
  ]);
  const pool = crearPoolPg({ connectionString: process.env.DATABASE_URL });
  try {
    if (process.argv.includes('--borrar')) {
      const { borrados } = await borrarChoferesCarga({ pool });
      console.log(`Choferes de carga borrados: ${borrados}.`);
    } else {
      const cantidad = Number(process.env.CANTIDAD_CHOFERES ?? 500);
      const cantidadPasajeros = Number(process.env.CANTIDAD_PASAJEROS ?? 50);
      const resumen = await sembrarChoferesCarga({
        pool, hasher: await crearHasherArgon2(), cantidad, cantidadPasajeros,
      });
      console.log(`Carga lista: ${resumen.choferes} choferes y ${resumen.pasajeros} pasajeros.`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
