import test from 'node:test';
import assert from 'node:assert/strict';

import { crearTransaccionPg } from '../../src/infra/db/transaccion-pg.js';

function crearPoolFalso({ errorConsulta } = {}) {
  const consultas = [];
  let conexiones = 0;
  let liberaciones = 0;
  const cliente = {
    async query(sql, valores) {
      consultas.push({ sql, valores });
      if (errorConsulta) return errorConsulta(sql, valores);
      return { rows: [] };
    },
    release() {
      liberaciones += 1;
    },
  };
  return {
    consultas,
    obtenerConteos: () => ({ conexiones, liberaciones }),
    pool: {
      async connect() {
        conexiones += 1;
        return cliente;
      },
    },
  };
}

test('entrega los cuatro repositorios usando un único cliente y libera la conexión', async () => {
  const falso = crearPoolFalso();
  const transaccion = crearTransaccionPg({ pool: falso.pool });
  const nombres = await transaccion.ejecutar(async (repositorios) => {
    await repositorios.viajes.buscarPorId('viaje-1');
    await repositorios.ofertas.buscarPorId('oferta-1');
    await repositorios.choferes.buscarPorId('chofer-1');
    await repositorios.asignaciones.buscarAbiertaPorChofer('chofer-1');
    return Object.keys(repositorios).sort();
  });

  assert.deepEqual(nombres, ['asignaciones', 'choferes', 'ofertas', 'viajes']);
  assert.deepEqual(falso.obtenerConteos(), { conexiones: 1, liberaciones: 1 });
  assert.equal(falso.consultas[0].sql, 'BEGIN');
  assert.equal(falso.consultas.at(-1).sql, 'COMMIT');
});

test('traduce índices únicos parciales y siempre revierte la transacción', async (t) => {
  for (const [constraint, codigo] of [
    ['asignaciones_viaje_una_abierta_por_chofer_idx', 'CHOFER_OCUPADO'],
    ['asignaciones_viaje_una_abierta_por_viaje_idx', 'VIAJE_NO_DISPONIBLE'],
    ['ofertas_viaje_una_aceptada_por_viaje_idx', 'VIAJE_NO_DISPONIBLE'],
  ]) {
    await t.test(constraint, async () => {
      const falso = crearPoolFalso({
        errorConsulta: async (sql) => {
          if (sql.includes('INSERT INTO asignaciones_viaje')) {
            throw Object.assign(new Error('detalle interno de PostgreSQL'), {
              code: '23505',
              constraint,
            });
          }
          return { rows: [] };
        },
      });
      const transaccion = crearTransaccionPg({ pool: falso.pool });

      await assert.rejects(
        transaccion.ejecutar((repositorios) =>
          repositorios.asignaciones.abrir({
            id: 'asignacion-1',
            viajeId: 'viaje-1',
            choferId: 'chofer-1',
            desde: new Date(),
          })
        ),
        (error) => error.codigo === codigo && !error.message.includes('detalle interno')
      );
      assert.equal(falso.consultas.at(-1).sql, 'ROLLBACK');
      assert.equal(falso.obtenerConteos().liberaciones, 1);
    });
  }
});

test('traduce deadlock y serialización a conflictos concurrentes', async (t) => {
  for (const codigoPg of ['40P01', '40001']) {
    await t.test(codigoPg, async () => {
      const falso = crearPoolFalso();
      const transaccion = crearTransaccionPg({ pool: falso.pool });
      await assert.rejects(
        transaccion.ejecutar(() => {
          throw Object.assign(new Error('mensaje de PostgreSQL'), { code: codigoPg });
        }),
        (error) =>
          error.codigo === 'CONFLICTO_CONCURRENTE' &&
          !error.message.includes('mensaje de PostgreSQL')
      );
      assert.equal(falso.obtenerConteos().liberaciones, 1);
    });
  }
});
