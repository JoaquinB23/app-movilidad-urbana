// Runner mínimo de migraciones para PostgreSQL (Node 22, ESM, pg).
// Convención documentada:
// - 001 = base
// - 1xx = viajes
// - 2xx = ubicaciones
// - 3xx = identidad y reasignación
// Solo se tocan archivos de migración .sql en orden alfabético.
// Cada migración se aplica dentro de una transacción: si falla, se aborta y NO deja la migración a medias.
// Se usa un advisory lock para evitar condiciones de carrera entre procesos concurrentes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const { Client } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Directorio raíz del repo (asumiendo src/infra/db/migrar.js)
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MIGRACIONES_DIR = path.join(REPO_ROOT, 'migraciones');

function obtenerUrlDb() {
  const url = process.env.DATABASE_URL;
  if (!url || url.trim() === '') {
    throw new Error(
      "DATABASE_URL es requerida. Definila en las variables de entorno (p. ej. postgres://user:pass@host:port/db)."
    );
  }
  return url.trim();
}

async function asegurarSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migraciones (
      nombre      VARCHAR(255) PRIMARY KEY,
      aplicada_en TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function migracionesAplicadas(client) {
  const res = await client.query(
    'SELECT nombre FROM schema_migraciones ORDER BY nombre ASC'
  );
  return new Set(res.rows.map((r) => r.nombre));
}

function listarArchivosSql() {
  if (!fs.existsSync(MIGRACIONES_DIR)) {
    throw new Error(
      `No existe el directorio de migraciones: ${MIGRACIONES_DIR}. Verifique la ruta.`
    );
  }
  const archivos = fs
    .readdirSync(MIGRACIONES_DIR)
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'es'));
  return archivos;
}

async function aplicarArchivo(client, nombreArchivo) {
  const ruta = path.join(MIGRACIONES_DIR, nombreArchivo);
  const sql = fs.readFileSync(ruta, 'utf8');
  await client.query(sql);
  await client.query(
    'INSERT INTO schema_migraciones (nombre) VALUES ($1) ON CONFLICT (nombre) DO NOTHING',
    [nombreArchivo]
  );
}

export async function migrar() {
  const url = obtenerUrlDb();
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    // Candado para evitar ejecutar migraciones en paralelo (ej. CI y otro proceso).
    await client.query('SELECT pg_advisory_lock($1)', [20251009]);
    await asegurarSchema(client);
    const aplicadas = await migracionesAplicadas(client);
    const archivos = listarArchivosSql();

    for (const archivo of archivos) {
      if (aplicadas.has(archivo)) {
        continue;
      }
      await client.query('BEGIN');
      try {
        await aplicarArchivo(client, archivo);
        await client.query('COMMIT');
        console.log(`Migración aplicada: ${archivo}`);
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (_) {
          // ignorar error de rollback
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Fallo al aplicar migración '${archivo}': ${msg}`);
      }
    }
    console.log('Migraciones completadas.');
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [20251009]);
    } catch (_) {
      // ignorar
    }
    try {
      await client.end();
    } catch (_) {
      // ignorar
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrar().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
