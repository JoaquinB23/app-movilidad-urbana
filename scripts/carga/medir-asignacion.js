// Serie 6.6 reproducible, con una base y una API temporales por corrida.
// Ejecutar desde la raíz: node scripts/carga/medir-asignacion.js
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as esperar } from 'node:timers/promises';
import jwt from 'jsonwebtoken';

const ejecutar = promisify(execFile);
const imagenApi = 'movilidad-medicion:local';
const imagenK6 = 'grafana/k6:1.0.0';
const directorio = path.resolve('resultados/asignacion');
const montaje = path.resolve('scripts') + ':/app/scripts:ro';
const entorno = { ...process.env, JWT_SECRETO: randomBytes(32).toString('hex') };
const token = jwt.sign({ sub: randomUUID(), rol: 'administrador' }, entorno.JWT_SECRETO, {
  issuer: 'app-movilidad-urbana', audience: 'app-movilidad-urbana', expiresIn: '12h',
});

async function docker(...args) {
  const { stdout } = await ejecutar('docker', args, { env: entorno, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

async function hastaListo(comprobar) {
  for (let i = 0; i < 90; i++) {
    try { if (await comprobar()) return; } catch { /* servicio arrancando */ }
    await esperar(1000);
  }
  throw new Error('El servicio de medición no estuvo listo en 90 segundos.');
}

async function medir(version, repeticion) {
  console.log('Inicio', version, repeticion);
  const temporales = [];
  try {
    const db = await docker('run', '-d', '--rm', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
      '--network', 'none', 'postgis/postgis:16-3.4');
    temporales.push(db);
    // La API comparte loopback con PG; no se publican puertos ni credenciales.
    const red = ['--network', 'container:' + db];
    await hastaListo(async () => (await docker('exec', db, 'pg_isready', '-h', '127.0.0.1')).includes('accepting'));
    const api = await docker('run', '-d', '--rm', ...red, '-v', montaje, '-e', 'JWT_SECRETO',
      '-e', 'DATABASE_URL=postgres://postgres@127.0.0.1/postgres', '-e', 'LOG_NIVEL=warn', '-e', 'HOST=127.0.0.1',
      '-e', 'GEO_ESTRATEGIA=' + (version === 'final' ? 'postgis' : 'ingenua'),
      '-e', 'HISTORIAL_MODO=' + (version === 'final' ? 'cola' : 'directo'), imagenApi);
    temporales.push(api);
    await hastaListo(async () => (await docker('exec', api, 'node', '-e',
      "fetch('http://localhost:3000/ready').then(r=>console.log(r.status))")) === '200');
    await docker('exec', api, 'node', 'scripts/carga/seed-choferes-carga.js');
    const metricas = async () => JSON.parse(await docker('exec', '-e', 'TOKEN_MEDICION', api, 'node', '-e',
      "fetch('http://localhost:3000/metricas?reiniciar=1',{headers:{authorization:'Bearer '+process.env.TOKEN_MEDICION}}).then(r=>r.text()).then(console.log)"));
    entorno.TOKEN_MEDICION = token;
    await metricas();
    // Línea base sostenida contra el endpoint liviano antes de activar choferes.
    const base = JSON.parse(await docker('run', '--rm', ...red, '-v', montaje, imagenApi, 'node', '-e',
      "const fin=Date.now()+30000;(async()=>{let n=0;while(Date.now()<fin){const r=await fetch('http://localhost:3000/health');if(!r.ok)throw Error(r.status);await r.text();n++;await new Promise(r=>setTimeout(r,100))}console.log(JSON.stringify({pedidos:n}))})()"));
    base.metricas = await metricas();
    const simulacion = docker('exec', '-e', 'ACEPTAR_OFERTAS=1', '-e', 'DURACION_SEGUNDOS=120',
      api, 'node', 'scripts/carga/simulador-choferes.js');
    simulacion.catch(() => {}); // se espera y valida más abajo
    await hastaListo(async () => (await docker('exec', db, 'psql', '-U', 'postgres', '-Atc',
      'SELECT count(*) FROM ubicaciones_actuales')) === '500');
    await metricas();
    // k6 escribe el resumen aun cuando el umbral falle (código 99).
    let salida;
    try {
      salida = await docker('run', '--rm', ...red, '-v', montaje, '-e', 'JWT_SECRETO',
        '-e', 'UMBRAL_ASIGNACION_MS=30000', '-e', 'ESPERA_MAXIMA_MS=60000', '-e', 'DURACION=60s',
        imagenK6, 'run', '--quiet', '--summary-export=/dev/stdout', '/app/scripts/k6/solicitud-viaje.js');
    } catch (error) {
      if (error.code !== 99) throw error;
      salida = error.stdout;
    }
    const resumen = salida.match(/^\{\s*"[\s\S]*?^\}/m);
    if (!resumen) throw new Error('Falta el resumen JSON de k6.');
    const k6 = JSON.parse(resumen[0]).metrics;
    const servidor = await metricas();
    const ubicaciones = JSON.parse((await simulacion).split('RESUMEN_UBICACIONES ')[1]);
    const resultado = { version, repeticion, fecha: new Date().toISOString(), base, k6, servidor, ubicaciones,
      entorno: { cpu: os.cpus()[0].model, ramGiB: os.totalmem() / 2 ** 30, so: os.version(),
        node: await docker('exec', api, 'node', '-v'), docker: await docker('version', '--format', '{{.Server.Version}}'),
        postgres: await docker('exec', db, 'postgres', '--version'), k6: imagenK6 } };
    await writeFile(path.join(directorio, version + '-r' + repeticion + '.json'), JSON.stringify(resultado, null, 2) + '\n');
    console.log('Registrada', version, repeticion, k6.viajes_asignados_en_plazo);
  } finally {
    for (const id of temporales.reverse()) await docker('stop', id);
  }
}

await mkdir(directorio, { recursive: true });
await docker('build', '-t', imagenApi, '.');
await docker('pull', imagenK6);
for (let r = 1; r <= 3; r++) {
  for (const version of ['ingenua', 'final']) {
    const archivo = path.join(directorio, version + '-r' + r + '.json');
    if (process.argv.includes('--continuar') && existsSync(archivo)) continue;
    await medir(version, r);
  }
}
