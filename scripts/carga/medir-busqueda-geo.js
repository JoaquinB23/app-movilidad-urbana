// Medicion de la hipotesis 3 de docs/mediciones.md: busqueda de candidatos
// ingenua (trae todos los disponibles y calcula Haversine en JS) contra
// PostGIS (ST_DWithin + KNN con indice GiST), con N choferes posicionados.
//
//   npm run carga:seed                    (con CANTIDAD_CHOFERES=5000)
//   node --env-file=.env scripts/carga/medir-busqueda-geo.js --estrategia postgis --corrida 1
//   node --env-file=.env scripts/carga/medir-busqueda-geo.js --estrategia ingenua --corrida 1
//
// Mide el ADAPTADOR directamente contra la base real (sin HTTP en el medio):
// durante VENTANA_S hace busquedas con CONCURRENCIA pedidos en vuelo y
// registra latencia de cada una, busquedas por segundo y el lag del event
// loop de ESTE proceso con monitorEventLoopDelay (la version ingenua calcula
// en el hilo de JS, que es lo que la hipotesis dice que bloquea).
//
// Preparacion (deja la base en estado conocido, igual para las dos versiones):
// los N choferes de carga quedan disponibles con una posicion fija y
// determinista repartida en ~10 km alrededor del centro.

import { mkdirSync, writeFileSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';

import pg from 'pg';

import { crearServicioGeoPostgis } from '../../src/infra/db/servicio-geo-postgis.js';
import { crearServicioGeoIngenuo } from '../../src/infra/db/servicio-geo-ingenuo.js';

function argumento(nombre, defecto) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : defecto;
}

const estrategia = argumento('estrategia');
const corrida = Number(argumento('corrida', '1'));
const carpeta = argumento('salida', 'resultados');
const VENTANA_S = Number(process.env.VENTANA_S ?? 30);
const CONCURRENCIA = Number(process.env.CONCURRENCIA ?? 10);
const CANTIDAD = Number(process.env.CANTIDAD_CHOFERES ?? 5000);
const CENTRO = { lat: -27.4514, lng: -58.9866 };
const BUSQUEDA = { radioMetros: 5000, limite: 5 };

if (!['postgis', 'ingenua'].includes(estrategia)) {
  console.error('Uso: --estrategia postgis|ingenua [--corrida N] [--salida carpeta]');
  process.exit(1);
}

function percentil(ordenados, p) {
  if (ordenados.length === 0) return null;
  return ordenados[Math.max(0, Math.min(ordenados.length - 1, Math.ceil((p / 100) * ordenados.length) - 1))];
}
const r2 = (v) => (v === null || v === undefined ? null : Number(v.toFixed(2)));

async function preparar(pool) {
  const deCarga = `SELECT id FROM usuarios WHERE email LIKE 'carga-chofer-%@carga.invalid'`;
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM choferes WHERE usuario_id IN (${deCarga})`);
  if (rows[0].n < CANTIDAD) {
    throw new Error(`Hay ${rows[0].n} choferes de carga y se necesitan ${CANTIDAD}: CANTIDAD_CHOFERES=${CANTIDAD} npm run carga:seed.`);
  }
  // Solo los choferes de carga compiten: nadie mas disponible ni ocupado.
  await pool.query(`UPDATE choferes SET disponible = (usuario_id IN (${deCarga}))`);
  await pool.query(`DELETE FROM ubicaciones_actuales`);
  // Posicion determinista: espiral de ~10 km de radio alrededor del centro.
  await pool.query(
    `INSERT INTO ubicaciones_actuales (chofer_id, geom, timestamp)
     SELECT c.usuario_id,
            ST_SetSRID(ST_MakePoint(
              $2 + (0.09 * sqrt(n::float / $3)) * cos(n * 2.399963),
              $1 + (0.09 * sqrt(n::float / $3)) * sin(n * 2.399963)
            ), 4326)::geography,
            now()
     FROM (SELECT usuario_id, row_number() OVER (ORDER BY usuario_id) - 1 AS n
           FROM choferes WHERE usuario_id IN (${deCarga})) c`,
    [CENTRO.lat, CENTRO.lng, CANTIDAD]
  );
  // VACUUM (no solo ANALYZE): cada preparacion borra y reinserta N filas y
  // actualiza N choferes. Sin vacuum, el indice GiST se infla corrida a
  // corrida y el autovacuum puede arrancar EN MEDIO de la ventana medida:
  // en la primera serie eso llevo el p95 de PostGIS de 6,6 ms a ~430 ms
  // (ver docs/mediciones.md). VACUUM no corre dentro de una transaccion.
  await pool.query('VACUUM (ANALYZE) ubicaciones_actuales');
  await pool.query('VACUUM (ANALYZE) choferes');
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: CONCURRENCIA + 2 });
  const consulta = (sql, valores) => pool.query(sql, valores);
  const servicio = estrategia === 'postgis' ? crearServicioGeoPostgis({ consulta }) : crearServicioGeoIngenuo({ consulta });
  try {
    await preparar(pool);
    // Calentamiento: planes cacheados y conexiones abiertas en ambas versiones.
    for (let i = 0; i < 20; i += 1) await servicio.buscarCandidatos({ ...CENTRO, ...BUSQUEDA });

    const lag = monitorEventLoopDelay({ resolution: 10 });
    lag.enable();
    const latencias = [];
    const fin = Date.now() + VENTANA_S * 1000;
    let semilla = 1;
    async function trabajador() {
      while (Date.now() < fin) {
        semilla = (semilla * 48271) % 2147483647;
        const desplazamiento = ((semilla % 1000) / 1000 - 0.5) * 0.05;
        const inicio = performance.now();
        await servicio.buscarCandidatos({ lat: CENTRO.lat + desplazamiento, lng: CENTRO.lng - desplazamiento, ...BUSQUEDA });
        latencias.push(performance.now() - inicio);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCIA }, trabajador));
    lag.disable();
    latencias.sort((a, b) => a - b);

    const resultado = {
      estrategia,
      corrida,
      fecha: new Date().toISOString(),
      parametros: { choferes: CANTIDAD, ventanaS: VENTANA_S, concurrencia: CONCURRENCIA, ...BUSQUEDA },
      busquedas: latencias.length,
      busquedasPorS: r2(latencias.length / VENTANA_S),
      latenciaMs: {
        p50: r2(percentil(latencias, 50)),
        p95: r2(percentil(latencias, 95)),
        p99: r2(percentil(latencias, 99)),
        max: r2(latencias.at(-1)),
      },
      lagMs: { max: r2(lag.max / 1e6), p99: r2(lag.percentile(99) / 1e6) },
      rssMb: r2(process.memoryUsage().rss / 1e6),
    };
    mkdirSync(carpeta, { recursive: true });
    writeFileSync(`${carpeta}/geo-${estrategia}-r${corrida}.json`, `${JSON.stringify(resultado, null, 2)}\n`);
    console.log(`RESULTADO ${JSON.stringify(resultado)}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
