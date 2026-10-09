import { randomUUID } from 'node:crypto';

function copiar(valor) {
  if (valor === null || valor === undefined || typeof valor !== 'object') return valor;
  if (valor instanceof Date) return new Date(valor);
  if (Array.isArray(valor)) return valor.map(copiar);
  return Object.fromEntries(Object.entries(valor).map(([clave, elemento]) => [clave, copiar(elemento)]));
}

export function crearRepositorioViajesEnMemoria() {
  const estado = { viajes: new Map(), eventos: [] };
  return {
    estado,
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
    buscarAbiertaPorViaje,
    buscarAbiertaPorChofer,
  };
}

export function crearTransaccionEnMemoria() {
  return { ejecutar: (fn) => fn() };
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
