// Rutas HTTP de reasignación (Persona C, variante H):
//   * POST /viajes/:id/rechazar-continuar — el CHOFER ASIGNADO rechaza seguir
//     con el viaje; dispara el MISMO caso de uso reasignarViaje que el worker.
//   * GET /viajes/:id/asignaciones — historial de choferes con motivo; lo ven
//     el pasajero del viaje, operador y administrador (autorización POR
//     RECURSO: un id ajeno responde 404, no 403, para no confirmar existencia).

import { Router } from 'express';
import { z } from 'zod';

import { ErrorDatosInvalidos, ErrorNoEncontrado } from '../../../dominio/identidad/errores.js';
import { autorizarRecurso } from '../../../dominio/identidad/autorizacion.js';

export const MAPEO_HTTP_REASIGNACION = Object.freeze({
  DATOS_INVALIDOS: 400,
  NO_ENCONTRADO: 404,
  VIAJE_NO_REASIGNABLE: 409,
  SIN_CANDIDATOS: 409,
  CONFLICTO_CONCURRENTE: 409,
  CHOFER_OCUPADO: 409,
  VIAJE_NO_DISPONIBLE: 409,
});

const esquemaIdRuta = z.object({ id: z.string().uuid('id debe ser un UUID') }).strict();
const esquemaRechazo = z
  .object({ motivo: z.string().min(3).max(500) })
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

export function crearRutasReasignacion(deps) {
  const { autenticar, reasignarViaje, repositorioViajes, repositorioAsignaciones, obtenerRadioBusquedaM } = deps;
  const faltantes = [
    ['autenticar', autenticar],
    ['reasignarViaje', reasignarViaje],
    ['repositorioViajes', repositorioViajes],
    ['repositorioAsignaciones', repositorioAsignaciones],
  ].filter(([, v]) => v === undefined || v === null);
  if (faltantes.length > 0) {
    throw new Error(`crearRutasReasignacion requiere: ${faltantes.map(([n]) => n).join(', ')}.`);
  }

  const rutas = Router();

  rutas.post('/viajes/:id/rechazar-continuar', autenticar, async (req, res, next) => {
    try {
      const params = validar(esquemaIdRuta, req.params);
      const body = validar(esquemaRechazo, req.body);

      // Autorización por recurso: SOLO el chofer actualmente asignado puede
      // rechazar continuar. Cualquier otro actor recibe 404.
      const asignacion = await repositorioAsignaciones.buscarAbiertaPorViaje(params.id);
      if (!asignacion || req.actor.rol !== 'chofer' || req.actor.id !== asignacion.choferId) {
        throw new ErrorNoEncontrado('El viaje solicitado no fue encontrado.');
      }

      const radioM = obtenerRadioBusquedaM ? await obtenerRadioBusquedaM() : 5000;
      const resultado = await reasignarViaje({
        viajeId: params.id,
        asignacionEsperadaId: asignacion.id,
        motivo: `rechazo_chofer: ${body.motivo}`,
        radioBusquedaM: radioM,
      });
      res.json({
        viajeId: resultado.viaje.id,
        estado: resultado.viaje.estado,
        choferAnteriorId: resultado.choferAnteriorId,
        choferNuevoId: resultado.choferNuevoId,
      });
    } catch (err) {
      next(err);
    }
  });

  rutas.get('/viajes/:id/asignaciones', autenticar, async (req, res, next) => {
    try {
      const params = validar(esquemaIdRuta, req.params);
      const viaje = await repositorioViajes.buscarPorId(params.id);
      // Reglas por recurso: pasajero del viaje, operador o admin. El chofer NO
      // ve el historial completo de otros choferes.
      autorizarRecurso({
        actor: req.actor,
        recurso: viaje,
        reglas: {
          pasajero: (actor, recurso) => actor.id === recurso.pasajeroId,
          operador: () => true,
          administrador: () => true,
        },
      });
      const asignaciones = await repositorioAsignaciones.listarPorViaje(params.id);
      res.json({
        viajeId: params.id,
        asignaciones: asignaciones.map((a) => ({
          choferId: a.choferId,
          desde: a.desde,
          hasta: a.hasta,
          motivoFin: a.motivoFin,
          abierta: a.hasta === null,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  return rutas;
}
