// Corre UNA medicion de docs/mediciones.md de punta a punta y guarda el
// resultado en JSON. Comando copiable (desde la raiz, base levantada y
// `npm run carga:seed` hecho):
//
//   node --env-file=.env scripts/carga/medir-escenario.js --escenario final --corrida 1
//
// Escenarios:
//   base     servidor final, SIN carga: linea de base de GET /health.
//   ingenua  HISTORIAL_MODO=directo (INSERT del historial dentro de cada
//            POST /ubicacion) + 500 choferes enviando cada 2 s.
//   final    HISTORIAL_MODO=cola (cola + escritura por lotes) + misma carga.
//
// Pasos de cada corrida:
//   1. Estado conocido: borra historial y ultimas posiciones de los choferes
//      de carga (todas las corridas arrancan con la misma base).
//   2. Levanta src/servidor.js con la configuracion del escenario.
//   3. Arranca el simulador (si corresponde) y espera el calentamiento.
//   4. GET /metricas?reiniciar=1: la ventana medida no incluye el arranque.
//   5. autocannon contra GET /health durante VENTANA_S (30 s por defecto).
//   6. GET /metricas: lag del event loop (monitorEventLoopDelay) y memoria
//      del servidor en esa ventana.
//   7. Espera el fin del simulador: latencia de POST /ubicacion.
//
// Variables: VENTANA_S (30), CALENTAMIENTO_S (15), CONEXIONES (10),
// CANTIDAD_CHOFERES (500), PUERTO_MEDICION (3100).

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { setTimeout as dormir } from 'node:timers/promises';

import autocannon from 'autocannon';
import jwt from 'jsonwebtoken';
import pg from 'pg';

const ESCENARIOS = {
  base: { env: {}, carga: false },
  ingenua: { env: { HISTORIAL_MODO: 'directo' }, carga: true },
  final: { env: { HISTORIAL_MODO: 'cola' }, carga: true },
};

function argumento(nombre, defecto) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : defecto;
}

const escenario = argumento('escenario');
const corrida = Number(argumento('corrida', '1'));
const carpeta = argumento('salida', 'resultados');
if (!ESCENARIOS[escenario]) {
  console.error(`Uso: --escenario ${Object.keys(ESCENARIOS).join('|')} [--corrida N] [--salida carpeta]`);
  process.exit(1);
}

const VENTANA_S = Number(process.env.VENTANA_S ?? 30);
const CALENTAMIENTO_S = Number(process.env.CALENTAMIENTO_S ?? 15);
const CONEXIONES = Number(process.env.CONEXIONES ?? 10);
const CANTIDAD_CHOFERES = Number(process.env.CANTIDAD_CHOFERES ?? 500);
const PUERTO = Number(process.env.PUERTO_MEDICION ?? 3100);
const API = `http://127.0.0.1:${PUERTO}`;

function percentil(ordenados, p) {
  if (ordenados.length === 0) return null;
  return ordenados[Math.max(0, Math.min(ordenados.length - 1, Math.ceil((p / 100) * ordenados.length) - 1))];
}
const r2 = (v) => (v === null || v === undefined ? null : Number(v.toFixed(2)));

async function estadoConocido(pool) {
  const deCarga = `SELECT id FROM usuarios WHERE email LIKE 'carga-chofer-%@carga.invalid'`;
  await pool.query(`DELETE FROM ubicaciones_historial WHERE chofer_id IN (${deCarga})`);
  await pool.query(`DELETE FROM ubicaciones_actuales WHERE chofer_id IN (${deCarga})`);
  await pool.query(`UPDATE choferes SET disponible = false WHERE usuario_id IN (${deCarga})`);
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM choferes WHERE usuario_id IN (${deCarga})`);
  if (rows[0].n < CANTIDAD_CHOFERES) {
    throw new Error(`Hay ${rows[0].n} choferes de carga y se necesitan ${CANTIDAD_CHOFERES}: corré npm run carga:seed.`);
  }
}

async function entorno(pool) {
  const { rows } = await pool.query('SELECT version() AS pg, postgis_lib_version() AS postgis');
  return {
    so: `${os.type()} ${os.release()} (${os.arch()})`,
    cpu: `${os.cpus()[0]?.model?.trim()} x${os.cpus().length}`,
    ramGb: r2(os.totalmem() / 1024 ** 3),
    node: process.version,
    postgres: rows[0].pg.split(',')[0],
    postgis: rows[0].postgis,
  };
}

function lanzar(args, env, etiqueta) {
  const hijo = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let salida = '';
  hijo.stdout.on('data', (d) => { salida += d; });
  hijo.stderr.on('data', (d) => { salida += d; });
  const fin = new Promise((resolve) => hijo.on('exit', (codigo) => resolve(codigo)));
  return { hijo, fin, salida: () => salida, etiqueta };
}

async function esperarListo() {
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`${API}/ready`)).ok) return;
    } catch { /* todavia no escucha */ }
    await dormir(500);
  }
  throw new Error('El servidor no quedo listo en 30 s.');
}

function medirHealth() {
  return new Promise((resolve, reject) => {
    const latencias = [];
    const porStatus = {};
    const instancia = autocannon({ url: `${API}/health`, connections: CONEXIONES, duration: VENTANA_S }, (error, resultado) => {
      if (error) return reject(error);
      latencias.sort((a, b) => a - b);
      resolve({
        pedidos: latencias.length,
        reqPorS: r2(latencias.length / VENTANA_S),
        latenciaMs: {
          p50: r2(percentil(latencias, 50)),
          p95: r2(percentil(latencias, 95)),
          p99: r2(percentil(latencias, 99)),
          max: r2(latencias.at(-1)),
        },
        porStatus,
        errores: resultado.errors,
      });
    });
    instancia.on('response', (_c, status, _b, ms) => {
      latencias.push(ms);
      porStatus[status] = (porStatus[status] ?? 0) + 1;
    });
  });
}

async function leerMetricas(token, reiniciar = false) {
  const res = await fetch(`${API}/metricas${reiniciar ? '?reiniciar=1' : ''}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`/metricas respondio ${res.status}`);
  return res.json();
}

async function main() {
  const config = ESCENARIOS[escenario];
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  let servidor;
  let simulador;
  try {
    await estadoConocido(pool);
    const datosEntorno = await entorno(pool);

    servidor = lanzar(['src/servidor.js'], {
      PUERTO_HTTP: String(PUERTO),
      HOST: '127.0.0.1',
      LOG_NIVEL: 'warn',
      ...config.env,
    }, 'servidor');
    await esperarListo();

    const tokenAdmin = jwt.sign({ sub: randomUUID(), rol: 'administrador' }, process.env.JWT_SECRETO, {
      algorithm: 'HS256',
      issuer: process.env.JWT_EMISOR ?? 'app-movilidad-urbana',
      audience: process.env.JWT_AUDIENCIA ?? 'app-movilidad-urbana',
      expiresIn: '1h',
    });

    if (config.carga) {
      simulador = lanzar(['scripts/carga/simulador-choferes.js'], {
        API_BASE: API,
        CANTIDAD_CHOFERES: String(CANTIDAD_CHOFERES),
        DURACION_SEGUNDOS: String(CALENTAMIENTO_S + VENTANA_S + 4),
      }, 'simulador');
    }
    console.log(`[${escenario} r${corrida}] calentamiento ${CALENTAMIENTO_S} s...`);
    await dormir(CALENTAMIENTO_S * 1000);

    await leerMetricas(tokenAdmin, true);
    console.log(`[${escenario} r${corrida}] midiendo GET /health ${VENTANA_S} s...`);
    const health = await medirHealth();
    const metricas = await leerMetricas(tokenAdmin);

    let ubicaciones = null;
    if (simulador) {
      await simulador.fin;
      const linea = simulador.salida().split('\n').find((l) => l.startsWith('RESUMEN_UBICACIONES '));
      ubicaciones = linea ? JSON.parse(linea.slice('RESUMEN_UBICACIONES '.length)) : null;
    }

    const resultado = {
      escenario,
      corrida,
      fecha: new Date().toISOString(),
      parametros: { ventanaS: VENTANA_S, calentamientoS: CALENTAMIENTO_S, conexiones: CONEXIONES, choferes: config.carga ? CANTIDAD_CHOFERES : 0, intervaloMs: 2000 },
      entorno: datosEntorno,
      health,
      servidor: {
        lagMaxMs: r2(metricas.eventLoop.lagMaxMs),
        lagP99Ms: r2(metricas.eventLoop.lagP99Ms),
        rssMb: r2(metricas.memoria.rssMb),
        heapUsadoMb: r2(metricas.memoria.heapUsadoMb),
      },
      ubicaciones,
    };
    mkdirSync(carpeta, { recursive: true });
    const archivo = `${carpeta}/${escenario}-r${corrida}.json`;
    writeFileSync(archivo, `${JSON.stringify(resultado, null, 2)}\n`);
    console.log(`RESULTADO ${JSON.stringify(resultado)}`);
    console.log(`Guardado en ${archivo}`);
    const invalida = health.errores > 0 || Object.keys(health.porStatus).some((s) => !s.startsWith('2'))
      || (ubicaciones && ubicaciones.fallidas > 0);
    if (invalida) {
      console.warn('ATENCION: hubo errores o respuestas no 2xx; la corrida no es valida para la tabla.');
      process.exitCode = 2;
    }
  } finally {
    simulador?.hijo.kill();
    servidor?.hijo.kill();
    await servidor?.fin;
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
