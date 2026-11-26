// k6: solicitud de viajes y TIEMPO HASTA LA ASIGNACION (enunciado 6.6).
//
// Cada iteracion: un pasajero de carga pide un viaje (POST /viajes con
// Idempotency-Key) y consulta GET /viajes/:id hasta que queda "asignado"
// (o "sin_choferes", o se agota la espera). Las ofertas las aceptan los
// choferes del simulador corriendo con ACEPTAR_OFERTAS=1.
//
// Requisitos previos:
//   npm run carga:seed                                  (500 choferes + 50 pasajeros)
//   npm run dev
//   ACEPTAR_OFERTAS=1 npm run carga:simulador           (en otra terminal)
//
// Ejecutar (k6 en Docker, sin instalar nada):
//   docker run --rm -v "${PWD}/scripts:/scripts" \
//     -e API_BASE=http://host.docker.internal:3000 -e JWT_SECRETO=<el de .env> \
//     -e ESCENARIO=carga -e TASA=2 -e DURACION=60s -e UMBRAL_ASIGNACION_MS=<umbral> \
//     grafana/k6 run /scripts/k6/solicitud-viaje.js
//
// Variables:
//   ESCENARIO             carga (tasa constante, default) | estres (tasa creciente)
//   TASA                  viajes por segundo en "carga" (default 1)
//   DURACION              duracion de "carga" (default 60s; minimo exigido 30s)
//   TASA_MAX              tope de la rampa en "estres" (default 20)
//   CANTIDAD_PASAJEROS    pasajeros de carga sembrados (default 50)
//   UMBRAL_ASIGNACION_MS  si se define, k6 FALLA cuando el p95 del tiempo hasta
//                         la asignacion lo supera. Lo eligen los integrantes y
//                         se escribe en docs/mediciones.md ANTES de medir.
//   ESPERA_MAXIMA_MS      cuanto espera cada viaje la asignacion (default 30000)

import http from 'k6/http';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';
import { sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

import { idPasajeroCarga } from '../carga/ids-carga.js';

const API_BASE = __ENV.API_BASE || 'http://localhost:3000';
const SECRETO = __ENV.JWT_SECRETO;
const CANTIDAD_PASAJEROS = Number(__ENV.CANTIDAD_PASAJEROS || 50);
const ESPERA_MAXIMA_MS = Number(__ENV.ESPERA_MAXIMA_MS || 30000);
const ESCENARIO = __ENV.ESCENARIO || 'carga';
const CENTRO = { lat: -27.4514, lng: -58.9866 };

const tiempoHastaAsignacion = new Trend('tiempo_hasta_asignacion', true);
const asignados = new Counter('viajes_asignados');
const sinChoferes = new Counter('viajes_sin_choferes');
const sinAsignarATiempo = new Counter('viajes_sin_asignar_a_tiempo');

const escenarios = {
  carga: {
    executor: 'constant-arrival-rate',
    rate: Number(__ENV.TASA || 1),
    timeUnit: '1s',
    duration: __ENV.DURACION || '60s',
    preAllocatedVUs: 50,
    maxVUs: 300,
  },
  estres: {
    executor: 'ramping-arrival-rate',
    startRate: 1,
    timeUnit: '1s',
    preAllocatedVUs: 100,
    maxVUs: 600,
    stages: [
      { target: Math.ceil(Number(__ENV.TASA_MAX || 20) / 4), duration: '30s' },
      { target: Math.ceil(Number(__ENV.TASA_MAX || 20) / 2), duration: '30s' },
      { target: Number(__ENV.TASA_MAX || 20), duration: '30s' },
      { target: Number(__ENV.TASA_MAX || 20), duration: '30s' },
    ],
  },
};

const umbrales = { http_req_failed: ['rate<0.01'] };
if (__ENV.UMBRAL_ASIGNACION_MS) {
  umbrales.tiempo_hasta_asignacion = [`p(95)<${Number(__ENV.UMBRAL_ASIGNACION_MS)}`];
}

export const options = {
  scenarios: { [ESCENARIO]: escenarios[ESCENARIO] },
  thresholds: umbrales,
  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
};

function base64url(objeto) {
  return encoding.b64encode(JSON.stringify(objeto), 'rawurl');
}

// JWT HS256 firmado aca: los pasajeros de carga no inician sesion.
function tokenPasajero(id) {
  const ahora = Math.floor(Date.now() / 1000);
  const cabecera = base64url({ alg: 'HS256', typ: 'JWT' });
  const cuerpo = base64url({
    sub: id,
    rol: 'pasajero',
    iss: __ENV.JWT_EMISOR || 'app-movilidad-urbana',
    aud: __ENV.JWT_AUDIENCIA || 'app-movilidad-urbana',
    iat: ahora,
    exp: ahora + 3600,
  });
  const firma = crypto.hmac('sha256', SECRETO, `${cabecera}.${cuerpo}`, 'base64rawurl');
  return `${cabecera}.${cuerpo}.${firma}`;
}

export function setup() {
  if (!SECRETO) throw new Error('Falta JWT_SECRETO (el mismo del servidor).');
  if (!escenarios[ESCENARIO]) throw new Error(`ESCENARIO desconocido: ${ESCENARIO}`);
  const ready = http.get(`${API_BASE}/ready`);
  if (ready.status !== 200) throw new Error(`La API no esta lista: ${ready.status} ${ready.body}`);
}

export default function () {
  const indice = (__VU * 7919 + __ITER) % CANTIDAD_PASAJEROS;
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${tokenPasajero(idPasajeroCarga(indice))}`,
    'Idempotency-Key': `k6-${__VU}-${__ITER}-${Date.now()}`,
  };
  const origen = {
    lat: CENTRO.lat + (Math.random() - 0.5) * 0.04,
    lng: CENTRO.lng + (Math.random() - 0.5) * 0.04,
  };
  const destino = { lat: origen.lat + 0.01, lng: origen.lng + 0.01 };

  const inicio = Date.now();
  const solicitud = http.post(`${API_BASE}/viajes`, JSON.stringify({ origen, destino }), {
    headers,
    tags: { name: 'POST /viajes' },
  });
  if (solicitud.status !== 201) return;
  const { id, estado } = solicitud.json();
  if (estado === 'sin_choferes') {
    sinChoferes.add(1);
    return;
  }

  const consulta = { headers: { authorization: headers.authorization }, tags: { name: 'GET /viajes/:id' } };
  while (Date.now() - inicio < ESPERA_MAXIMA_MS) {
    sleep(0.25);
    const res = http.get(`${API_BASE}/viajes/${id}`, consulta);
    if (res.status === 200 && res.json('estado') === 'asignado') {
      tiempoHastaAsignacion.add(Date.now() - inicio);
      asignados.add(1);
      return;
    }
    if (res.status === 200 && res.json('estado') === 'sin_choferes') {
      sinChoferes.add(1);
      return;
    }
  }
  sinAsignarATiempo.add(1);
}
