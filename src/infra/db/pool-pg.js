import pg from 'pg';

const { Pool } = pg;

export function crearPoolPg({ connectionString = process.env.DATABASE_URL } = {}) {
  if (typeof connectionString !== 'string' || connectionString.trim() === '') {
    throw new Error('Se requiere una URL de conexión PostgreSQL.');
  }
  return new Pool({ connectionString: connectionString.trim() });
}
