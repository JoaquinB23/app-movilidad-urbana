/**
 * Contratos de los puertos del dominio. Los adaptadores implementan estas
 * operaciones; este módulo solo documenta sus formas y no contiene lógica.
 *
 * @typedef {Object} RepositorioViajes
 * @property {(viaje: object) => Promise<object>|object} guardar Guarda un viaje.
 * @property {(id: string) => Promise<object|null>|object|null} buscarPorId Busca un viaje por identificador.
 * @property {(id: string) => Promise<object|null>|object|null} buscarPorIdParaActualizar Busca un viaje bloqueado para escritura; el adaptador persistente usa SELECT ... FOR UPDATE dentro de una transacción.
 * @property {(evento: object) => Promise<object>|object} registrarEvento Agrega un evento al historial append-only.
 *
 * @typedef {Object} RepositorioOfertas
 * @property {(oferta: object) => Promise<object>|object} crear Persiste una oferta.
 * @property {(id: string) => Promise<object|null>|object|null} buscarPorId Busca una oferta por identificador.
 * @property {(id: string) => Promise<object|null>|object|null} buscarPorIdParaActualizar Busca una oferta bloqueada para escritura.
 * @property {(oferta: object) => Promise<object>|object} actualizar Actualiza una oferta existente.
 *
 * @typedef {Object} RepositorioChoferes
 * @property {(id: string) => Promise<object|null>|object|null} buscarPorId Busca un chofer por identificador.
 * @property {(id: string) => Promise<object|null>|object|null} buscarPorIdParaActualizar Busca un chofer bloqueado para escritura.
 *
 * @typedef {Object} RepositorioAsignaciones
 * @property {(asignacion: object) => Promise<object>|object} abrir Registra una asignación abierta.
 * @property {(id: string, motivo: string|null) => Promise<object|null>|object|null} cerrar Cierra una asignación abierta.
 * @property {(viajeId: string) => Promise<object|null>|object|null} buscarAbiertaPorViaje Busca la asignación abierta de un viaje.
 * @property {(choferId: string) => Promise<object|null>|object|null} buscarAbiertaPorChofer Busca la asignación abierta de un chofer.
 *
 * @typedef {Object} Transaccion
 * @property {<T>(fn: () => Promise<T>|T) => Promise<T>|T} ejecutar Ejecuta una función dentro de una transacción.
 *
 * @typedef {Object} Reloj
 * @property {() => Date} ahora Devuelve la fecha y hora actual.
 *
 * @typedef {Object} GeneradorId
 * @property {() => string} nuevo Genera un identificador.
 *
 * @typedef {Object} EstimadorRuta
 * @property {(origen: {lat: number, lng: number}, destino: {lat: number, lng: number}) => Promise<{distanciaMetros: number, duracionSegundos: number}>|{distanciaMetros: number, duracionSegundos: number}} estimar Estima distancia y duración.
 *
 * @typedef {Object} ServicioGeo
 * @property {(consulta: {lat: number, lng: number, radioMetros: number, limite: number}) => Promise<Array<{choferId: string, distanciaMetros: number}>>|Array<{choferId: string, distanciaMetros: number}>} buscarCandidatos Devuelve choferes dentro del radio, ordenados por cercanía.
 *
 * @typedef {Object} ParametrosViajes
 * @property {() => Promise<{tarifa: object, tiempoOfertaSegundos: number, radioBusquedaMetros: number, maxCandidatos: number}>|{tarifa: object, tiempoOfertaSegundos: number, radioBusquedaMetros: number, maxCandidatos: number}} obtener Devuelve la tarifa y los parámetros operativos de viajes.
 */
export {};
