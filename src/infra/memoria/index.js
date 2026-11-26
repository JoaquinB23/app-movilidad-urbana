import { randomUUID } from 'node:crypto';

function copiar(valor) {
  if (valor === null || valor === undefined || typeof valor !== 'object') return valor;
  if (valor instanceof Date) return new Date(valor);
  if (Array.isArray(valor)) return valor.map(copiar);
  return Object.fromEntries(Object.entries(valor).map(([clave, elemento]) => [clave, copiar(elemento)]));
}

const ESTADOS_ACTIVOS = new Set(['solicitado', 'asignado', 'chofer_en_camino', 'en_curso']);

function resumenViaje(viaje) {
  const { id, estado, origen, destino, tarifaEstimadaCentavos, tarifaFinalCentavos = null,
    motivoCierre = null, creadoEn, actualizadoEn } = viaje;
  return copiar({ id, estado, origen, destino, tarifaEstimadaCentavos, tarifaFinalCentavos,
    motivoCierre, creadoEn, actualizadoEn });
}

const porFechaDesc = (a, b) => b.creadoEn - a.creadoEn || a.id.localeCompare(b.id);

// `asignaciones` (opcional): el repo de asignaciones en memoria, para resolver
// el historial del chofer igual que el adaptador PG (por sus asignaciones).
export function crearRepositorioViajesEnMemoria({ asignaciones = null, ofertas = null } = {}) {
  const estado = { viajes: new Map(), eventos: [] };
  return {
    estado,
    // Mismo criterio que SQL_VIAJES_BUSCANDO (necesita el repo de ofertas).
    async detectarBuscando(limite) {
      const conPendiente = new Set([...(ofertas?.estado.ofertas.values() ?? [])]
        .filter((o) => o.estado === 'pendiente').map((o) => o.viajeId));
      return [...estado.viajes.values()]
        .filter((v) => v.estado === 'solicitado' && !conPendiente.has(v.id))
        .sort((a, b) => a.creadoEn - b.creadoEn || a.id.localeCompare(b.id))
        .slice(0, limite).map((v) => v.id);
    },
    async listarPorPasajero(pasajeroId, limite) {
      return [...estado.viajes.values()].filter((v) => v.pasajeroId === pasajeroId)
        .sort(porFechaDesc).slice(0, limite).map(resumenViaje);
    },
    async listarPorChofer(choferId, limite) {
      const ids = new Set([...(asignaciones?.estado.asignaciones.values() ?? [])]
        .filter((a) => a.choferId === choferId).map((a) => a.viajeId));
      return [...estado.viajes.values()].filter((v) => ids.has(v.id))
        .sort(porFechaDesc).slice(0, limite).map(resumenViaje);
    },
    async listarActivos({ estado: filtro = null, limite }) {
      return [...estado.viajes.values()]
        .filter((v) => ESTADOS_ACTIVOS.has(v.estado) && (filtro === null || v.estado === filtro))
        .sort((a, b) => a.creadoEn - b.creadoEn || a.id.localeCompare(b.id))
        .slice(0, limite).map(resumenViaje);
    },
    async guardar(viaje) {
      estado.viajes.set(viaje.id, copiar(viaje));
      return copiar(viaje);
    },
    async buscarPorId(id) {
      return copiar(estado.viajes.get(id) ?? null);
    },
    async buscarPorIdParaActualizar(id) {
      return copiar(estado.viajes.get(id) ?? null);
    },
    async registrarEvento(evento) {
      estado.eventos.push(copiar(evento));
      return copiar(evento);
    },
  };
}

export function crearRepositorioOfertasEnMemoria() {
  const estado = { ofertas: new Map() };
  return {
    estado,
    async detectarVencidas(ahora, limite) {
      return [...estado.ofertas.values()].filter(o => o.estado === 'pendiente' && o.expiraEn <= ahora)
        .sort((a, b) => a.expiraEn - b.expiraEn || a.id.localeCompare(b.id))
        .slice(0, limite).map(o => o.id);
    },
    async listarPorViaje(viajeId) {
      return [...estado.ofertas.values()].filter(o => o.viajeId === viajeId)
        .sort((a, b) => a.orden - b.orden || a.id.localeCompare(b.id)).map(copiar);
    },
    async listarVigentes(choferId, ahora) {
      return [...estado.ofertas.values()]
        .filter(o => o.choferId === choferId && o.estado === 'pendiente' && o.expiraEn > ahora)
        .sort((a, b) => a.expiraEn - b.expiraEn || a.id.localeCompare(b.id))
        .map(copiar);
    },
    async crear(oferta) {
      estado.ofertas.set(oferta.id, copiar(oferta));
      return copiar(oferta);
    },
    async buscarPorId(id) {
      return copiar(estado.ofertas.get(id) ?? null);
    },
    async buscarPorIdParaActualizar(id) {
      return copiar(estado.ofertas.get(id) ?? null);
    },
    async actualizar(oferta) {
      if (!estado.ofertas.has(oferta.id)) {
        throw new Error(`No existe la oferta '${oferta.id}'.`);
      }
      estado.ofertas.set(oferta.id, copiar(oferta));
      return copiar(oferta);
    },
    async cancelarPendientesPorViaje(viajeId, exceptoOfertaId, respondidaEn) {
      for (const [id, oferta] of estado.ofertas) {
        if (
          oferta.viajeId === viajeId &&
          id !== exceptoOfertaId &&
          oferta.estado === 'pendiente'
        ) {
          estado.ofertas.set(id, {
            ...oferta,
            estado: 'cancelada',
            respondidaEn: copiar(respondidaEn),
          });
        }
      }
    },
  };
}

export function crearRepositorioChoferesEnMemoria(choferes = []) {
  const estado = { choferes: new Map(choferes.map((chofer) => [chofer.id, copiar(chofer)])) };
  return {
    estado,
    async buscarPorId(id) {
      return copiar(estado.choferes.get(id) ?? null);
    },
    async buscarPorIdParaActualizar(id) {
      return copiar(estado.choferes.get(id) ?? null);
    },
  };
}

export function crearRepositorioAsignacionesEnMemoria({ reloj = crearRelojEnMemoria() } = {}) {
  const estado = { asignaciones: new Map() };
  async function buscarAbiertaPorViaje(viajeId) {
    const asignacion = [...estado.asignaciones.values()].find(
      (item) => item.viajeId === viajeId && item.hasta === null
    );
    return copiar(asignacion ?? null);
  }
  async function buscarAbiertaPorChofer(choferId) {
    const asignacion = [...estado.asignaciones.values()].find(
      (item) => item.choferId === choferId && item.hasta === null
    );
    return copiar(asignacion ?? null);
  }
  return {
    estado,
    async abrir(asignacion) {
      if (await buscarAbiertaPorViaje(asignacion.viajeId)) {
        throw new Error(`El viaje '${asignacion.viajeId}' ya tiene una asignación abierta.`);
      }
      if (await buscarAbiertaPorChofer(asignacion.choferId)) {
        throw new Error(`El chofer '${asignacion.choferId}' ya tiene una asignación abierta.`);
      }
      const guardada = {
        ...copiar(asignacion),
        desde: copiar(asignacion.desde ?? reloj.ahora()),
        hasta: null,
      };
      estado.asignaciones.set(guardada.id, guardada);
      return copiar(guardada);
    },
    async cerrar(id, motivo) {
      const asignacion = estado.asignaciones.get(id);
      if (!asignacion || asignacion.hasta !== null) return null;
      const cerrada = { ...asignacion, hasta: reloj.ahora(), motivoFin: motivo ?? null };
      estado.asignaciones.set(id, cerrada);
      return copiar(cerrada);
    },
    async listarPorViaje(viajeId) {
      return [...estado.asignaciones.values()].filter((a) => a.viajeId === viajeId)
        .sort((a, b) => a.desde - b.desde).map(copiar);
    },
    buscarAbiertaPorViaje,
    buscarAbiertaPorChofer,
  };
}

export function crearRepositorioCobrosEnMemoria() {
  const estado = { cobros: new Map() };
  return {
    estado,
    async buscarPorViaje(viajeId) {
      return copiar([...estado.cobros.values()].find((c) => c.viajeId === viajeId) ?? null);
    },
    async crear(cobro) {
      // Mismo invariante que el indice unico cobros_un_cobro_por_viaje.
      if ([...estado.cobros.values()].some((c) => c.viajeId === cobro.viajeId)) {
        throw Object.assign(new Error('El viaje ya fue cobrado.'), { codigo: 'YA_COBRADO' });
      }
      estado.cobros.set(cobro.id, copiar(cobro));
      return copiar(cobro);
    },
  };
}

// Puerto MedidorRecorrido en memoria: distancias recorridas cargadas a mano.
export function crearMedidorRecorridoEnMemoria(distancias = {}) {
  const tabla = new Map(Object.entries(distancias));
  return {
    cargar(viajeId, metros) { tabla.set(viajeId, metros); },
    async distanciaRecorridaMetros(viajeId) {
      return tabla.has(viajeId) ? tabla.get(viajeId) : null;
    },
  };
}

export function crearTransaccionEnMemoria(repositorios = {}) {
  const claves = new Map();
  repositorios = { idempotencia: {
    estado: { claves },
    async reservar(usuario, clave, hash) {
      const id = JSON.stringify([usuario, clave]);
      if (claves.has(id)) return copiar(claves.get(id));
      claves.set(id, { hash });
      return null;
    },
    async completar(usuario, clave, respuesta) {
      claves.get(JSON.stringify([usuario, clave])).respuesta = copiar(respuesta);
    },
  }, ...repositorios };
  let turno = Promise.resolve();
  return {
    async ejecutar(fn) {
      const anterior = turno;
      let liberar;
      turno = new Promise(resolve => { liberar = resolve; });
      await anterior;
      const snapshots = Object.values(repositorios)
        .map((repositorio) => repositorio.estado)
        .filter(Boolean)
        .map((estado) => ({
          estado,
          entradas: Object.fromEntries(
            Object.entries(estado).map(([clave, valor]) => [
              clave,
              valor instanceof Map
                ? new Map([...valor.entries()].map(([id, elemento]) => [id, copiar(elemento)]))
                : Array.isArray(valor)
                  ? valor.map(copiar)
                  : copiar(valor),
            ])
          ),
        }));
      try {
        return await fn(repositorios);
      } catch (error) {
        for (const { estado, entradas } of snapshots) {
          for (const clave of Object.keys(estado)) {
            const original = estado[clave];
            const snapshot = entradas[clave];
            if (original instanceof Map) {
              original.clear();
              for (const [id, elemento] of snapshot) original.set(id, elemento);
            } else if (Array.isArray(original)) {
              original.splice(0, original.length, ...snapshot);
            } else {
              estado[clave] = snapshot;
            }
          }
        }
        throw error;
      } finally {
        liberar();
      }
    },
  };
}

export function crearRelojEnMemoria(fecha = new Date()) {
  let actual = new Date(fecha);
  return {
    ahora: () => new Date(actual),
    establecer(nuevaFecha) {
      actual = new Date(nuevaFecha);
    },
  };
}

export function crearGeneradorIdEnMemoria() {
  return { nuevo: () => randomUUID() };
}

const RADIO_TIERRA_METROS = 6_371_000;

function distanciaHaversine(origen, destino) {
  const aLat = (origen.lat * Math.PI) / 180;
  const bLat = (destino.lat * Math.PI) / 180;
  const deltaLat = bLat - aLat;
  const deltaLng = ((destino.lng - origen.lng) * Math.PI) / 180;
  const valorHaversine =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(aLat) * Math.cos(bLat) * Math.sin(deltaLng / 2) ** 2;
  const a = Math.min(1, Math.max(0, valorHaversine));
  return 2 * RADIO_TIERRA_METROS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function crearEstimadorRutaEnMemoria({ velocidadPromedioKmH = 30 } = {}) {
  if (!Number.isFinite(velocidadPromedioKmH) || velocidadPromedioKmH <= 0) {
    throw new TypeError('La velocidad promedio debe ser positiva.');
  }
  return {
    estimar(origen, destino) {
      const distanciaMetros = Math.round(distanciaHaversine(origen, destino));
      const metrosPorSegundo = (velocidadPromedioKmH * 1000) / 3600;
      return {
        distanciaMetros,
        duracionSegundos: Math.round(distanciaMetros / metrosPorSegundo),
      };
    },
  };
}

export function crearServicioGeoEnMemoria() {
  const estado = { ubicaciones: new Map() };
  return {
    estado,
    cargarUbicacion(choferId, ubicacion) {
      estado.ubicaciones.set(choferId, copiar(ubicacion));
    },
    quitarUbicacion(choferId) {
      estado.ubicaciones.delete(choferId);
    },
    buscarCandidatos({ lat, lng, radioMetros, limite }) {
      const origen = { lat, lng };
      return [...estado.ubicaciones.entries()]
        .map(([choferId, ubicacion]) => ({
          choferId,
          distanciaMetros: Math.round(distanciaHaversine(origen, ubicacion)),
        }))
        .filter((candidato) => candidato.distanciaMetros <= radioMetros)
        .sort((a, b) => a.distanciaMetros - b.distanciaMetros)
        .slice(0, limite);
    },
  };
}

export function crearParametrosViajesEnMemoria(parametros) {
  const guardados = copiar(parametros);
  return { obtener: () => copiar(guardados) };
}
