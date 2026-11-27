// Corre scripts/k6/solicitud-viaje.js en Docker (grafana/k6) con un solo
// comando y, si hay credenciales de Grafana Cloud en el entorno, manda las
// metricas de k6 al mismo Prometheus que Alloy: el dashboard muestra la prueba
// desde el cliente (k6) y desde el servidor (/metrics) en el mismo intervalo.
//
//   npm run carga:k6 -- estres          # rampa 1 -> 20 viajes/s (4 etapas de 30 s)
//   npm run carga:k6 -- carga           # tasa fija (TASA, DURACION)
//
// Variables (de .env):
//   JWT_SECRETO                                    obligatorio (el de la API)
//   PUERTO_HTTP                                    puerto de la API (3000)
//   GRAFANA_CLOUD_PROM_URL / _USUARIO / _API_KEY   si estan, k6 envia a Grafana Cloud
//   GRAFANA_DASHBOARD_URL                          opcional: link al dashboard; al
//                                                  final se imprime con el intervalo
//   TASA_MAX, TASA, DURACION, UMBRAL_ASIGNACION_MS se pasan tal cual al script
//
// Los secretos se pasan a Docker por NOMBRE (-e VAR sin valor): no quedan en la
// linea de comando ni en la salida.

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ESCENARIOS = ['estres', 'carga'];
const escenario = process.argv[2] ?? 'estres';
if (!ESCENARIOS.includes(escenario)) {
  console.error(`Escenario desconocido: ${escenario}. Usá: ${ESCENARIOS.join(' | ')}`);
  process.exit(1);
}
if (!process.env.JWT_SECRETO) {
  console.error('Falta JWT_SECRETO (corré con: npm run carga:k6 -- estres).');
  process.exit(1);
}

const inicio = new Date();
const testid = `${escenario}-${inicio.toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
const puerto = process.env.PUERTO_HTTP ?? '3000';
const raiz = resolve(import.meta.dirname, '..', '..');
mkdirSync(resolve(raiz, 'resultados', 'k6'), { recursive: true });

const env = {
  ...process.env,
  API_BASE: process.env.K6_API_BASE ?? `http://host.docker.internal:${puerto}`,
  ESCENARIO: escenario,
};
const args = [
  'run', '--rm',
  '-v', `${resolve(raiz, 'scripts')}:/scripts`,
  '-v', `${resolve(raiz, 'resultados', 'k6')}:/salida`,
  '-e', 'API_BASE', '-e', 'JWT_SECRETO', '-e', 'ESCENARIO',
];
for (const nombre of ['TASA_MAX', 'TASA', 'DURACION', 'UMBRAL_ASIGNACION_MS', 'CANTIDAD_PASAJEROS', 'ESPERA_MAXIMA_MS']) {
  if (process.env[nombre]) args.push('-e', nombre);
}

// Prometheus remote write: Grafana Cloud (las mismas credenciales que Alloy)
// o, para probar sin cuenta, K6_PROM_URL apuntando a un Prometheus local.
const urlPrometheus = process.env.K6_PROM_URL ?? process.env.GRAFANA_CLOUD_PROM_URL;
const k6Args = ['run', '--summary-export', `/salida/${testid}.json`, '--tag', `testid=${testid}`];
if (urlPrometheus) {
  env.K6_PROMETHEUS_RW_SERVER_URL = urlPrometheus;
  // p95 acumulado desde el inicio: su ultimo valor coincide con el resumen de k6.
  env.K6_PROMETHEUS_RW_TREND_STATS = 'p(95),p(99),avg,max';
  env.K6_PROMETHEUS_RW_PUSH_INTERVAL = '5s';
  args.push('-e', 'K6_PROMETHEUS_RW_SERVER_URL', '-e', 'K6_PROMETHEUS_RW_TREND_STATS', '-e', 'K6_PROMETHEUS_RW_PUSH_INTERVAL');
  if (!process.env.K6_PROM_URL && process.env.GRAFANA_CLOUD_PROM_USUARIO) {
    env.K6_PROMETHEUS_RW_USERNAME = process.env.GRAFANA_CLOUD_PROM_USUARIO;
    env.K6_PROMETHEUS_RW_PASSWORD = process.env.GRAFANA_CLOUD_API_KEY ?? '';
    args.push('-e', 'K6_PROMETHEUS_RW_USERNAME', '-e', 'K6_PROMETHEUS_RW_PASSWORD');
  }
  k6Args.push('-o', 'experimental-prometheus-rw');
}
args.push('grafana/k6:2.4.0', ...k6Args, `/scripts/k6/solicitud-viaje.js`);

console.log(`k6 · escenario ${escenario} · testid ${testid}`);
console.log(urlPrometheus
  ? `Métricas de k6 → ${process.env.K6_PROM_URL ? 'Prometheus local' : 'Grafana Cloud'}`
  : 'Sin GRAFANA_CLOUD_PROM_URL: k6 no envía métricas (solo el resumen en pantalla).');
console.log(`Inicio: ${inicio.toLocaleTimeString('es-AR')}\n`);

const hijo = spawn('docker', args, { env, stdio: 'inherit' });
hijo.on('exit', (codigo) => {
  const fin = new Date();
  console.log(`\nInicio: ${inicio.toLocaleTimeString('es-AR')} · Fin: ${fin.toLocaleTimeString('es-AR')} · testid ${testid}`);
  console.log(`Resumen guardado en resultados/k6/${testid}.json`);
  if (process.env.GRAFANA_DASHBOARD_URL) {
    // 30 s de margen a cada lado para ver la subida y la bajada.
    const desde = inicio.getTime() - 30_000;
    const hasta = fin.getTime() + 30_000;
    const url = new URL(process.env.GRAFANA_DASHBOARD_URL);
    url.searchParams.set('from', String(desde));
    url.searchParams.set('to', String(hasta));
    url.searchParams.set('var-testid', testid);
    url.searchParams.delete('refresh');
    url.searchParams.set('kiosk', '');
    console.log(`Dashboard de esta corrida: ${url}`);
  }
  process.exit(codigo ?? 1);
});
