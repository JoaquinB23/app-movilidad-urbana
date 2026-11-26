// Carga de fuego con autocannon para las mediciones (docs/mediciones.md).
//
// Objetivos:
//   --health      GET /health   (endpoint liviano: no deberia degradarse)
//   --ready       GET /ready
//   --ubicacion   POST /choferes/me/ubicacion, ROTANDO entre los choferes de
//                 carga y con timestamp unico por pedido
//
// Uso:
//   node --env-file=.env scripts/carga/carga-autocannon.js --health
//   node --env-file=.env scripts/carga/carga-autocannon.js --ubicacion --salida resultados/r1.json
//
// Variables:
//   API_BASE            base de la API (default http://localhost:3000)
//   DURACION_S          duracion en segundos (default 30, el minimo exigido)
//   CONEXIONES          conexiones simultaneas (default 20)
//   CANTIDAD_CHOFERES   choferes de carga entre los que rota --ubicacion (500)
//   JWT_SECRETO         para firmar el JWT de cada chofer (mismo del servidor)
//
// Por que asi:
//   * Un solo chofer con un timestamp fijo no mide nada: el indice unico
//     (chofer_id, timestamp) del historial convierte cada INSERT repetido en
//     un no-op, y el rate limit por chofer responde 429 a los pocos pedidos.
//   * autocannon no reporta p95 (salta de p90 a p97.5) y el enunciado lo pide:
//     se registra la latencia de cada respuesta y se calculan p50/p95/p99.
//   * Los pedidos que no son 2xx se cuentan aparte: una corrida con errores no
//     es una medicion valida y el script lo dice.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import autocannon from 'autocannon';
import jwt from 'jsonwebtoken';

import { idChoferCarga } from './ids-carga.js';

const API_BASE = process.env.API_BASE ?? 'http://localhost:3000';
const DURACION_S = Number(process.env.DURACION_S ?? 30);
const CONEXIONES = Number(process.env.CONEXIONES ?? 20);
const CANTIDAD_CHOFERES = Number(process.env.CANTIDAD_CHOFERES ?? 500);

const argumentos = process.argv.slice(2);
const objetivo = (argumentos.find((a) => /^--(health|ready|ubicacion)$/.test(a)) ?? '--health').slice(2);
const indiceSalida = argumentos.indexOf('--salida');
const archivoSalida = indiceSalida >= 0 ? argumentos[indiceSalida + 1] : null;

function tokensDeCarga() {
  const secreto = process.env.JWT_SECRETO;
  if (!secreto) throw new Error('--ubicacion necesita JWT_SECRETO (corré con --env-file=.env).');
  return Array.from({ length: CANTIDAD_CHOFERES }, (_, i) =>
    jwt.sign({ sub: idChoferCarga(i), rol: 'chofer' }, secreto, {
      algorithm: 'HS256',
      issuer: process.env.JWT_EMISOR ?? 'app-movilidad-urbana',
      audience: process.env.JWT_AUDIENCIA ?? 'app-movilidad-urbana',
      expiresIn: '1h',
    }));
}

function construirConfig() {
  if (objetivo === 'health' || objetivo === 'ready') {
    return { url: `${API_BASE}/${objetivo}`, method: 'GET' };
  }
  const tokens = tokensDeCarga();
  let siguiente = 0;
  // Base de tiempo + contador: timestamps unicos aunque dos pedidos caigan
  // en el mismo milisegundo.
  let secuencia = 0;
  const inicio = Date.now();
  return {
    url: `${API_BASE}/choferes/me/ubicacion`,
    requests: [{
      method: 'POST',
      setupRequest(req) {
        const i = siguiente;
        siguiente = (siguiente + 1) % tokens.length;
        secuencia += 1;
        return {
          ...req,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[i]}` },
          body: JSON.stringify({
            lat: -27.4514 + ((i % 100) - 50) * 0.0005,
            lng: -58.9866 + (Math.floor(i / 100) - 2) * 0.0005,
            timestamp: inicio + secuencia,
          }),
        };
      },
    }],
  };
}

function percentil(ordenados, p) {
  if (ordenados.length === 0) return null;
  const indice = Math.min(ordenados.length - 1, Math.ceil((p / 100) * ordenados.length) - 1);
  return ordenados[Math.max(0, indice)];
}

const latencias = [];
const porStatus = {};

const instancia = autocannon({
  ...construirConfig(),
  connections: CONEXIONES,
  duration: DURACION_S,
  title: `${objetivo} (${DURACION_S}s, ${CONEXIONES} conexiones)`,
});

instancia.on('response', (_cliente, statusCode, _bytes, tiempoMs) => {
  latencias.push(tiempoMs);
  porStatus[statusCode] = (porStatus[statusCode] ?? 0) + 1;
});

autocannon.track(instancia, { renderResultsTable: true, renderLatencyTable: false });

instancia.on('done', (resultado) => {
  latencias.sort((a, b) => a - b);
  const no2xx = Object.entries(porStatus)
    .filter(([status]) => !status.startsWith('2'))
    .reduce((total, [, n]) => total + n, 0);
  const resumen = {
    objetivo,
    fecha: new Date().toISOString(),
    duracionS: DURACION_S,
    conexiones: CONEXIONES,
    pedidos: latencias.length,
    reqPorS: Number((latencias.length / DURACION_S).toFixed(1)),
    latenciaMs: {
      p50: percentil(latencias, 50),
      p95: percentil(latencias, 95),
      p99: percentil(latencias, 99),
      max: latencias.at(-1) ?? null,
    },
    porStatus,
    no2xx,
    erroresConexion: resultado.errors,
    timeouts: resultado.timeouts,
  };
  console.log(`\nRESUMEN ${JSON.stringify(resumen)}`);
  if (no2xx > 0 || resultado.errors > 0) {
    console.warn(`ATENCION: ${no2xx} respuestas no 2xx y ${resultado.errors} errores: la corrida no es valida para la tabla.`);
  }
  if (archivoSalida) {
    mkdirSync(dirname(archivoSalida), { recursive: true });
    writeFileSync(archivoSalida, `${JSON.stringify(resumen, null, 2)}\n`);
    console.log(`Guardado en ${archivoSalida}`);
  }
});

process.once('SIGINT', () => instancia.stop());
