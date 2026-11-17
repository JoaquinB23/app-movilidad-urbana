// Rutas HTTP de autenticación (módulo identidad, Persona C). Única capa que
// conoce express y zod. Mismas decisiones que rutas/ubicaciones.js:
//   * zod .strict(): cualquier campo no declarado (incluido __proto__ /
//     constructor.prototype) se rechaza con 400.
//   * dependencias sensibles obligatorias en el constructor (fallar cerrado):
//     sin rate limit de login, el módulo no arranca.
//   * MAPEO_HTTP exportado para el handler global de errores.

import { Router } from 'express';
import { z } from 'zod';

import { ErrorDatosInvalidos } from '../../../dominio/identidad/errores.js';

export const MAPEO_HTTP_IDENTIDAD = Object.freeze({
  DATOS_INVALIDOS: 400,
  CREDENCIALES_INVALIDAS: 401,
  CUENTA_INACTIVA: 403,
  ROL_NO_AUTORIZADO: 403,
  NO_ENCONTRADO: 404,
  EMAIL_EN_USO: 409,
  PATENTE_EN_USO: 409,
});

const esquemaRegistroPasajero = z
  .object({
    email: z.string().max(255),
    password: z.string().min(8).max(128),
    nombre: z.string().min(1).max(255),
  })
  .strict();

const esquemaRegistroChofer = z
  .object({
    email: z.string().max(255),
    password: z.string().min(8).max(128),
    nombre: z.string().min(1).max(255),
    vehiculo: z
      .object({
        patente: z.string().min(1).max(10),
        marca: z.string().min(1).max(100),
        modelo: z.string().min(1).max(100),
        color: z.string().min(1).max(50),
      })
      .strict(),
  })
  .strict();

const esquemaLogin = z
  .object({ email: z.string().max(255), password: z.string().max(128) })
  .strict();

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

export function crearRutasAuth(deps) {
  const { serviciosIdentidad, autenticar, rateLimitLogin } = deps;
  const faltantes = [
    ['serviciosIdentidad', serviciosIdentidad],
    ['autenticar', autenticar],
    ['rateLimitLogin', rateLimitLogin],
  ].filter(([, v]) => v === undefined || v === null);
  if (faltantes.length > 0) {
    throw new Error(`crearRutasAuth requiere: ${faltantes.map(([n]) => n).join(', ')}.`);
  }

  const rutas = Router();

  rutas.post('/auth/registro/pasajero', async (req, res, next) => {
    try {
      const body = validar(esquemaRegistroPasajero, req.body);
      const perfil = await serviciosIdentidad.registrarPasajero(body);
      res.status(201).json(perfil);
    } catch (err) {
      next(err);
    }
  });

  rutas.post('/auth/registro/chofer', async (req, res, next) => {
    try {
      const body = validar(esquemaRegistroChofer, req.body);
      const perfil = await serviciosIdentidad.registrarChofer(body);
      // El chofer queda NO habilitado: lo habilita un administrador.
      res.status(201).json(perfil);
    } catch (err) {
      next(err);
    }
  });

  // Rate limit propio: el login es el blanco de fuerza bruta de credenciales.
  rutas.post('/auth/login', rateLimitLogin, async (req, res, next) => {
    try {
      const body = validar(esquemaLogin, req.body);
      const sesion = await serviciosIdentidad.iniciarSesion(body);
      res.json(sesion);
    } catch (err) {
      next(err);
    }
  });

  rutas.get('/me', autenticar, async (req, res, next) => {
    try {
      const perfil = await serviciosIdentidad.obtenerPerfil({ usuarioId: req.actor.id });
      res.json(perfil);
    } catch (err) {
      next(err);
    }
  });

  return rutas;
}
