// Rutas HTTP del modulo de ubicaciones. Es la UNICA capa que conoce express y
// zod. Todo lo demas (reglas, orquestacion, persistencia) entra por puertos que
// se inyectan en `crearRutasUbicaciones(deps)`.
//
// Decisiones:
// 1) Los esquemas zod usan .strict(): CUALQUIER campo no declarado se rechaza
//    con 400. Eso cubre el requisito de "campos no declarados se rechazan" y,
//    de paso, descarta __proto__/prototype (ver tests de seguridad).
// 2) Todas las dependencias sensibles se exigen en el constructor: si la
//    composicion olvida el rate limit o la autenticacion, el modulo NO arranca
//    (fallar cerrado) en vez de degradarse silenciosamente.
// 3) Se exporta MAPEO_HTTP: la traduccion codigo->status, para que el handler de
//    errores GLOBAL del proyecto use los mismos codigos (el dominio no conoce
//    HTTP; esta capa documenta el contrato).

import { Router } from 'express';
import { z } from 'zod';

import {
  autorizarSeguimiento,
  autorizarRecorrido,
  construirSeguimiento,
  cambiarDisponibilidadChofer,
  registrarUbicacionChofer,
} from '../../../dominio/ubicaciones/servicios.js';
import { ErrorDatosInvalidos } from '../../../dominio/ubicaciones/errores.js';

// --- Esquemas zod estrictos ---

const esquemaTimestamp = z.union([
  z.number().int().nonnegative('timestamp debe ser millis de epoch no negativos'),
  z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'timestamp con formato invalido'),
]);

const esquemaDisponibilidad = z
  .object({ disponible: z.boolean() })
  .strict();

const esquemaUbicacion = z
  .object({
    lat: z.number().min(-90).max(90, 'lat fuera de rango'),
    lng: z.number().min(-180).max(180, 'lng fuera de rango'),
    timestamp: esquemaTimestamp,
  })
  .strict();

const esquemaIdRuta = z.object({ id: z.string().min(1) }).strict();

// Convierte un error de zod en un error de dominio, para que el handler global
// de errores tenga UN solo formato. Traducir aca es correcto: esto es capa web.
function validar(esquema, dato) {
  const resultado = esquema.safeParse(dato);
  if (!resultado.success) {
    const resumen = resultado.error.issues
      .map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`)
      .join('; ');
    throw new ErrorDatosInvalidos(`Validacion rechazada: ${resumen}.`);
  }
  return resultado.data;
}

function exigirRol(...roles) {
  return (req, res, next) => {
    const rol = req.actor?.rol;
    if (!roles.includes(rol)) {
      // 403: el rol no alcanza para esta ruta.
      return res.status(403).json({
        error: {
          codigo: 'ROL_NO_AUTORIZADO',
          mensaje: `Se requiere rol ${roles.join(' o ')}, se recibio ${rol ?? 'ninguno'}.`,
          idCorrelacion: res.locals?.idCorrelacion ?? null,
        },
      });
    }
    next();
  };
}

// Traduccion de codigos de error de dominio a HTTP. La usa el middleware global
// de errores del proyecto; aca se documenta el contrato del modulo.
export const MAPEO_HTTP = Object.freeze({
  DATOS_INVALIDOS: 400,
  COORDENADA_INVALIDA: 400,
  NO_ENCONTRADO: 404,
  RECURSO_AJENO: 403,
  CHOFER_NO_DISPONIBLE: 409,
  TRANSICION_INVALIDA: 409,
  ACTOR_NO_AUTORIZADO: 403,
});

const TIEMPO_LATIDO_MS = 15000;

function formatearEvento(tipo, id, datos) {
  const lineas = [
    `event: ${tipo}`,
    id ? `id: ${id}` : null,
    `data: ${JSON.stringify(datos)}`,
  ].filter(Boolean);
  return `${lineas.join('\n')}\n\n`;
}

function leerUltimoEventId(req) {
  // Prioridad: encabezado Last-Event-ID. Fallback: query (util para probar con
  // curl/SSE nativo de algunos clientes).
  const delHeader = req.headers['last-event-id'];
  if (delHeader !== undefined) return String(delHeader);
  const delQuery = req.query['last-event-id'];
  return delQuery !== undefined ? String(delQuery) : null;
}

const TIEMPO_VIDA_SSE_MS = 60 * 60 * 1000;

export function crearRutasUbicaciones(deps) {
  const {
    autenticar,
    rateLimitUbicacion,
    repositorioChoferes,
    repositorioUbicaciones,
    repositorioViajes,
    colaHistorial,
    busEventos,
    metricas,
  } = deps;

  const faltantes = [
    ['autenticar', autenticar],
    ['rateLimitUbicacion', rateLimitUbicacion],
    ['repositorioChoferes', repositorioChoferes],
    ['repositorioUbicaciones', repositorioUbicaciones],
    ['repositorioViajes', repositorioViajes],
    ['colaHistorial', colaHistorial],
    ['busEventos', busEventos],
    ['metricas', metricas],
  ].filter(([, valor]) => valor === undefined || valor === null);

  if (faltantes.length > 0) {
    throw new Error(
      `crearRutasUbicaciones requiere: ${faltantes.map(([n]) => n).join(', ')}.`
    );
  }

  const rutas = Router();

  // --- PUT /choferes/me/disponibilidad --------------------------------
  rutas.put(
    '/choferes/me/disponibilidad',
    autenticar,
    exigirRol('chofer'),
    async (req, res) => {
      const body = validar(esquemaDisponibilidad, req.body);
      const resultado = await cambiarDisponibilidadChofer({
        repositorioChoferes,
        choferId: req.actor.id,
        disponible: body.disponible,
      });
      res.json(resultado);
    }
  );

  // --- POST /choferes/me/ubicacion -----------------------------------
  // Rate limit PROPIO: esta es la ruta mas caliente del sistema (una ubicacion
  // por chofer cada ~2 s) y un cliente roto podria inundarla. La composicion
  // DEBE claver por actor (keyGenerator: (req) => req.actor.id ?? req.ip) y no
  // por IP pura: detrás de un proxy/NAT comparten IP muchos choferes y se
  // bloquearian entre si. El middleware se inyecta porque su estrategia y su
  // store son decision de la composicion.
  rutas.post(
    '/choferes/me/ubicacion',
    autenticar,
    exigirRol('chofer'),
    rateLimitUbicacion,
    async (req, res) => {
      const body = validar(esquemaUbicacion, req.body);
      await registrarUbicacionChofer({
        repositorioChoferes,
        repositorioUbicaciones,
        colaHistorial,
        repositorioViajes,
        busEventos,
        choferId: req.actor.id,
        lat: body.lat,
        lng: body.lng,
        timestamp: body.timestamp,
      });
      // 202: aceptado, la persistencia pesada (historial) es asincrona.
      res.status(202).json({ encolado: true });
    }
  );

  // --- GET /viajes/:id/estado -----------------------------------------
  rutas.get('/viajes/:id/estado', autenticar, async (req, res, next) => {
    try {
      const params = validar(esquemaIdRuta, req.params);
      const viaje = await repositorioViajes.buscarPorId(params.id);
      const seguimiento = await construirSeguimiento({ viaje, actor: req.actor, repositorioUbicaciones });
      res.json(seguimiento);
    } catch (err) {
      next(err);
    }
  });

  // --- GET /viajes/:id/seguimiento (SSE) ------------------------------
  rutas.get('/viajes/:id/seguimiento', autenticar, async (req, res, next) => {
    let viaje;
    let autorizado;
    try {
      const params = validar(esquemaIdRuta, req.params);
      viaje = await repositorioViajes.buscarPorId(params.id);
      autorizado = autorizarSeguimiento({ viaje, actor: req.actor });
    } catch (err) {
      // Antes de abrir el stream podemos responder error normal de JSON.
      return next(err);
    }

    const canal = `seguimiento:viaje:${viaje.id}`;
    const snapshot = await construirSeguimiento({ viaje, actor: req.actor, repositorioUbicaciones });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // evita que un proxy intermedio bufferize
    });
    res.write(': conectado\n\n');
    res.write(formatearEvento('snapshot', null, { ...snapshot }));

    let cerrado = false;
    const latido = setInterval(() => {
      if (!cerrado) res.write(': ping\n\n');
    }, TIEMPO_LATIDO_MS);
    if (typeof latido.unref === 'function') latido.unref();

    // Timeout duro de la conexion larga: un streaming infinito sin control es
    // una fuga de sockets. El cliente se reconecta con Last-Event-ID.
    const vencimiento = setTimeout(() => res.end(), TIEMPO_VIDA_SSE_MS);
    if (typeof vencimiento.unref === 'function') vencimiento.unref();

    // Se SUSCRIBE ANTES de reenviar los pendientes para no perder lo que llegue
    // mientras tanto. Un evento puede duplicar el ultimo pendiente (caso borde
    // rarisimo): el cliente deduplica por `id` y las posiciones son
    // idempotentes (se sobrescriben).
    const desuscribir = busEventos.suscribir(canal, (evento) => {
      if (!cerrado) {
        res.write(formatearEvento(evento.tipo, evento.id, evento.datos));
      }
    });

    const ultimoId = leerUltimoEventId(req);
    const pendientes = busEventos.eventosDesde(canal, ultimoId);
    for (const evento of pendientes) {
      res.write(formatearEvento(evento.tipo, evento.id, evento.datos));
    }

    res.on('close', () => {
      cerrado = true;
      clearInterval(latido);
      clearTimeout(vencimiento);
      desuscribir();
    });
  });

  // --- GET /viajes/:id/recorrido --------------------------------------
  rutas.get('/viajes/:id/recorrido', autenticar, async (req, res, next) => {
    try {
      const params = validar(esquemaIdRuta, req.params);
      const viaje = await repositorioViajes.buscarPorId(params.id);
      autorizarRecorrido({ viaje, actor: req.actor });
      const historial = await repositorioUbicaciones.historialDeViaje(params.id);
      res.json({
        viajeId: viaje.id,
        recorrido: historial.map(({ lat, lng, timestamp }) => ({ lat, lng, timestamp })),
      });
    } catch (err) {
      next(err);
    }
  });

  // --- GET /metricas ---------------------------------------------------
  rutas.get('/metricas', autenticar, exigirRol('administrador'), metricas.ruta);

  return rutas;
}