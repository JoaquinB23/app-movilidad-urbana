// Rutas HTTP de administración (Persona C). Todas exigen rol administrador.
// Incluye la gestión de los parámetros que consume la variante H (umbral de
// reasignación) y el módulo de asignación (tiempo límite de oferta).

import { Router } from 'express';
import { z } from 'zod';

import { ErrorDatosInvalidos } from '../../../dominio/identidad/errores.js';
import { requerirRol } from '../autenticacion.js';

const esquemaHabilitacion = z.object({ habilitado: z.boolean() }).strict();
const esquemaIdRuta = z.object({ id: z.string().uuid('id debe ser un UUID') }).strict();

const esquemaTarifas = z
  .object({
    bajadaBanderaCentavos: z.number().int().nonnegative(),
    precioKmCentavos: z.number().int().nonnegative(),
    precioMinutoCentavos: z.number().int().nonnegative(),
  })
  .strict();

const esquemaZona = z
  .object({
    nombre: z.string().min(1).max(100),
    multiplicador: z.number().positive().max(99),
    activa: z.boolean(),
  })
  .strict();

// Catálogo CERRADO de parámetros editables: una clave fuera de esta lista es
// 400, nunca un INSERT. Incluye los dos que exige la consigna.
const esquemaParametros = z
  .object({
    tiempo_limite_oferta_s: z.number().int().positive().max(3600).optional(),
    umbral_reasignacion_s: z.number().int().positive().max(86400).optional(),
    radio_busqueda_m: z.number().int().positive().max(100000).optional(),
    tarifa_minima_centavos: z.number().int().nonnegative().max(100_000_000).optional(),
    distancia_maxima_m: z.number().int().positive().max(1_000_000).optional(),
    max_candidatos: z.number().int().positive().max(100).optional(),
  })
  .strict()
  .refine((obj) => Object.keys(obj).length > 0, 'Debe enviarse al menos un parámetro.');

const esquemaFiltroChoferes = z
  .object({ habilitado: z.enum(['true', 'false']).optional() })
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

export function crearRutasAdmin(deps) {
  const { serviciosIdentidad, repositorioAdministracion, autenticar } = deps;
  const faltantes = [
    ['serviciosIdentidad', serviciosIdentidad],
    ['repositorioAdministracion', repositorioAdministracion],
    ['autenticar', autenticar],
  ].filter(([, v]) => v === undefined || v === null);
  if (faltantes.length > 0) {
    throw new Error(`crearRutasAdmin requiere: ${faltantes.map(([n]) => n).join(', ')}.`);
  }

  const rutas = Router();
  const soloAdmin = [autenticar, requerirRol('administrador')];

  // --- choferes -------------------------------------------------------

  rutas.get('/admin/choferes', ...soloAdmin, async (req, res, next) => {
    try {
      const query = validar(esquemaFiltroChoferes, req.query);
      const filtro = query.habilitado === undefined ? {} : { habilitado: query.habilitado === 'true' };
      const choferes = await serviciosIdentidad.listarChoferes(filtro);
      res.json({ choferes });
    } catch (err) {
      next(err);
    }
  });

  rutas.patch('/admin/choferes/:id/habilitacion', ...soloAdmin, async (req, res, next) => {
    try {
      const params = validar(esquemaIdRuta, req.params);
      const body = validar(esquemaHabilitacion, req.body);
      const chofer = await serviciosIdentidad.cambiarHabilitacionChofer({
        choferId: params.id,
        habilitado: body.habilitado,
        adminId: req.actor.id,
      });
      res.json(chofer);
    } catch (err) {
      next(err);
    }
  });

  // --- tarifas --------------------------------------------------------

  rutas.get('/admin/tarifas', ...soloAdmin, async (req, res, next) => {
    try {
      res.json(await repositorioAdministracion.obtenerTarifas());
    } catch (err) {
      next(err);
    }
  });

  rutas.put('/admin/tarifas', ...soloAdmin, async (req, res, next) => {
    try {
      const body = validar(esquemaTarifas, req.body);
      const tarifas = await repositorioAdministracion.guardarTarifas({ ...body, adminId: req.actor.id });
      res.json(tarifas);
    } catch (err) {
      next(err);
    }
  });

  // --- zonas ----------------------------------------------------------

  rutas.get('/admin/zonas', ...soloAdmin, async (req, res, next) => {
    try {
      res.json({ zonas: await repositorioAdministracion.listarZonas() });
    } catch (err) {
      next(err);
    }
  });

  rutas.put('/admin/zonas', ...soloAdmin, async (req, res, next) => {
    try {
      const body = validar(esquemaZona, req.body);
      res.json(await repositorioAdministracion.guardarZona(body));
    } catch (err) {
      next(err);
    }
  });

  // --- parámetros -----------------------------------------------------

  rutas.get('/admin/parametros', ...soloAdmin, async (req, res, next) => {
    try {
      res.json(await repositorioAdministracion.obtenerParametros());
    } catch (err) {
      next(err);
    }
  });

  rutas.put('/admin/parametros', ...soloAdmin, async (req, res, next) => {
    try {
      const body = validar(esquemaParametros, req.body);
      const resultado = {};
      for (const [clave, valor] of Object.entries(body)) {
        const guardado = await repositorioAdministracion.guardarParametro({
          clave,
          valor,
          adminId: req.actor.id,
        });
        if (!guardado) throw new ErrorDatosInvalidos(`El parámetro '${clave}' no existe.`);
        resultado[guardado.clave] = guardado.valor;
      }
      res.json(resultado);
    } catch (err) {
      next(err);
    }
  });

  return rutas;
}
