import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { ErrorDatosInvalidos } from '../../../dominio/viajes/errores.js';

export const estadosHttpViajes = Object.freeze({
  DATOS_INVALIDOS: 400, ACTOR_NO_AUTORIZADO: 403, VIAJE_NO_ENCONTRADO: 404,
  OFERTA_NO_ENCONTRADA: 404, OFERTA_NO_VIGENTE: 409, VIAJE_NO_DISPONIBLE: 409,
  CHOFER_OCUPADO: 409, CHOFER_NO_DISPONIBLE: 409, CONFLICTO_CONCURRENTE: 409,
  CLAVE_REUTILIZADA: 409, VIAJE_FUERA_DE_LIMITE: 422, ERROR_PERSISTENCIA: 500,
});

const punto = z.strictObject({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const trayecto = z.strictObject({ origen: punto, destino: punto });
const vacio = z.strictObject({});
const clavePedido = z.string().trim().min(1).max(64);

function validar(esquema, valor) {
  const resultado = esquema.safeParse(valor);
  if (!resultado.success) throw new ErrorDatosInvalidos('Los datos del pedido son inválidos.');
  return resultado.data;
}

export function crearRutasViajes({ autenticar, requerirRol, estimarViaje, solicitarViaje,
  obtenerViaje, listarOfertasVigentes, aceptarOferta }) {
  const rutas = Router();
  const pasajero = requerirRol('pasajero');
  const chofer = requerirRol('chofer');

  rutas.post('/viajes/estimacion', autenticar, pasajero, async (req, res) => {
    const { distanciaMetros, duracionSegundos, precioCentavos } = await estimarViaje(validar(trayecto, req.body));
    res.json({ distanciaMetros, duracionSegundos, precioCentavos });
  });
  rutas.post('/viajes', autenticar, pasajero, async (req, res) => {
    const puntos = validar(trayecto, req.body);
    const clave = validar(clavePedido, req.get('Idempotency-Key'));
    const hash = createHash('sha256').update(JSON.stringify(puntos)).digest('hex');
    const { viaje } = await solicitarViaje({ pasajero: req.actor, ...puntos, idempotencia: { clave, hash } });
    res.status(201).json({ id: viaje.id, estado: viaje.estado });
  });
  rutas.get('/viajes/:id', autenticar, async (req, res) => {
    const viaje = await obtenerViaje({ actor: req.actor, viajeId: validar(z.uuid(), req.params.id) });
    res.json({ id: viaje.id, estado: viaje.estado });
  });
  rutas.get('/choferes/me/ofertas', autenticar, chofer, async (req, res) => {
    const ofertas = await listarOfertasVigentes({ actor: req.actor });
    res.json({ ofertas: ofertas.map(({ id, viajeId, expiraEn }) => ({ id, viajeId, expiraEn })) });
  });
  rutas.post('/ofertas/:id/aceptar', autenticar, chofer, async (req, res) => {
    validar(vacio, req.body === undefined ? {} : req.body);
    const { viaje, oferta } = await aceptarOferta({ actor: req.actor, ofertaId: validar(z.uuid(), req.params.id) });
    res.json({ viajeId: viaje.id, ofertaId: oferta.id, estado: viaje.estado });
  });
  return rutas;
}
