// Seed idempotente por rol (P0). Verifica contra PostgreSQL real que:
//   * crea un usuario por cada rol (dos pasajeros y dos choferes, para poder
//     probar autorizacion por recurso entre usuarios del mismo rol);
//   * correrlo dos veces (o en paralelo) NO duplica filas;
//   * la contraseña queda hasheada con argon2 y sirve para el login real;
//   * el chofer principal queda habilitado y el secundario no.

process.env.ARGON2_MEMORIA_KIB = '8192';
process.env.ARGON2_ITERACIONES = '2';

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { crearPoolPg } from '../../src/infra/db/pool-pg.js';
import { sembrarDatosBase, USUARIOS_SEED } from '../../src/infra/db/seed.js';
import { crearHasherArgon2 } from '../../src/infra/seguridad/hasher-argon2.js';
import { crearTokensJwt } from '../../src/infra/seguridad/tokens-jwt.js';
import { crearRepositorioUsuariosPg } from '../../src/infra/db/repo-usuarios-pg.js';
import { crearServiciosIdentidad } from '../../src/dominio/identidad/servicios.js';
import { migrar } from '../../src/infra/db/migrar.js';

const urlTest = process.env.DATABASE_URL_TEST;
const urlPrincipal = process.env.DATABASE_URL;

function identificarBase(url) {
  const parsed = new URL(url);
  return [parsed.protocol, parsed.hostname.toLowerCase(), parsed.port || '5432', decodeURIComponent(parsed.pathname)].join('|');
}

if (!urlTest || urlTest.trim() === '') {
  throw new Error('Falta DATABASE_URL_TEST; definila para ejecutar las pruebas de integración.');
}
if (urlPrincipal && identificarBase(urlPrincipal) === identificarBase(urlTest)) {
  throw new Error('DATABASE_URL_TEST no puede ser igual a DATABASE_URL; se rechazó la ejecución.');
}

const PASSWORD = 'clave-seed-de-prueba';
const pool = crearPoolPg({ connectionString: urlTest });
const emails = USUARIOS_SEED.map((u) => u.email);
let hasher;

async function borrarSeed() {
  await pool.query('DELETE FROM choferes WHERE usuario_id IN (SELECT id FROM usuarios WHERE email = ANY($1))', [emails]);
  await pool.query('DELETE FROM usuarios WHERE email = ANY($1)', [emails]);
}

async function contar() {
  const { rows } = await pool.query(
    `SELECT u.rol, count(*)::int AS usuarios, count(c.usuario_id)::int AS choferes
     FROM usuarios u LEFT JOIN choferes c ON c.usuario_id = u.id
     WHERE u.email = ANY($1) GROUP BY u.rol ORDER BY u.rol`,
    [emails]
  );
  return rows;
}

before(async () => {
  const { rows } = await pool.query(`SELECT to_regclass('public.choferes') AS tabla`);
  if (!rows[0].tabla) {
    const urlOriginal = process.env.DATABASE_URL;
    try {
      process.env.DATABASE_URL = urlTest;
      await migrar();
    } finally {
      if (urlOriginal === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = urlOriginal;
    }
  }
  hasher = await crearHasherArgon2();
  await borrarSeed();
});
after(async () => {
  await borrarSeed();
  await pool.end();
});

test('crea un usuario por rol, con dos pasajeros y dos choferes', async () => {
  const resumen = await sembrarDatosBase({ pool, hasher, password: PASSWORD });
  assert.equal(resumen.usuarios, USUARIOS_SEED.length);

  assert.deepEqual(await contar(), [
    { rol: 'administrador', usuarios: 1, choferes: 0 },
    { rol: 'chofer', usuarios: 2, choferes: 2 },
    { rol: 'operador', usuarios: 1, choferes: 0 },
    { rol: 'pasajero', usuarios: 2, choferes: 0 },
  ]);
});

test('es idempotente: correrlo de nuevo, también en paralelo, no duplica filas', async () => {
  await sembrarDatosBase({ pool, hasher, password: PASSWORD });
  await Promise.all([
    sembrarDatosBase({ pool, hasher, password: PASSWORD }),
    sembrarDatosBase({ pool, hasher, password: PASSWORD }),
  ]);
  const filas = await contar();
  assert.equal(filas.reduce((total, fila) => total + fila.usuarios, 0), USUARIOS_SEED.length);
  assert.equal(filas.find((f) => f.rol === 'chofer').choferes, 2);
});

test('el chofer principal queda habilitado y NO disponible; el secundario sin habilitar', async () => {
  const { rows } = await pool.query(
    `SELECT u.email, c.habilitado, c.disponible
     FROM choferes c JOIN usuarios u ON u.id = c.usuario_id
     WHERE u.email = ANY($1) ORDER BY u.email`,
    [emails]
  );
  const porEmail = Object.fromEntries(rows.map((r) => [r.email, r]));
  const principal = USUARIOS_SEED.find((u) => u.rol === 'chofer' && u.vehiculo.habilitado);
  const secundario = USUARIOS_SEED.find((u) => u.rol === 'chofer' && !u.vehiculo.habilitado);
  assert.equal(porEmail[principal.email].habilitado, true);
  // Disponible lo enciende el chofer por la API (PUT /choferes/me/disponibilidad).
  assert.equal(porEmail[principal.email].disponible, false);
  assert.equal(porEmail[secundario.email].habilitado, false);
});

test('la contraseña queda hasheada con argon2id y sirve para el login real', async () => {
  const { rows } = await pool.query('SELECT password_hash FROM usuarios WHERE email = $1', [emails[0]]);
  assert.match(rows[0].password_hash, /^\$argon2id\$/);
  assert.ok(!rows[0].password_hash.includes(PASSWORD));

  const identidad = crearServiciosIdentidad({
    repositorioUsuarios: crearRepositorioUsuariosPg({ pool }),
    hasher,
    tokens: crearTokensJwt({ JWT_SECRETO: 'secreto-de-prueba-con-mas-de-32-caracteres!!' }),
    reloj: { ahora: () => new Date() },
  });
  for (const usuario of USUARIOS_SEED) {
    const sesion = await identidad.iniciarSesion({ email: usuario.email, password: PASSWORD });
    assert.equal(sesion.usuario.rol, usuario.rol, usuario.email);
  }
});

test('re-sembrar con otra contraseña la actualiza (deja el entorno en un estado conocido)', async () => {
  await sembrarDatosBase({ pool, hasher, password: 'otra-clave-de-prueba' });
  const { rows } = await pool.query('SELECT password_hash FROM usuarios WHERE email = $1', [emails[0]]);
  assert.equal(await hasher.verificar(rows[0].password_hash, 'otra-clave-de-prueba'), true);
  assert.equal(await hasher.verificar(rows[0].password_hash, PASSWORD), false);
});

test('rechaza una contraseña corta o ausente sin tocar la base', async () => {
  await assert.rejects(sembrarDatosBase({ pool, hasher, password: 'corta' }), /al menos 8/);
  await assert.rejects(sembrarDatosBase({ pool, hasher, password: undefined }), /al menos 8/);
});
