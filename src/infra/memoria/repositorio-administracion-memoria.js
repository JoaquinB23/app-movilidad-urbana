// Adaptador en memoria de la configuración administrable (para tests sin DB).
// Mismos defaults que la migración 300.

import { randomUUID } from 'node:crypto';

export function crearRepositorioAdministracionMemoria() {
  let tarifas = {
    bajadaBanderaCentavos: 150000,
    precioKmCentavos: 80000,
    precioMinutoCentavos: 10000,
    actualizadoEn: new Date(),
  };
  const zonas = new Map();
  const parametros = new Map([
    ['tiempo_limite_oferta_s', 30],
    ['umbral_reasignacion_s', 60],
    ['radio_busqueda_m', 5000],
    ['tarifa_minima_centavos', 200000],
    ['distancia_maxima_m', 50000],
    ['max_candidatos', 5],
  ]);

  return {
    async obtenerTarifas() {
      return { ...tarifas };
    },
    async guardarTarifas({ bajadaBanderaCentavos, precioKmCentavos, precioMinutoCentavos }) {
      tarifas = {
        bajadaBanderaCentavos,
        precioKmCentavos,
        precioMinutoCentavos,
        actualizadoEn: new Date(),
      };
      return { ...tarifas };
    },
    async listarZonas() {
      return [...zonas.values()].map((z) => ({ ...z }));
    },
    async guardarZona({ nombre, multiplicador, activa }) {
      const existente = zonas.get(nombre);
      const zona = {
        id: existente?.id ?? randomUUID(),
        nombre,
        multiplicador,
        activa,
        actualizadoEn: new Date(),
      };
      zonas.set(nombre, zona);
      return { ...zona };
    },
    async obtenerParametros() {
      return Object.fromEntries(parametros);
    },
    async obtenerParametro(clave) {
      return parametros.has(clave) ? parametros.get(clave) : null;
    },
    async guardarParametro({ clave, valor }) {
      if (!parametros.has(clave)) return null;
      parametros.set(clave, valor);
      return { clave, valor };
    },
  };
}
