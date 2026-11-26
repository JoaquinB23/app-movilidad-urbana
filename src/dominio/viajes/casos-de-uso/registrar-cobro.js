// Cobro (simulado) de un viaje finalizado, IDEMPOTENTE con Idempotency-Key.
//
// Dos capas, para dos fallas distintas:
//   1. Reintento del MISMO pedido (la red se corto y el cliente reintenta con
//      la misma clave): claves_idempotencia devuelve la respuesta original y
//      no se cobra de nuevo. Misma clave con otro cuerpo -> CLAVE_REUTILIZADA.
//   2. Dos pedidos DISTINTOS para el mismo viaje (doble click con claves
//      nuevas, dos dispositivos): el indice unico cobros_un_cobro_por_viaje
//      deja pasar uno solo; el otro recibe YA_COBRADO.
// El viaje se bloquea (FOR UPDATE) al principio: los cobros del mismo viaje
// se serializan y el segundo ve el cobro del primero ya confirmado.

import { ErrorDatosInvalidos, ErrorReglaViaje, ErrorViajeNoEncontrado } from '../errores.js';

export function crearRegistrarCobro({ transaccion, reloj, generadorId }) {
  if (typeof transaccion?.ejecutar !== 'function') {
    throw new ErrorDatosInvalidos('El puerto Transaccion es obligatorio.');
  }
  if (typeof reloj?.ahora !== 'function' || typeof generadorId?.nuevo !== 'function') {
    throw new ErrorDatosInvalidos('Los puertos Reloj y GeneradorId son obligatorios.');
  }

  return async function registrarCobro({ actor, viajeId, idempotencia } = {}) {
    if (actor?.rol !== 'pasajero') throw new ErrorViajeNoEncontrado();
    if (!idempotencia?.clave || !idempotencia?.hash) {
      throw new ErrorDatosInvalidos('El cobro requiere Idempotency-Key.');
    }

    return transaccion.ejecutar(async (repos) => {
      const previa = await repos.idempotencia.reservar(actor.id, idempotencia.clave, idempotencia.hash);
      if (previa) {
        if (previa.hash !== idempotencia.hash) {
          throw new ErrorReglaViaje('CLAVE_REUTILIZADA', 'La clave ya corresponde a otro pedido.');
        }
        return { ...previa.respuesta, repetido: true };
      }

      const viaje = await repos.viajes.buscarPorIdParaActualizar(viajeId);
      if (!viaje || viaje.pasajeroId !== actor.id) throw new ErrorViajeNoEncontrado();
      if (viaje.estado !== 'finalizado' || !Number.isInteger(viaje.tarifaFinalCentavos)) {
        throw new ErrorReglaViaje('VIAJE_NO_FINALIZADO', 'Solo se cobra un viaje finalizado.');
      }
      if (await repos.cobros.buscarPorViaje(viaje.id)) {
        throw new ErrorReglaViaje('YA_COBRADO', 'El viaje ya fue cobrado.');
      }

      const cobro = {
        id: generadorId.nuevo(),
        viajeId: viaje.id,
        pasajeroId: actor.id,
        importeCentavos: viaje.tarifaFinalCentavos,
        estado: 'aprobado',
        creadoEn: reloj.ahora(),
      };
      await repos.cobros.crear(cobro);
      const respuesta = {
        cobroId: cobro.id,
        viajeId: cobro.viajeId,
        importeCentavos: cobro.importeCentavos,
        estado: cobro.estado,
      };
      await repos.idempotencia.completar(actor.id, idempotencia.clave, respuesta);
      return { ...respuesta, repetido: false };
    });
  };
}
