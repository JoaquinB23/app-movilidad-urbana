// Configuracion validada del proceso. UNICO lugar que lee process.env para la
// aplicacion: el resto recibe el objeto ya validado y congelado.
//
// Decision: validar TODO al arrancar (fallar rapido). Un JWT_SECRETO corto o
// una DATABASE_URL faltante tiene que impedir que el servidor levante, con un
// mensaje que nombre la variable, y no aparecer como un 500 en el primer
// request. Alternativa descartada: leer process.env donde se necesita
// (errores tardios y valores por defecto dispersos).

import { z } from 'zod';

const entero = (defecto, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) =>
  z.coerce.number().int().min(min).max(max).default(defecto);

const esquemaEntorno = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('localhost'),
  PUERTO_HTTP: entero(3000, { min: 0, max: 65535 }),
  LOG_NIVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().url('DATABASE_URL debe ser una URL postgres://').refine(
    (url) => /^postgres(ql)?:\/\//.test(url),
    'DATABASE_URL debe empezar con postgres://'
  ),

  JWT_SECRETO: z.string().min(32, 'JWT_SECRETO debe tener al menos 32 caracteres'),
  JWT_EMISOR: z.string().min(1).default('app-movilidad-urbana'),
  JWT_AUDIENCIA: z.string().min(1).default('app-movilidad-urbana'),
  JWT_EXPIRACION: z.string().min(1).default('8h'),

  CORS_ORIGENES: z.string().default(''),
  LIMITE_CUERPO_BYTES: entero(102400, { max: 10 * 1024 * 1024 }),
  RATE_LIMIT_VENTANA_MS: entero(60000),
  RATE_LIMIT_LOGIN_MAX: entero(10),
  RATE_LIMIT_UBICACION_MAX: entero(60),

  COLA_HISTORIAL_MAX_LOTE: entero(200),
  COLA_HISTORIAL_INTERVALO_MS: entero(1000, { min: 0 }),
  WORKER_REASIGNACION_INTERVALO_MS: entero(10000),
  RETENCION_DIAS: entero(90),
  RETENCION_INTERVALO_MS: entero(3600000),
  APAGADO_TIMEOUT_MS: entero(10000),
});

export class ErrorConfiguracion extends Error {
  constructor(problemas) {
    super(`Configuracion invalida:\n${problemas.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ErrorConfiguracion';
    this.problemas = problemas;
  }
}

export function cargarConfiguracion(env = process.env) {
  // Variables definidas pero vacias cuentan como ausentes (asi aplican los
  // defaults en vez de fallar con "" como numero).
  const limpio = Object.fromEntries(
    Object.entries(env).filter(([, valor]) => valor !== undefined && valor !== '')
  );
  const resultado = esquemaEntorno.safeParse(limpio);
  if (!resultado.success) {
    throw new ErrorConfiguracion(
      resultado.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    );
  }
  const e = resultado.data;

  return Object.freeze({
    entorno: e.NODE_ENV,
    http: Object.freeze({
      host: e.HOST,
      puerto: e.PUERTO_HTTP,
      origenesCors: Object.freeze(
        e.CORS_ORIGENES.split(',').map((o) => o.trim()).filter(Boolean)
      ),
      limiteCuerpoBytes: e.LIMITE_CUERPO_BYTES,
      apagadoTimeoutMs: e.APAGADO_TIMEOUT_MS,
    }),
    log: Object.freeze({ nivel: e.LOG_NIVEL }),
    db: Object.freeze({ url: e.DATABASE_URL }),
    rateLimit: Object.freeze({
      ventanaMs: e.RATE_LIMIT_VENTANA_MS,
      loginMax: e.RATE_LIMIT_LOGIN_MAX,
      ubicacionMax: e.RATE_LIMIT_UBICACION_MAX,
    }),
    colaHistorial: Object.freeze({
      maxLote: e.COLA_HISTORIAL_MAX_LOTE,
      intervaloMs: e.COLA_HISTORIAL_INTERVALO_MS,
    }),
    workers: Object.freeze({
      reasignacionIntervaloMs: e.WORKER_REASIGNACION_INTERVALO_MS,
      retencionDias: e.RETENCION_DIAS,
      retencionIntervaloMs: e.RETENCION_INTERVALO_MS,
    }),
    // Lo leen los adaptadores de seguridad con su propio formato (JWT_*,
    // ARGON2_*); se pasa el entorno ya validado para JWT.
    jwt: Object.freeze({
      JWT_SECRETO: e.JWT_SECRETO,
      JWT_EMISOR: e.JWT_EMISOR,
      JWT_AUDIENCIA: e.JWT_AUDIENCIA,
      JWT_EXPIRACION: e.JWT_EXPIRACION,
    }),
  });
}
