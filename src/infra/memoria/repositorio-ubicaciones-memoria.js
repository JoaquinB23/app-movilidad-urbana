// Adaptador en memoria de RepositorioUbicaciones. Para tests y para correr el
// dominio sin base de datos (requisito de arquitectura hexagonal).
//
// Decisiones:
// 1) `listarCandidatosDisponibles` recibe por inyeccion el predicado de
//    disponibilidad `estaDisponible`, para no acoplar este repositorio al de
//    choferes. En produccion la composicion lo conecta al repositorio real; en
//    tests se usa () => true por defecto.
// 2) El historial se guarda tambien por viaje para responder GET /recorrido sin
//    recorrer todo el arreglo.

import { validarPunto } from '../../dominio/ubicaciones/geo.js';
import { ErrorDatosInvalidos } from '../../dominio/ubicaciones/errores.js';

export function crearRepositorioUbicacionesMemoria({ estaDisponible = () => true } = {}) {
  // choferId -> {choferId, lat, lng, timestamp}
  const actuales = new Map();
  // Lista global de registros historicos (append-only).
  const historial = [];
  // Claves (choferId, timestamp) ya vistas: replica la idempotencia por clave
  // natural que en PostgreSQL garantiza el UNIQUE con ON CONFLICT DO NOTHING.
  const clavesHistorial = new Set();
  // viajeId -> registros (solo los que traen viajeId).
  const historialPorViaje = new Map();

  function normalizar(registro) {
    if (registro === null || typeof registro !== 'object') {
      throw new ErrorDatosInvalidos('El registro de ubicacion debe ser un objeto.');
    }
    const choferId = registro.choferId;
    if (typeof choferId !== 'string' || choferId.length === 0) {
      throw new ErrorDatosInvalidos('El registro debe incluir choferId no vacio.');
    }
    const punto = validarPunto(registro);
    if (registro.timestamp === undefined || registro.timestamp === null) {
      throw new ErrorDatosInvalidos('El registro debe incluir timestamp.');
    }
    return {
      choferId,
      lat: punto.lat,
      lng: punto.lng,
      timestamp: registro.timestamp,
      viajeId: registro.viajeId ?? null,
    };
  }

  // Se usa una funcion interna (no `this`) para que los metodos sigan
  // funcionando aunque el adaptador se desestructure al inyectarlo.
  function agregarHistorialInterno(registro) {
    const normalizado = normalizar(registro);
    const clave = `${normalizado.choferId}|${String(normalizado.timestamp)}`;
    if (clavesHistorial.has(clave)) {
      return false; // duplicado por clave natural: se ignora (igual que la DB)
    }
    clavesHistorial.add(clave);
    historial.push(normalizado);
    if (normalizado.viajeId !== null) {
      const lista = historialPorViaje.get(normalizado.viajeId) ?? [];
      lista.push(normalizado);
      historialPorViaje.set(normalizado.viajeId, lista);
    }
  }

  return {
    async actualizarActual(registro) {
      const normalizado = normalizar(registro);
      // UPSERT: la ultima posicion conocida reemplaza a la anterior.
      actuales.set(normalizado.choferId, {
        choferId: normalizado.choferId,
        lat: normalizado.lat,
        lng: normalizado.lng,
        timestamp: normalizado.timestamp,
      });
    },

    async obtenerActual(choferId) {
      const fila = actuales.get(choferId);
      if (!fila) return null;
      // Copia defensiva: quien lee no puede mutar el estado interno.
      return { ...fila };
    },

    async agregarHistorial(registro) {
      agregarHistorialInterno(registro);
    },

    async agregarHistorialEnLote(registros) {
      if (!Array.isArray(registros)) {
        throw new ErrorDatosInvalidos('`registros` debe ser un arreglo.');
      }
      for (const registro of registros) {
        agregarHistorialInterno(registro);
      }
    },

    async historialDeViaje(viajeId) {
      return (historialPorViaje.get(viajeId) ?? []).map((r) => ({ ...r }));
    },

    async listarCandidatosDisponibles() {
      const resultado = [];
      for (const fila of actuales.values()) {
        if (estaDisponible(fila.choferId)) {
          resultado.push({ choferId: fila.choferId, lat: fila.lat, lng: fila.lng });
        }
      }
      return resultado;
    },

    // Auxiliar de test: cantidad de filas historicas en memoria.
    _tamanoHistorial() {
      return historial.length;
    },
  };
}
