// Simulador de choferes del modulo de ubicaciones.
//
// Genera la carga del requisito: >=500 choferes enviando ubicacion cada ~2 s
// durante varios minutos, contra una API levantada. Sirve para:
//   * demostrar el funcionamiento del tracking;
//   * medir el impacto de la tarea pesada (version ingenua vs batcheada) con
//     las mediciones de docs/mediciones.md.
//
// Uso (despues de npm run setup + npm run dev):
//   node scripts/carga/simulador-choferes.js
//   CANTIDAD_CHOFERES=1000 DURACION_SEGUNDOS=60 node scripts/carga/simulador-choferes.js
//
// Variables:
//   API_BASE             base de la API (default http://localhost:3000)
//   CANTIDAD_CHOFERES    cuantos choferes simulan (default 500)
//   INTERVALO_MS         envio por chofer, por defecto 2000
//   DURACION_SEGUNDOS    duracion total de la simulacion (default 300)
//   JWT_SECRETO          si esta presente, el simulador firma sus propios JWT
//                        {sub: choferId, rol: 'chofer'} para autenticarse con el
//                        mismo secreto del servidor. Si no, usa BATCH_TOKEN_HOLDER
//                        que se manda en Authorization tal cual (uso en demo).
//
// Decision: el simulador NO crea cuentas. Los choferes de carga tienen que
// existir y estar habilitados: los crea `npm run carga:seed`, con los MISMOS
// UUID deterministicos (scripts/carga/ids-carga.js). SI los declara
// disponibles al arrancar (PUT disponibilidad), salvo SKIP_DISPONIBILIDAD=1.

import jwt from 'jsonwebtoken';

import { idChoferCarga } from './ids-carga.js';

const API_BASE = process.env.API_BASE ?? 'http://localhost:3000';
const CANTIDAD = Number(process.env.CANTIDAD_CHOFERES ?? 500);
const INTERVALO_MS = Number(process.env.INTERVALO_MS ?? 2000);
const DURACION_SEGUNDOS = Number(process.env.DURACION_SEGUNDOS ?? 300);
const SKIP_DISPONIBILIDAD = process.env.SKIP_DISPONIBILIDAD === '1';
// ACEPTAR_OFERTAS=1: en cada tick cada chofer consulta sus ofertas y acepta la
// primera, como la app real. Hace falta para medir el tiempo hasta la
// asignacion (k6 pide viajes y espera "asignado").
const ACEPTAR_OFERTAS = process.env.ACEPTAR_OFERTAS === '1';

const JWT_SECRETO = process.env.JWT_SECRETO ?? '';
// BATCH_TOKEN_HOLDER: si no se firma JWT, se manda este header (en dev/demo).
const TOKEN = process.env.BATCH_TOKEN_HOLDER ?? '';

// Centro aproximado: Resistencia, Chaco.
const CENTRO = { lat: -27.4514, lng: -58.9866 };

function firmaJwt(choferId) {
  return jwt.sign({ sub: choferId, rol: 'chofer' }, JWT_SECRETO, {
    issuer: process.env.JWT_EMISOR ?? 'app-movilidad-urbana',
    audience: process.env.JWT_AUDIENCIA ?? 'app-movilidad-urbana',
    expiresIn: '1d',
  });
}

function cabeceras(choferId) {
  const auth = JWT_SECRETO ? firmaJwt(choferId) : TOKEN;
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${auth}`,
  };
}

async function responderSiFallido(respuesta, etiqueta) {
  if (!respuesta.ok && respuesta.status !== 202 && respuesta.status !== 200) {
    const cuerpo = await respuesta.text().catch(() => '');
    throw new Error(`${etiqueta}: HTTP ${respuesta.status} ${cuerpo.slice(0, 160)}`);
  }
}

// Crea la cola de choferes con una posicion inicial semi-aleatoria y un "rumbo"
// que da una deriva suave entre envio y envio.
function crearChoferes() {
  return Array.from({ length: CANTIDAD }, (_, i) => {
    const choferId = idChoferCarga(i);
    const fase = (i * 47) % 360;
    return {
      choferId,
      lat: CENTRO.lat + (Math.sin(fase) * 0.05),
      lng: CENTRO.lng + (Math.cos(fase) * 0.05),
      rumbo: Math.random() * Math.PI * 2,
    };
  });
}

async function declararDisponibles(choferes) {
  await Promise.allSettled(
    choferes.map((c) =>
      fetch(`${API_BASE}/choferes/me/disponibilidad`, {
        method: 'PUT',
        headers: cabeceras(c.choferId),
        body: JSON.stringify({ disponible: true }),
      }).then((r) => responderSiFallido(r, `${c.choferId} disponibilidad`))
    )
  );
  const disponibles = choferes.length;
  console.log(`[simulador] ${disponibles} choferes declarados disponibles contra ${API_BASE}`);
}

const SALTO_METROS_APROX = 0.0006;

function tick(chofer) {
  // Deriva suave: cambia el rumbo levemente de vez en cuando para que los
  // choferes no queden fijos (irreal) ni caminen en linea recta.
  if (Math.random() < 0.1) chofer.rumbo += (Math.random() - 0.5);
  chofer.lat += Math.sin(chofer.rumbo) * SALTO_METROS_APROX;
  chofer.lng += Math.cos(chofer.rumbo) * SALTO_METROS_APROX;
}

// Latencia de cada POST /ubicacion (ms) y respuestas no 2xx: la hipotesis 1
// de docs/mediciones.md es sobre este endpoint bajo la carga de 500 choferes.
const latenciasUbicacion = [];
let fallidasUbicacion = 0;

async function enviarUbicaciones(choferes) {
  const timestamp = Date.now();
  // Una ubicacion por chofer por tick. Un fallo puntual no corta el lote.
  await Promise.allSettled(
    choferes.map(async (c) => {
      const inicio = performance.now();
      const respuesta = await fetch(`${API_BASE}/choferes/me/ubicacion`, {
        method: 'POST',
        headers: cabeceras(c.choferId),
        body: JSON.stringify({ lat: Number(c.lat.toFixed(6)), lng: Number(c.lng.toFixed(6)), timestamp }),
      });
      latenciasUbicacion.push(performance.now() - inicio);
      if (respuesta.status !== 202) fallidasUbicacion += 1;
      await responderSiFallido(respuesta, `${c.choferId} ubicacion`);
    })
  );
}

function percentil(ordenados, p) {
  if (ordenados.length === 0) return null;
  return ordenados[Math.max(0, Math.min(ordenados.length - 1, Math.ceil((p / 100) * ordenados.length) - 1))];
}

function resumenUbicaciones() {
  const ordenados = [...latenciasUbicacion].sort((a, b) => a - b);
  const redondear = (v) => (v === null ? null : Number(v.toFixed(2)));
  return {
    enviadas: ordenados.length,
    fallidas: fallidasUbicacion,
    latenciaMs: {
      p50: redondear(percentil(ordenados, 50)),
      p95: redondear(percentil(ordenados, 95)),
      p99: redondear(percentil(ordenados, 99)),
      max: redondear(ordenados.at(-1) ?? null),
    },
  };
}

let aceptadas = 0;

// Consulta y acepta ofertas. 409 (otro chofer gano, la oferta vencio) es un
// resultado normal de la carrera, no un error del simulador.
async function atenderOfertas(choferes) {
  await Promise.allSettled(
    choferes.map(async (c) => {
      const res = await fetch(`${API_BASE}/choferes/me/ofertas`, { headers: cabeceras(c.choferId) });
      if (!res.ok) return;
      const { ofertas } = await res.json();
      if (!ofertas?.length) return;
      const aceptacion = await fetch(`${API_BASE}/ofertas/${ofertas[0].id}/aceptar`, {
        method: 'POST',
        headers: cabeceras(c.choferId),
      });
      if (aceptacion.ok) aceptadas += 1;
    })
  );
}

function imprimirResumen(contador, conErrores) {
  const extra = ACEPTAR_OFERTAS ? ` | ofertas aceptadas: ${aceptadas}` : '';
  process.stdout.write(
    `\r[simulador] tik ${contador} | ubicaciones enviadas: ${contador * CANTIDAD} | errores: ${conErrores}${extra}`
  );
}

async function main() {
  if (CANTIDAD <= 0 || INTERVALO_MS <= 0) {
    console.error('CANTIDAD_CHOFERES e INTERVALO_MS deben ser positivos.');
    process.exit(1);
  }
  const choferes = crearChoferes();

  if (!SKIP_DISPONIBILIDAD) {
    await declararDisponibles(choferes);
  }

  const totalTicks = Math.max(1, Math.round((DURACION_SEGUNDOS * 1000) / INTERVALO_MS));
  let conErrores = 0;
  const inicioCarga = performance.now();
  for (let t = 1; t <= totalTicks; t++) {
    try {
      await enviarUbicaciones(choferes);
      if (ACEPTAR_OFERTAS) await atenderOfertas(choferes);
      for (const c of choferes) tick(c);
    } catch (err) {
      conErrores += 1;
      console.error(`\n[simulador] error en el tick ${t}: ${err.message}`);
    }
    imprimirResumen(t, conErrores);
    // El ultimo tick no necesita esperar.
    if (t < totalTicks) {
      const espera = Math.max(0, inicioCarga + t * INTERVALO_MS - performance.now());
      await new Promise((r) => setTimeout(r, espera));
    }
  }
  console.log('\n[simulador] fin de la simulacion.');
  console.log(`RESUMEN_UBICACIONES ${JSON.stringify({
    ...resumenUbicaciones(), ticks: totalTicks, duracionMs: performance.now() - inicioCarga, aceptadas,
  })}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
