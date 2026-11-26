import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { ErrorDatosInvalidos } from '../../../dominio/viajes/errores.js';

export const estadosHttpViajes = Object.freeze({
  DATOS_INVALIDOS: 400, ACTOR_NO_AUTORIZADO: 403, VIAJE_NO_ENCONTRADO: 404,
  OFERTA_NO_ENCONTRADA: 404, OFERTA_NO_VIGENTE: 409, VIAJE_NO_DISPONIBLE: 409,
  CHOFER_OCUPADO: 409, CHOFER_NO_DISPONIBLE: 409, CONFLICTO_CONCURRENTE: 409,
  CLAVE_REUTILIZADA: 409, VIAJE_FUERA_DE_LIMITE: 422, ERROR_PERSISTENCIA: 500,
  TRANSICION_INVALIDA: 409, YA_COBRADO: 409, VIAJE_NO_FINALIZADO: 409,
});

const punto = z.strictObject({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const trayecto = z.strictObject({ origen: punto, destino: punto });
const vacio = z.strictObject({});
const clavePedido = z.string().trim().min(1).max(64);
const motivoOpcional = z.strictObject({ motivo: z.string().trim().min(1).max(200).optional() });
const motivoObligatorio = z.strictObject({ motivo: z.string().trim().min(3).max(200) });
const paginado = z.strictObject({ limite: z.coerce.number().int().min(1).max(100).optional() });
const filtroOperador = z.strictObject({
  limite: z.coerce.number().int().min(1).max(100).optional(),
  estado: z.enum(['solicitado', 'asignado', 'chofer_en_camino', 'en_curso']).optional(),
});

// Rutas del chofer que avanzan el viaje -> evento de la maquina de estados.
const AVANCES_CHOFER = Object.freeze({
  'en-camino': 'salir_en_camino',
  iniciar: 'iniciar',
  finalizar: 'finalizar',
});

function validar(esquema, valor) {
  const resultado = esquema.safeParse(valor);
  if (!resultado.success) throw new ErrorDatosInvalidos('Los datos del pedido son inválidos.');
  return resultado.data;
}

export function crearRutasViajes({ autenticar, requerirRol, estimarViaje, solicitarViaje,
  obtenerViaje, listarOfertasVigentes, aceptarOferta, rechazarOferta,
  transicionarViaje, registrarCobro, consultasViajes }) {
  const rutas = Router();
  const pasajero = requerirRol('pasajero');
  const chofer = requerirRol('chofer');
  const pasajeroOChofer = requerirRol('pasajero', 'chofer');
  const operador = requerirRol('operador');
  const operadorOAdmin = requerirRol('operador', 'administrador');
  const cuerpo = (req) => (req.body === undefined ? {} : req.body);

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
    // Lo ven el pasajero dueno, el chofer asignado y operador/admin (lo
    // decide obtenerViaje): el chofer necesita saber donde buscar y dejar.
    res.json({
      id: viaje.id,
      estado: viaje.estado,
      origen: viaje.origen,
      destino: viaje.destino,
      tarifaEstimadaCentavos: viaje.tarifaEstimadaCentavos,
      tarifaFinalCentavos: viaje.tarifaFinalCentavos ?? null,
    });
  });
  rutas.get('/choferes/me/ofertas', autenticar, chofer, async (req, res) => {
    const ofertas = await listarOfertasVigentes({ actor: req.actor });
    res.json({
      ofertas: ofertas.map(({ id, viajeId, expiraEn, origen, destino, tarifaEstimadaCentavos }) =>
        ({ id, viajeId, expiraEn, origen, destino, tarifaEstimadaCentavos })),
    });
  });
  rutas.post('/ofertas/:id/aceptar', autenticar, chofer, async (req, res) => {
    validar(vacio, req.body === undefined ? {} : req.body);
    const { viaje, oferta } = await aceptarOferta({ actor: req.actor, ofertaId: validar(z.uuid(), req.params.id) });
    res.json({ viajeId: viaje.id, ofertaId: oferta.id, estado: viaje.estado });
  });
  rutas.post('/ofertas/:id/rechazar', autenticar, chofer, async (req, res) => {
    validar(vacio, req.body === undefined ? {} : req.body);
    const resultado = await rechazarOferta({ actor: req.actor, ofertaId: validar(z.uuid(), req.params.id) });
    res.json(resultado);
  });

  // --- Ciclo de vida despues de la asignacion ---------------------------
  for (const [segmento, evento] of Object.entries(AVANCES_CHOFER)) {
    rutas.post(`/viajes/:id/${segmento}`, autenticar, chofer, async (req, res) => {
      validar(vacio, cuerpo(req));
      res.json(await transicionarViaje({ actor: req.actor, viajeId: validar(z.uuid(), req.params.id), evento }));
    });
  }
  // El evento sale del ROL del token, nunca del cliente.
  rutas.post('/viajes/:id/cancelar', autenticar, pasajeroOChofer, async (req, res) => {
    const { motivo } = validar(motivoOpcional, cuerpo(req));
    const evento = req.actor.rol === 'pasajero' ? 'cancelar_pasajero' : 'cancelar_chofer';
    res.json(await transicionarViaje({ actor: req.actor, viajeId: validar(z.uuid(), req.params.id), evento, motivo }));
  });
  rutas.post('/operador/viajes/:id/cancelar', autenticar, operador, async (req, res) => {
    const { motivo } = validar(motivoObligatorio, cuerpo(req));
    res.json(await transicionarViaje({
      actor: req.actor, viajeId: validar(z.uuid(), req.params.id), evento: 'cancelar_operador', motivo,
    }));
  });

  // --- Cobro (simulado) con Idempotency-Key ------------------------------
  rutas.post('/viajes/:id/cobro', autenticar, pasajero, async (req, res) => {
    validar(vacio, cuerpo(req));
    const viajeId = validar(z.uuid(), req.params.id);
    const clave = validar(clavePedido, req.get('Idempotency-Key'));
    const hash = createHash('sha256').update(`cobro:${viajeId}`).digest('hex');
    const { repetido: _repetido, ...cobro } = await registrarCobro({ actor: req.actor, viajeId, idempotencia: { clave, hash } });
    // Mismo status y cuerpo en el reintento: el cliente no distingue si llego
    // la primera vez o no, que es justamente el punto de la idempotencia.
    res.status(201).json(cobro);
  });

  // --- Historiales y panel del operador -----------------------------------
  rutas.get('/pasajeros/me/viajes', autenticar, pasajero, async (req, res) => {
    const { limite } = validar(paginado, req.query);
    res.json({ viajes: await consultasViajes.historialPasajero({ actor: req.actor, limite }) });
  });
  rutas.get('/choferes/me/viajes', autenticar, chofer, async (req, res) => {
    const { limite } = validar(paginado, req.query);
    res.json({ viajes: await consultasViajes.historialChofer({ actor: req.actor, limite }) });
  });
  rutas.get('/operador/viajes', autenticar, operadorOAdmin, async (req, res) => {
    const { limite, estado } = validar(filtroOperador, req.query);
    res.json({ viajes: await consultasViajes.viajesEnCurso({ actor: req.actor, estado, limite }) });
  });
  rutas.get('/viajes/:id/eventos', autenticar, async (req, res) => {
    const eventos = await consultasViajes.eventosDeViaje({ actor: req.actor, viajeId: validar(z.uuid(), req.params.id) });
    res.json({ eventos });
  });
  return rutas;
}
