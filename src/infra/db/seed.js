// Seed idempotente por rol (P0): deja en la base un usuario conocido de cada
// rol para la prueba de aceptacion del primer viaje y las demos.
//
//   node --env-file=.env src/infra/db/seed.js
//
// Decisiones:
//   * IDEMPOTENTE por UPSERT sobre las claves naturales (lower(email) en
//     usuarios, usuario_id en choferes), no por "SELECT y si no existe
//     INSERT": correrlo dos veces o en paralelo no duplica filas, y no hay
//     carrera check-then-insert. Todo va en una transaccion por corrida.
//   * La contraseña viene de SEED_PASSWORD (nunca del repo) y se hashea con el
//     MISMO adaptador argon2 de la app, asi el seed sirve para el login real.
//     Re-sembrar actualiza el hash: el entorno queda en un estado conocido.
//   * Dos pasajeros y dos choferes: permiten probar autorizacion por recurso
//     entre usuarios del mismo rol. El chofer principal queda habilitado; el
//     secundario no, para demostrar PATCH /admin/choferes/:id/habilitacion.
//   * Nadie queda "disponible": eso lo enciende el chofer por la API, que es
//     justamente lo que valida el flujo del primer viaje.
//   * Las cuentas usan el dominio reservado .invalid (RFC 2606): no pueden
//     recibir mail real.

import { pathToFileURL } from 'node:url';

export const USUARIOS_SEED = Object.freeze([
  { email: 'pasajero1@movilidad.invalid', nombre: 'Pasajero Uno', rol: 'pasajero' },
  { email: 'pasajero2@movilidad.invalid', nombre: 'Pasajero Dos', rol: 'pasajero' },
  {
    email: 'chofer1@movilidad.invalid',
    nombre: 'Chofer Uno',
    rol: 'chofer',
    vehiculo: { patente: 'AA100AA', marca: 'Toyota', modelo: 'Etios', color: 'Blanco', habilitado: true },
  },
  {
    email: 'chofer2@movilidad.invalid',
    nombre: 'Chofer Dos',
    rol: 'chofer',
    vehiculo: { patente: 'AA200AA', marca: 'Fiat', modelo: 'Cronos', color: 'Gris', habilitado: false },
  },
  { email: 'operador1@movilidad.invalid', nombre: 'Operador Uno', rol: 'operador' },
  { email: 'admin1@movilidad.invalid', nombre: 'Administrador Uno', rol: 'administrador' },
].map((usuario) => Object.freeze(usuario)));

const SQL_UPSERT_USUARIO = `
  INSERT INTO usuarios (email, password_hash, nombre, rol, activo)
  VALUES ($1, $2, $3, $4, true)
  ON CONFLICT ((lower(email))) DO UPDATE SET
    password_hash = EXCLUDED.password_hash,
    nombre = EXCLUDED.nombre,
    rol = EXCLUDED.rol,
    activo = true
  RETURNING id
`;

// El chofer principal se marca habilitado por el administrador del seed; el
// secundario vuelve a "no habilitado" en cada corrida (estado conocido).
const SQL_UPSERT_CHOFER = `
  INSERT INTO choferes (usuario_id, patente, vehiculo_marca, vehiculo_modelo, vehiculo_color,
                        habilitado, habilitado_por, habilitado_en, disponible)
  VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $6 THEN now() END, false)
  ON CONFLICT (usuario_id) DO UPDATE SET
    patente = EXCLUDED.patente,
    vehiculo_marca = EXCLUDED.vehiculo_marca,
    vehiculo_modelo = EXCLUDED.vehiculo_modelo,
    vehiculo_color = EXCLUDED.vehiculo_color,
    habilitado = EXCLUDED.habilitado,
    habilitado_por = EXCLUDED.habilitado_por,
    habilitado_en = COALESCE(choferes.habilitado_en, EXCLUDED.habilitado_en)
`;

export async function sembrarDatosBase({ pool, hasher, password }) {
  if (typeof password !== 'string' || password.length < 8) {
    // Mismo minimo que exige el registro: si no, el login real lo rechazaria.
    throw new Error('SEED_PASSWORD debe tener al menos 8 caracteres.');
  }
  // El hash se calcula FUERA de la transaccion: argon2 es caro a proposito y
  // no conviene retener locks mientras corre. Un hash (con su propia sal) por
  // usuario.
  const hashes = await Promise.all(USUARIOS_SEED.map(() => hasher.hashear(password)));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids = new Map();
    // Primero los que no son choferes: el admin tiene que existir para
    // registrarse como quien habilito al chofer principal.
    const ordenados = [...USUARIOS_SEED.entries()].sort(([, a], [, b]) =>
      Number(a.rol === 'chofer') - Number(b.rol === 'chofer'));
    for (const [indice, usuario] of ordenados) {
      const { rows } = await client.query(SQL_UPSERT_USUARIO, [
        usuario.email, hashes[indice], usuario.nombre, usuario.rol,
      ]);
      ids.set(usuario.email, rows[0].id);
    }

    const adminId = ids.get(USUARIOS_SEED.find((u) => u.rol === 'administrador').email);
    for (const usuario of USUARIOS_SEED.filter((u) => u.rol === 'chofer')) {
      const { vehiculo } = usuario;
      await client.query(SQL_UPSERT_CHOFER, [
        ids.get(usuario.email),
        vehiculo.patente,
        vehiculo.marca,
        vehiculo.modelo,
        vehiculo.color,
        vehiculo.habilitado,
        vehiculo.habilitado ? adminId : null,
      ]);
    }
    await client.query('COMMIT');
    return { usuarios: ids.size, ids: Object.fromEntries(ids) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [{ crearPoolPg }, { crearHasherArgon2 }] = await Promise.all([
    import('./pool-pg.js'),
    import('../seguridad/hasher-argon2.js'),
  ]);
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Falta DATABASE_URL.');
    process.exit(1);
  }
  const pool = crearPoolPg({ connectionString: url });
  try {
    const hasher = await crearHasherArgon2();
    const resumen = await sembrarDatosBase({ pool, hasher, password: process.env.SEED_PASSWORD });
    console.log(`Seed aplicado: ${resumen.usuarios} usuarios.`);
    for (const usuario of USUARIOS_SEED) console.log(`  ${usuario.rol.padEnd(13)} ${usuario.email}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
