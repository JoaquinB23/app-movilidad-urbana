// Composicion de dependencias: UNICO lugar que crea los adaptadores concretos
// y los inyecta en casos de uso, rutas y workers (regla hexagonal del
// AGENTS.md). No arranca nada: devuelve la app de Express, los workers SIN
// iniciar y una funcion `cerrar`. Quien decide escuchar y arrancar timers es
// src/servidor.js; asi los tests pueden componer la app real sin timers.
//
// Secciones por modulo, marcadas con comentarios, para que cada integrante
// edite solo la suya (archivo compartido).

import { randomUUID } from 'node:crypto';

import cors from 'cors';
import express from 'express';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import helmet from 'helmet';
import pino from 'pino';

// --- Infra compartida ---
import { crearPoolPg } from './infra/db/pool-pg.js';
import { crearTransaccionPg } from './infra/db/transaccion-pg.js';
import { crearRelojPg } from './infra/db/reloj-pg.js';
import { crearGeneradorIdPg } from './infra/db/generador-id-pg.js';
import { crearBusEventosMemoria } from './infra/memoria/bus-eventos-memoria.js';
import { crearRegistroMetricasMemoria } from './infra/memoria/registro-metricas-memoria.js';
import { crearMonitoreoMetricas } from './infra/http/metricas.js';
import { crearAutenticar, requerirRol } from './infra/http/autenticacion.js';

// --- Identidad, administracion y reasignacion (Persona C) ---
import { crearServiciosIdentidad } from './dominio/identidad/servicios.js';
import { crearReasignarViaje } from './dominio/reasignacion/reasignar-viaje.js';
import { crearHasherArgon2 } from './infra/seguridad/hasher-argon2.js';
import { crearTokensJwt } from './infra/seguridad/tokens-jwt.js';
import { crearRepositorioUsuariosPg } from './infra/db/repo-usuarios-pg.js';
import { crearRepositorioAdministracionPg } from './infra/db/repo-administracion-pg.js';
import { crearRutasAuth, MAPEO_HTTP_IDENTIDAD } from './infra/http/rutas/auth.js';
import { crearRutasAdmin } from './infra/http/rutas/admin.js';
import { crearRutasReasignacion, MAPEO_HTTP_REASIGNACION } from './infra/http/rutas/reasignacion.js';
import { crearWorkerReasignacion } from './workers/reasignacion.js';

// --- Ubicaciones ---
import { crearRepositorioUbicacionesPg } from './infra/db/repositorio-ubicaciones-pg.js';
import { crearRepositorioChoferesPg } from './infra/db/repo-choferes-pg.js';
import { crearRepositorioViajesLecturaPg } from './infra/db/repo-viajes-lectura-pg.js';
import { crearServicioGeoPostgis } from './infra/db/servicio-geo-postgis.js';
import { crearColaHistorial } from './infra/memoria/cola-historial-memoria.js';
import { crearRutasUbicaciones, MAPEO_HTTP as MAPEO_HTTP_UBICACIONES } from './infra/http/rutas/ubicaciones.js';
import { crearWorkerRetencion } from './workers/retencion-ubicaciones.js';

// --- Viajes ---
import { crearEstimarViaje } from './dominio/viajes/casos-de-uso/estimar-viaje.js';
import { crearSolicitarViaje } from './dominio/viajes/casos-de-uso/solicitar-viaje.js';
import { crearObtenerViaje } from './dominio/viajes/casos-de-uso/obtener-viaje.js';
import { crearListarOfertasVigentes } from './dominio/viajes/casos-de-uso/listar-ofertas-vigentes.js';
import { crearAceptarOferta } from './dominio/viajes/casos-de-uso/aceptar-oferta.js';
import { crearRepositorioViajesPg } from './infra/db/repo-viajes-pg.js';
import { crearRepositorioOfertasPg } from './infra/db/repo-ofertas-pg.js';
import { crearRepositorioAsignacionesPg } from './infra/db/repo-asignaciones-pg.js';
import { crearParametrosViajes } from './infra/parametros-viajes.js';
// Calculo puro por haversine, sin estado: sirve como adaptador real mientras
// no haya un servicio externo de rutas. Vive en infra/memoria porque nacio
// para tests; se reutiliza para no duplicar la formula.
import { crearEstimadorRutaEnMemoria } from './infra/memoria/index.js';
import { crearRutasViajes, estadosHttpViajes } from './infra/http/rutas/viajes.js';

// Une los mapeos codigo -> status de cada modulo. Si dos modulos mapean el
// MISMO codigo a status distintos, la app no arranca: un conflicto silencioso
// haria que el mismo error responda distinto segun que modulo lo combino.
export function combinarMapeosHttp(...mapeos) {
  const combinado = {};
  for (const mapeo of mapeos) {
    for (const [codigo, status] of Object.entries(mapeo)) {
      if (codigo in combinado && combinado[codigo] !== status) {
        throw new Error(`Conflicto de mapeo HTTP para '${codigo}': ${combinado[codigo]} vs ${status}.`);
      }
      combinado[codigo] = status;
    }
  }
  return Object.freeze(combinado);
}

const ID_CORRELACION_VALIDO = /^[A-Za-z0-9._-]{1,64}$/;

function responderError(res, status, codigo, mensaje) {
  res.status(status).json({
    error: { codigo, mensaje, idCorrelacion: res.locals.idCorrelacion ?? null },
  });
}

export async function componerAplicacion({ config, logger = pino({ level: config.log.nivel }) }) {
  const pool = crearPoolPg({ connectionString: config.db.url });
  const consulta = (sql, valores) => pool.query(sql, valores);
  const transaccion = crearTransaccionPg({ pool });
  const reloj = crearRelojPg();
  const generadorId = crearGeneradorIdPg();
  // UNA sola instancia del bus: aceptarOferta publica y el SSE de seguimiento
  // escucha en el mismo objeto (acuerdo de trabajo, seccion 1).
  const busEventos = crearBusEventosMemoria();
  const monitoreo = crearMonitoreoMetricas({ registroMetricas: crearRegistroMetricasMemoria() });

  // --- Identidad, administracion y reasignacion (Persona C) ---
  const tokens = crearTokensJwt(config.jwt);
  const hasher = await crearHasherArgon2();
  const autenticar = crearAutenticar({ tokens });
  const repositorioAdministracion = crearRepositorioAdministracionPg({ pool });
  const serviciosIdentidad = crearServiciosIdentidad({
    repositorioUsuarios: crearRepositorioUsuariosPg({ pool }),
    hasher,
    tokens,
    reloj,
  });
  const reasignarViaje = crearReasignarViaje({ transaccion, reloj, generadorId });
  const respuesta429 = (req, res) =>
    responderError(res, 429, 'DEMASIADAS_PETICIONES', 'Limite de tasa superado.');
  const rateLimitLogin = rateLimit({
    windowMs: config.rateLimit.ventanaMs,
    limit: config.rateLimit.loginMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: respuesta429,
  });

  // --- Ubicaciones ---
  const repositorioUbicaciones = crearRepositorioUbicacionesPg({ consulta });
  const colaHistorial = crearColaHistorial({
    escribirLote: (lote) => repositorioUbicaciones.agregarHistorialEnLote(lote),
    maxLote: config.colaHistorial.maxLote,
    intervaloMs: config.colaHistorial.intervaloMs,
  });
  // Clave por chofer, no por IP: detras de un NAT muchos choferes comparten IP
  // y se bloquearian entre si. Corre despues de autenticar, asi que hay actor.
  const rateLimitUbicacion = rateLimit({
    windowMs: config.rateLimit.ventanaMs,
    limit: config.rateLimit.ubicacionMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => req.actor?.id ?? ipKeyGenerator(req.ip),
    handler: respuesta429,
  });
  const servicioGeo = crearServicioGeoPostgis({ consulta });

  // --- Viajes ---
  const estimadorRuta = crearEstimadorRutaEnMemoria();
  const parametrosViajes = crearParametrosViajes({ repositorioAdministracion });
  const repositorioViajes = crearRepositorioViajesPg({ consulta });
  const repositorioAsignaciones = crearRepositorioAsignacionesPg({ consulta });

  // --- Workers (se crean, NO se inician: eso es de servidor.js) ---
  const workers = {
    reasignacion: crearWorkerReasignacion({
      transaccion,
      reasignarViaje,
      repositorioAdministracion,
      logger,
      intervaloMs: config.workers.reasignacionIntervaloMs,
    }),
    retencion: crearWorkerRetencion({
      repositorioUbicaciones,
      dias: config.workers.retencionDias,
      intervaloMs: config.workers.retencionIntervaloMs,
      logger,
    }),
  };

  // --- App HTTP ---
  const mapeoHttp = combinarMapeosHttp(
    MAPEO_HTTP_UBICACIONES,
    MAPEO_HTTP_IDENTIDAD,
    MAPEO_HTTP_REASIGNACION,
    estadosHttpViajes
  );

  const app = express();
  app.disable('x-powered-by');

  // Id de correlacion por pedido: se acepta el del cliente si es seguro (para
  // seguir un pedido entre servicios) y si no se genera uno. Va en el log, en
  // el encabezado X-Request-Id y en todo cuerpo de error.
  app.use((req, res, next) => {
    const recibido = req.get('x-request-id');
    res.locals.idCorrelacion = recibido && ID_CORRELACION_VALIDO.test(recibido) ? recibido : randomUUID();
    res.set('X-Request-Id', res.locals.idCorrelacion);
    const inicio = process.hrtime.bigint();
    res.on('finish', () => {
      logger.info({
        idCorrelacion: res.locals.idCorrelacion,
        metodo: req.method,
        ruta: req.originalUrl.split('?')[0],
        status: res.statusCode,
        ms: Number(process.hrtime.bigint() - inicio) / 1e6,
      }, 'pedido');
    });
    next();
  });
  app.use(helmet());
  app.use(cors({
    origin: config.http.origenesCors.length > 0 ? [...config.http.origenesCors] : false,
    exposedHeaders: ['X-Request-Id'],
  }));
  app.use(express.json({ limit: config.http.limiteCuerpoBytes }));
  app.use(monitoreo.middleware);

  app.get('/health', (req, res) => res.json({ estado: 'ok' }));
  app.get('/ready', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ estado: 'listo' });
    } catch {
      responderError(res, 503, 'NO_LISTO', 'La base de datos no responde.');
    }
  });

  // --- Montaje de rutas (cada router trae el prefijo completo) ---
  app.use(crearRutasAuth({ serviciosIdentidad, autenticar, rateLimitLogin }));
  app.use(crearRutasAdmin({ serviciosIdentidad, repositorioAdministracion, autenticar }));
  app.use(crearRutasReasignacion({
    autenticar,
    reasignarViaje,
    repositorioViajes,
    repositorioAsignaciones,
    obtenerRadioBusquedaM: async () =>
      Number(await repositorioAdministracion.obtenerParametro('radio_busqueda_m')) || 5000,
  }));
  app.use(crearRutasUbicaciones({
    autenticar,
    rateLimitUbicacion,
    repositorioChoferes: crearRepositorioChoferesPg({ consulta }),
    repositorioUbicaciones,
    repositorioViajes: crearRepositorioViajesLecturaPg({ consulta }),
    colaHistorial,
    busEventos,
    metricas: monitoreo,
  }));
  // Viajes se monta con montarViajes (seccion de Viajes, mas abajo): el mismo
  // montaje que prueba tests/seguridad/viajes-http.test.js con adaptadores
  // en memoria, aca con los reales y el bus compartido con el SSE.
  montarViajes(app, {
    autenticar,
    requerirRol,
    transaccion,
    reloj,
    generadorId,
    estimadorRuta,
    parametrosViajes,
    servicioGeo,
    busEventos,
    repositorioViajes,
    repositorioOfertas: crearRepositorioOfertasPg({ consulta }),
    repositorioAsignaciones,
  });

  // --- Ruta inexistente y errores (formato comun) ---
  app.use((req, res) => responderError(res, 404, 'RUTA_NO_ENCONTRADA', 'La ruta no existe.'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // Errores del parser de JSON de Express (cuerpo mal formado o enorme).
    if (err?.type === 'entity.parse.failed') {
      return responderError(res, 400, 'JSON_INVALIDO', 'El cuerpo no es JSON valido.');
    }
    if (err?.type === 'entity.too.large') {
      return responderError(res, 413, 'CUERPO_DEMASIADO_GRANDE', 'El cuerpo supera el limite permitido.');
    }
    const status = mapeoHttp[err?.codigo] ?? 500;
    if (status >= 500) {
      // El detalle solo va al log; al cliente nunca se le filtra (stack, SQL).
      logger.error({ err, idCorrelacion: res.locals.idCorrelacion }, 'error no controlado');
      // Un codigo de dominio mapeado a 500 (ERROR_PERSISTENCIA) se conserva;
      // cualquier otro error inesperado sale como ERROR_INTERNO.
      const codigo = mapeoHttp[err?.codigo] === 500 ? err.codigo : 'ERROR_INTERNO';
      return responderError(res, 500, codigo, 'Error interno del servidor.');
    }
    return responderError(res, status, err.codigo, err.message);
  });

  async function cerrar() {
    workers.reasignacion.detener();
    workers.retencion.detener();
    colaHistorial.detener();
    // Lo encolado todavia no esta en la base: se escribe antes de cerrar el pool.
    await colaHistorial.drenar().catch((err) => logger.error({ err }, 'no se pudo drenar la cola'));
    monitoreo.detener();
    await pool.end();
  }

  return { app, pool, busEventos, colaHistorial, workers, logger, cerrar };
}

// --- Viajes ---
// Monta el router de Viajes con sus casos de uso. `deps` trae los puertos
// (reales desde componerAplicacion, en memoria desde los tests de Viajes).
export function montarViajes(app, deps) {
  app.use(crearRutasViajes({
    autenticar: deps.autenticar,
    requerirRol: deps.requerirRol,
    estimarViaje: crearEstimarViaje(deps),
    solicitarViaje: crearSolicitarViaje(deps),
    obtenerViaje: crearObtenerViaje(deps),
    listarOfertasVigentes: crearListarOfertasVigentes(deps),
    aceptarOferta: crearAceptarOferta(deps),
  }));
}
