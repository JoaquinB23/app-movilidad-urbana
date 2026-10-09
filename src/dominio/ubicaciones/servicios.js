// Casos de uso del modulo de ubicaciones (capa de dominio de aplicacion).
//
// A diferencia de geo.js/candidatos.js (reglas PURAS), aca hay orquestacion:
// se coordinan varios puertos (repositorios, cola, bus). Sigue siendo dominio:
// no importa express ni pg, los puertos se reciben por inyeccion. Asi todos los
// flujos de este modulo se testean sin servidor ni base de datos.

import { validarPunto } from './geo.js';
import {
  ErrorChoferNoDisponible,
  ErrorNoEncontrado,
  ErrorRecursoAjeno,
  ErrorDatosInvalidos,
} from './errores.js';

// ROLES_SEGUIMIENTO: quien participa de un viaje y QUE posicion ve cada uno.
//    pasajero  -> ve la posicion del chofer
//    chofer    -> ve la posicion del pasajero (su ultima ubicacion conocida)
// Cualquier otra combinacion (un chofer ajeno, otro pasajero, un operador sin
// recurso) es RECURSO_AJENO y se traduce a 403/404 en la capa web.
const ROLES_SEGUIMIENTO = Object.freeze({
  pasajero: { aQuienVe: 'choferId' },
  chofer: { aQuienVe: 'pasajeroId' },
});

export function autorizarSeguimiento({ viaje, actor }) {
  if (!viaje || typeof viaje !== 'object') {
    throw new ErrorNoEncontrado('viaje');
  }
  if (!actor || typeof actor.id !== 'string' || actor.id.length === 0) {
    throw new ErrorDatosInvalidos('El actor debe tener un id para el seguimiento.');
  }

  if (actor.id === viaje.pasajeroId) {
    return { rol: 'pasajero', aQuienVe: 'chofer', contraparteId: viaje.choferId ?? null, viaje };
  }
  if (actor.id === viaje.choferId) {
    return { rol: 'chofer', aQuienVe: 'pasajero', contraparteId: viaje.pasajeroId, viaje };
  }
  throw new ErrorRecursoAjeno(`viaje:${viaje.id}`, actor.id);
}

// Cambia la disponibilidad del chofer. El chofer tiene que existir y estar
// HABILITADO por el operador; si no, no puede declararse disponible. Un chofer
// inhabilitado o inexistente devuelve NO_ENCONTRADO para no revelar existencia.
export async function cambiarDisponibilidadChofer({ repositorioChoferes, choferId, disponible }) {
  const chofer = await repositorioChoferes.buscarPorId(choferId);
  if (!chofer || !chofer.habilitado) {
    throw new ErrorNoEncontrado(`chofer:${choferId}`);
  }
  await repositorioChoferes.cambiarDisponibilidad(choferId, Boolean(disponible));
  return { choferId, disponible: Boolean(disponible) };
}

// Registra la ubicacion de un chofer disponible: actualiza la ultima posicion
// (UPSERT), ENCOLA el historial (tarea pesada) y, si el chofer tiene un viaje
// activo, publica la posicion al canal SSE del viaje y asocia el registro al
// viaje. El request devuelve apenas encolo; la escritura pesada es asincrona.
export async function registrarUbicacionChofer({
  repositorioChoferes,
  repositorioUbicaciones,
  colaHistorial,
  repositorioViajes,
  busEventos,
  choferId,
  lat,
  lng,
  timestamp,
}) {
  const punto = validarPunto({ lat, lng });
  if (choferId === undefined || choferId === null || choferId === '') {
    throw new ErrorDatosInvalidos('El choferId es obligatorio.');
  }

  const chofer = await repositorioChoferes.buscarPorId(choferId);
  // Regla: solo un chofer DISPONIBLE puede reportar ubicacion. Si el chofer no
  // existe (null) tambien cae aca: no se revela la diferencia. CHOFER_NO_DISPONIBLE.
  if (!chofer || !chofer.disponible || !chofer.habilitado) {
    throw new ErrorChoferNoDisponible(choferId);
  }

  // 1) Ultima posicion conocida (UPSERT atomico en el adaptador real).
  await repositorioUbicaciones.actualizarActual({ choferId, lat: punto.lat, lng: punto.lng, timestamp });

  // 2) Asociacion al viaje activo, si existe. Una consulta indexada por request;
  //    ver ADR de tarea pesada: el cuello no es esta consulta sino el insert.
  const viajeActivo = repositorioViajes ? await repositorioViajes.buscarActivoPorChofer(choferId) : null;

  // 3) Historial ENCOLADO: dentro del request solo se encola (O(1)).
  colaHistorial.encolar({
    choferId,
    lat: punto.lat,
    lng: punto.lng,
    timestamp,
    viajeId: viajeActivo ? viajeActivo.id : null,
  });

  // 4) Si hay viaje activo, se propaga al SSE (canal por viaje).
  if (viajeActivo && busEventos) {
    busEventos.publicar(`seguimiento:viaje:${viajeActivo.id}`, {
      tipo: 'posicion',
      datos: { choferId, lat: punto.lat, lng: punto.lng, timestamp },
    });
  }

  return { choferId, viajeId: viajeActivo ? viajeActivo.id : null };
}

// Snapshot para GET /viajes/:id/estado y para el primer frame del SSE.
// Segun el rol, se expone la posicion de la contraparte (nunca la propia:
// el SSE no tiene por que reenviarle al pasajero SU posicion, y menos al ajero).
export async function construirSeguimiento({ viaje, actor, repositorioUbicaciones }) {
  const autorizado = autorizarSeguimiento({ viaje, actor });
  let posicionContraparte = null;

  if (autorizado.aQuienVe === 'chofer') {
    const pos = await repositorioUbicaciones.obtenerActual(autorizado.contraparteId);
    posicionContraparte = pos ? { lat: pos.lat, lng: pos.lng, timestamp: pos.timestamp } : null;
  } else {
    // El pasajero no reporta ubicacion por esta API; su posicion es la del
    // origen del viaje, si existe. Documentado como limite del alcance.
    posicionContraparte = viaje.origen ? { lat: viaje.origen.lat, lng: viaje.origen.lng, timestamp: null } : null;
  }

  return {
    viajeId: viaje.id,
    estado: viaje.estado,
    rol: autorizado.rol,
    posicionContraparte,
  };
}

// Construye la regla de acceso a GET /recorrido: mismo criterio que el SSE.
export function autorizarRecorrido({ viaje, actor }) {
  autorizarSeguimiento({ viaje, actor });
  // Devuelve el id para que la ruta filtre solo posiciones de choferes del
  // viaje (por si el chofer cambio entre viajes).
  return { viaje, actor };
}

export { ROLES_SEGUIMIENTO };