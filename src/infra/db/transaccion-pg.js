import { ErrorDominio } from '../../dominio/viajes/errores.js';
import { crearRepositorioAsignacionesPg } from './repo-asignaciones-pg.js';
import { crearRepositorioChoferesPg } from './repo-choferes-pg.js';
import { crearRepositorioOfertasPg } from './repo-ofertas-pg.js';
import { crearRepositorioViajesPg } from './repo-viajes-pg.js';

function traducirErrorPg(error) {
  if (error?.code === '40P01' || error?.code === '40001') {
    return new ErrorDominio('La operación entró en conflicto con otra transacción.', 'CONFLICTO_CONCURRENTE');
  }
  if (error?.code === '23505') {
    if (error.constraint === 'asignaciones_viaje_una_abierta_por_chofer_idx') {
      return new ErrorDominio('El chofer ya tiene una asignación abierta.', 'CHOFER_OCUPADO');
    }
    if (
      error.constraint === 'asignaciones_viaje_una_abierta_por_viaje_idx' ||
      error.constraint === 'ofertas_viaje_una_aceptada_por_viaje_idx'
    ) {
      return new ErrorDominio('El viaje ya no está disponible.', 'VIAJE_NO_DISPONIBLE');
    }
  }
  if (typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)) {
    return new ErrorDominio('No se pudo completar la operación en la base de datos.', 'ERROR_PERSISTENCIA');
  }
  return error;
}

export function crearTransaccionPg({ pool }) {
  if (typeof pool?.connect !== 'function') {
    throw new TypeError('El adaptador TransaccionPg requiere un pool PostgreSQL.');
  }

  return {
    async ejecutar(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const consulta = (sql, valores) => client.query(sql, valores);
        const repositorios = {
          viajes: crearRepositorioViajesPg({ consulta }),
          ofertas: crearRepositorioOfertasPg({ consulta }),
          choferes: crearRepositorioChoferesPg({ consulta }),
          asignaciones: crearRepositorioAsignacionesPg({ consulta }),
        };
        const resultado = await fn(repositorios);
        await client.query('COMMIT');
        return resultado;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (errorRollback) {
          throw traducirErrorPg(errorRollback);
        }
        throw traducirErrorPg(error);
      } finally {
        client.release();
      }
    },
  };
}
