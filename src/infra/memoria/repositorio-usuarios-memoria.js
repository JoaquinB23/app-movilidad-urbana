// Adaptador en memoria del puerto repositorioUsuarios (para tests sin DB).
// Reproduce el contrato del repo PG, incluida la traducción de unicidad de
// email/patente a errores de dominio.

import { randomUUID } from 'node:crypto';

import { ErrorEmailEnUso, ErrorPatenteEnUso } from '../../dominio/identidad/errores.js';

export function crearRepositorioUsuariosMemoria({ usuarios = [] } = {}) {
  // Map por id; email comparado case-insensitive como el índice de PG.
  const porId = new Map(usuarios.map((u) => [u.id, structuredClone(u)]));

  function buscarPorEmailInterno(email) {
    const buscado = String(email).toLowerCase();
    for (const usuario of porId.values()) {
      if (usuario.email.toLowerCase() === buscado) return usuario;
    }
    return null;
  }

  function patenteEnUso(patente) {
    for (const usuario of porId.values()) {
      if (usuario.chofer?.patente === patente) return true;
    }
    return false;
  }

  return {
    async buscarPorEmail(email) {
      const usuario = buscarPorEmailInterno(email);
      return usuario ? structuredClone(usuario) : null;
    },
    async buscarPorId(id) {
      const usuario = porId.get(id);
      return usuario ? structuredClone(usuario) : null;
    },
    async crearPasajero({ email, passwordHash, nombre }) {
      if (buscarPorEmailInterno(email)) throw new ErrorEmailEnUso();
      const usuario = {
        id: randomUUID(),
        email,
        passwordHash,
        nombre,
        rol: 'pasajero',
        activo: true,
        creadoEn: new Date(),
      };
      porId.set(usuario.id, usuario);
      return structuredClone(usuario);
    },
    async crearChofer({ email, passwordHash, nombre }, vehiculo) {
      if (buscarPorEmailInterno(email)) throw new ErrorEmailEnUso();
      if (patenteEnUso(vehiculo.patente)) throw new ErrorPatenteEnUso();
      const usuario = {
        id: randomUUID(),
        email,
        passwordHash,
        nombre,
        rol: 'chofer',
        activo: true,
        creadoEn: new Date(),
        chofer: {
          patente: vehiculo.patente,
          vehiculoMarca: vehiculo.marca,
          vehiculoModelo: vehiculo.modelo,
          vehiculoColor: vehiculo.color,
          habilitado: false,
          disponible: false,
          habilitadoPor: null,
          habilitadoEn: null,
        },
      };
      porId.set(usuario.id, usuario);
      return structuredClone(usuario);
    },
    async listarChoferes({ habilitado } = {}) {
      const resultado = [];
      for (const usuario of porId.values()) {
        if (usuario.rol !== 'chofer') continue;
        if (typeof habilitado === 'boolean' && usuario.chofer.habilitado !== habilitado) continue;
        resultado.push(structuredClone(usuario));
      }
      return resultado;
    },
    async cambiarHabilitacion({ choferId, habilitado, adminId, en }) {
      const usuario = porId.get(choferId);
      if (!usuario || usuario.rol !== 'chofer') return null;
      usuario.chofer.habilitado = habilitado;
      if (habilitado) {
        usuario.chofer.habilitadoPor = adminId;
        usuario.chofer.habilitadoEn = en;
      } else {
        usuario.chofer.disponible = false;
      }
      return {
        id: usuario.id,
        patente: usuario.chofer.patente,
        habilitado: usuario.chofer.habilitado,
        habilitadoPor: usuario.chofer.habilitadoPor,
        habilitadoEn: usuario.chofer.habilitadoEn,
        disponible: usuario.chofer.disponible,
      };
    },
  };
}
