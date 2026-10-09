// Adaptador PostgreSQL de RepositorioUbicaciones.
//
// Decisiones:
// 1) UPSERT con ON CONFLICT para `actualizarActual`: es la operacion mas caliente
//    del modulo (cada ubicacion de cada chofer). Un SELECT+UPDATE tendria una
//    condicion de carrera si dos envios del mismo chofer llegan juntos; el
//    ON CONFLICT resuelve en una sola sentencia atomica.
// 2) El historial por lote usa UN solo INSERT con `unnest` de varios arreglos:
//    menos round-trips y menos parseo de SQL que N INSERT. Es el corazon de la
//    tarea pesada (ver ADR).
// 3) Todas las consultas son parametrizadas ($1, $2...). La geometria se arma
//    con ST_MakePoint en la base a partir de lng/lat, nunca como texto de WKT
//    interpolado.

import { validarPunto } from '../../dominio/ubicaciones/geo.js';
import { ErrorDatosInvalidos } from '../../dominio/ubicaciones/errores.js';

function aFecha(timestamp) {
  const fecha = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(fecha.getTime())) {
    throw new ErrorDatosInvalidos(`timestamp invalido: ${JSON.stringify(timestamp)}.`);
  }
  return fecha;
}

export const SQL_UPSERT_ACTUAL = `
  INSERT INTO ubicaciones_actuales (chofer_id, geom, timestamp)
  VALUES ($1, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4)
  ON CONFLICT (chofer_id) DO UPDATE
    SET geom = EXCLUDED.geom,
        timestamp = EXCLUDED.timestamp
`;

export const SQL_OBTENER_ACTUAL = `
  SELECT chofer_id, ST_Y(geom::geometry) AS lat, ST_X(geom::geometry) AS lng, timestamp
  FROM ubicaciones_actuales
  WHERE chofer_id = $1
`;

export const SQL_INSERT_HISTORIAL = `
  INSERT INTO ubicaciones_historial (viaje_id, chofer_id, geom, timestamp)
  VALUES ($1::uuid, $2::uuid, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5)
  ON CONFLICT (chofer_id, timestamp) DO NOTHING
`;

// Los ids llegan como string desde el dominio (UUID en el schema); se castean
// a uuid en el SELECT para que untext[] parametrizado entre en columnas uuid[].
export const SQL_INSERT_HISTORIAL_LOTE = `
  INSERT INTO ubicaciones_historial (viaje_id, chofer_id, geom, timestamp)
  SELECT viaje_id::uuid, chofer_id::uuid,
         ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography,
         ts
  FROM unnest($1::text[], $2::text[], $3::float8[], $4::float8[], $5::timestamptz[])
       AS lote(viaje_id, chofer_id, lng, lat, ts)
  ON CONFLICT (chofer_id, timestamp) DO NOTHING
`;

export const SQL_HISTORIAL_VIAJE = `
  SELECT chofer_id, ST_Y(geom::geometry) AS lat, ST_X(geom::geometry) AS lng, timestamp
  FROM ubicaciones_historial
  WHERE viaje_id = $1::uuid
  ORDER BY timestamp ASC
`;

export const SQL_CANDIDATOS_DISPONIBLES = `
  SELECT u.chofer_id, ST_Y(u.geom::geometry) AS lat, ST_X(u.geom::geometry) AS lng
  FROM ubicaciones_actuales u
  JOIN choferes c ON c.id = u.chofer_id
  WHERE c.disponible = true AND c.habilitado = true
`;

export function crearRepositorioUbicacionesPg({ consulta }) {
  if (typeof consulta !== 'function') {
    throw new Error("El adaptador PostgreSQL de RepositorioUbicaciones requiere 'consulta'.");
  }

  return {
    async actualizarActual({ choferId, lat, lng, timestamp }) {
      const punto = validarPunto({ lat, lng });
      await consulta(SQL_UPSERT_ACTUAL, [choferId, punto.lng, punto.lat, aFecha(timestamp)]);
    },

    async obtenerActual(choferId) {
      const { rows } = await consulta(SQL_OBTENER_ACTUAL, [choferId]);
      const fila = rows[0];
      if (!fila) return null;
      return {
        choferId: fila.chofer_id,
        lat: Number(fila.lat),
        lng: Number(fila.lng),
        timestamp: fila.timestamp,
      };
    },

    async agregarHistorial({ viajeId = null, choferId, lat, lng, timestamp }) {
      const punto = validarPunto({ lat, lng });
      await consulta(SQL_INSERT_HISTORIAL, [
        viajeId,
        choferId,
        punto.lng,
        punto.lat,
        aFecha(timestamp),
      ]);
    },

    async agregarHistorialEnLote(registros) {
      if (!Array.isArray(registros)) {
        throw new ErrorDatosInvalidos('`registros` debe ser un arreglo.');
      }
      if (registros.length === 0) return;

      const viajeIds = [];
      const choferIds = [];
      const lngs = [];
      const lats = [];
      const fechas = [];
      for (const registro of registros) {
        const punto = validarPunto(registro);
        viajeIds.push(registro.viajeId ?? null);
        choferIds.push(registro.choferId);
        lngs.push(punto.lng);
        lats.push(punto.lat);
        fechas.push(aFecha(registro.timestamp));
      }
      await consulta(SQL_INSERT_HISTORIAL_LOTE, [viajeIds, choferIds, lngs, lats, fechas]);
    },

    async historialDeViaje(viajeId) {
      const { rows } = await consulta(SQL_HISTORIAL_VIAJE, [viajeId]);
      return rows.map((fila) => ({
        choferId: fila.chofer_id,
        lat: Number(fila.lat),
        lng: Number(fila.lng),
        timestamp: fila.timestamp,
      }));
    },

    async listarCandidatosDisponibles() {
      const { rows } = await consulta(SQL_CANDIDATOS_DISPONIBLES, []);
      return rows.map((fila) => ({
        choferId: fila.chofer_id,
        lat: Number(fila.lat),
        lng: Number(fila.lng),
      }));
    },
  };
}
