import pg from 'pg';

const { Pool } = pg;

// `alError`: recibe los errores de conexiones OCIOSAS del pool (la base se
// reinicio, failover, pg_terminate_backend). Sin listener de 'error', Node lo
// trata como excepcion no capturada y TERMINA EL PROCESO: una caida de la base
// tumbaba toda la API. Con el listener, el pool descarta la conexion muerta y
// abre otra en el proximo pedido; mientras la base no vuelva, /ready da 503.
//
// `max`: conexiones simultaneas (default de pg: 10). Con 500 choferes
// reportando a la vez, cada pedido hace varias idas y vueltas a la base y el
// pool es el que limita cuantas corren en paralelo (docs/mediciones.md).
export function crearPoolPg({
  connectionString = process.env.DATABASE_URL,
  max = 10,
  alError = (error) => console.error('Error en una conexion ociosa de PostgreSQL:', error.message),
} = {}) {
  if (typeof connectionString !== 'string' || connectionString.trim() === '') {
    throw new Error('Se requiere una URL de conexión PostgreSQL.');
  }
  const pool = new Pool({ connectionString: connectionString.trim(), max });
  pool.on('error', alError);
  return pool;
}
