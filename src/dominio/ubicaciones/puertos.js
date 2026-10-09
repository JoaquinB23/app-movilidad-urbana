// Puertos del modulo de ubicaciones.
//
// Un puerto es una interfaz definida por el dominio en terminos del dominio.
// No menciona SQL, HTTP ni ninguna libreria: solo dice QUE necesita el dominio,
// no COMO se resuelve. Los adaptadores concretos (PostGIS, memoria, ingenuo)
// viven en src/infra y se inyectan desde src/composicion.js.
//
// Decision de diseno: los puertos se documentan con JSDoc (typedefs) y se
// acompanan de funciones `verificar*` que validan en runtime que un adaptador
// cumple la forma esperada. Asi un adaptador mal cableado falla al arrancar y no
// en medio de un request. Alternativa descartada: TypeScript para interfaces;
// se prefirio JS + JSDoc por la decision del equipo de usar JavaScript.

/**
 * @typedef {Object} Candidato
 * @property {string} choferId
 * @property {number} lat
 * @property {number} lng
 * @property {number} distanciaMetros  Distancia redondeada al origen.
 */

/**
 * Puerto ServicioGeo.
 * @typedef {Object} ServicioGeo
 * @property {(consulta: {lat:number, lng:number, radio:number, limite:number}) => Promise<Candidato[]>} buscarCandidatos
 */

/**
 * Puerto RepositorioUbicaciones. Persiste la ultima posicion conocida y el
 * historial crudo de posiciones.
 * @typedef {Object} RepositorioUbicaciones
 * @property {(registro: {choferId:string, lat:number, lng:number, timestamp:number|string}) => Promise<void>} actualizarActual
 * @property {(choferId:string) => Promise<{choferId:string, lat:number, lng:number, timestamp:number|string}|null>} obtenerActual
 * @property {(registro: {viajeId?:string|null, choferId:string, lat:number, lng:number, timestamp:number|string}) => Promise<void>} agregarHistorial
 * @property {(registros: Array<{viajeId?:string|null, choferId:string, lat:number, lng:number, timestamp:number|string}>) => Promise<void>} agregarHistorialEnLote
 * @property {(viajeId:string) => Promise<Array<{choferId:string, lat:number, lng:number, timestamp:number|string}>>} historialDeViaje
 * @property {() => Promise<Array<{choferId:string, lat:number, lng:number, timestamp:number|string}>>} listarCandidatosDisponibles
 */

/**
 * Puerto RepositorioChoferes. Gestiona la disponibilidad del chofer (el "me"
 * de las rutas). Se define aca porque este modulo lo necesita; el adaptador
 * real puede reutilizarse desde el modulo de choferes en la composicion.
 * @typedef {Object} RepositorioChoferes
 * @property {(choferId:string) => Promise<{id:string, habilitado:boolean, disponible:boolean}|null>} buscarPorId
 * @property {(choferId:string, disponible:boolean) => Promise<void>} cambiarDisponibilidad
 */

/**
 * Puerto RepositorioViajes (solo lectura, para autorizar el seguimiento y para
 * asociar las ubicaciones entrantes al viaje activo del chofer).
 * @typedef {Object} RepositorioViajes
 * @property {(viajeId:string) => Promise<{id:string, pasajeroId:string, choferId:string|null, estado:string, origen?:{lat:number,lng:number}}|null>} buscarPorId
 * @property {(choferId:string) => Promise<{id:string, pasajeroId:string, choferId:string|null, estado:string, origen?:{lat:number,lng:number}}|null>} buscarActivoPorChofer
 */

/**
 * Puerto BusEventos. Publica/suscribe eventos por canal. Conserva un log
 * acotado por canal con ids monotonos para soportar Last-Event-ID.
 * @typedef {Object} BusEventos
 * @property {(canal:string, evento: {tipo:string, datos:object}) => void} publicar
 * @property {(canal:string, manejador: (evento: {id:string, tipo:string, datos:object}) => void) => () => void} suscribir
 * @property {(canal:string, ultimoId:string|null) => Array<{id:string, tipo:string, datos:object}>} eventosDesde
 */

/**
 * Puerto ColaHistorial. Desacopla la escritura del historial de ubicaciones del
 * request: POST /ubicacion solo ENCOLA (operacion O(1)) y un worker hace flush
 * por lotes. Es la solucion elegida a la tarea pesada (ver ADR).
 * @typedef {Object} ColaHistorial
 * @property {(registro: object) => void} encolar
 * @property {() => Promise<number>} drenar        Fuerza el flush (usado en tests y SIGTERM).
 * @property {() => number} tamano
 */

/**
 * Puerto RegistroMetricas. Acumula latencias para exponer percentiles.
 * @typedef {Object} RegistroMetricas
 * @property {(duracionMs:number) => void} observar
 * @property {() => {p50:number, p95:number, p99:number, total:number, max:number}} percentiles
 */

function exigirMetodos(adaptador, nombrePuerto, metodos) {
  if (adaptador === null || typeof adaptador !== 'object') {
    throw new Error(`El adaptador de '${nombrePuerto}' debe ser un objeto.`);
  }
  for (const metodo of metodos) {
    if (typeof adaptador[metodo] !== 'function') {
      throw new Error(`El adaptador de '${nombrePuerto}' no implementa '${metodo}'.`);
    }
  }
}

export function verificarServicioGeo(adaptador) {
  exigirMetodos(adaptador, 'ServicioGeo', ['buscarCandidatos']);
  return adaptador;
}

export function verificarRepositorioUbicaciones(adaptador) {
  exigirMetodos(adaptador, 'RepositorioUbicaciones', [
    'actualizarActual',
    'obtenerActual',
    'agregarHistorial',
    'historialDeViaje',
    'listarCandidatosDisponibles',
  ]);
  return adaptador;
}

export function verificarRepositorioChoferes(adaptador) {
  exigirMetodos(adaptador, 'RepositorioChoferes', ['buscarPorId', 'cambiarDisponibilidad']);
  return adaptador;
}

export function verificarRepositorioViajes(adaptador) {
  exigirMetodos(adaptador, 'RepositorioViajes', ['buscarPorId', 'buscarActivoPorChofer']);
  return adaptador;
}

export function verificarBusEventos(adaptador) {
  exigirMetodos(adaptador, 'BusEventos', ['publicar', 'suscribir', 'eventosDesde']);
  return adaptador;
}

export function verificarColaHistorial(adaptador) {
  exigirMetodos(adaptador, 'ColaHistorial', ['encolar', 'drenar', 'tamano']);
  return adaptador;
}

export function verificarRegistroMetricas(adaptador) {
  exigirMetodos(adaptador, 'RegistroMetricas', ['observar', 'percentiles']);
  return adaptador;
}

export const NOMBRES_PUERTOS = Object.freeze({
  SERVICIO_GEO: 'ServicioGeo',
  REPOSITORIO_UBICACIONES: 'RepositorioUbicaciones',
  REPOSITORIO_CHOFERES: 'RepositorioChoferes',
  REPOSITORIO_VIAJES: 'RepositorioViajes',
  BUS_EVENTOS: 'BusEventos',
  COLA_HISTORIAL: 'ColaHistorial',
  REGISTRO_METRICAS: 'RegistroMetricas',
});
