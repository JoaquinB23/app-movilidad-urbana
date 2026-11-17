// Servicios de identidad (registro, login, perfil, habilitación de choferes).
// Dominio puro: recibe puertos (repositorioUsuarios, hasher, tokens, reloj) y
// no conoce express, argon2 ni jsonwebtoken.
//
// Puertos esperados:
//   repositorioUsuarios: {
//     buscarPorEmail(email), buscarPorId(id), crearPasajero(usuario),
//     crearChofer(usuario, vehiculo), listarChoferes(filtros),
//     cambiarHabilitacion({ choferId, habilitado, adminId, en })
//   }
//   hasher: { hashear(plano), verificar(hash, plano) }
//   tokens: { firmar(payload) }
//   reloj:  { ahora() }

import {
  ErrorDatosInvalidos,
  ErrorCredencialesInvalidas,
  ErrorNoEncontrado,
  ErrorCuentaInactiva,
} from './errores.js';

export const ROLES = Object.freeze(['pasajero', 'chofer', 'operador', 'administrador']);

function normalizarEmail(email) {
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ErrorDatosInvalidos('El email no tiene un formato válido.');
  }
  return email.trim().toLowerCase();
}

function validarPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw new ErrorDatosInvalidos('La contraseña debe tener entre 8 y 128 caracteres.');
  }
}

function validarNombre(nombre) {
  if (typeof nombre !== 'string' || nombre.trim().length === 0 || nombre.length > 255) {
    throw new ErrorDatosInvalidos('El nombre es obligatorio.');
  }
  return nombre.trim();
}

// Perfil público: NUNCA incluye password_hash.
function aPerfil(usuario) {
  const perfil = {
    id: usuario.id,
    email: usuario.email,
    nombre: usuario.nombre,
    rol: usuario.rol,
    activo: usuario.activo,
  };
  if (usuario.rol === 'chofer' && usuario.chofer) {
    perfil.chofer = {
      patente: usuario.chofer.patente,
      vehiculo: {
        marca: usuario.chofer.vehiculoMarca,
        modelo: usuario.chofer.vehiculoModelo,
        color: usuario.chofer.vehiculoColor,
      },
      habilitado: usuario.chofer.habilitado,
      disponible: usuario.chofer.disponible,
    };
  }
  return perfil;
}

export function crearServiciosIdentidad({ repositorioUsuarios, hasher, tokens, reloj }) {
  for (const [nombre, puerto] of [
    ['repositorioUsuarios', repositorioUsuarios],
    ['hasher', hasher],
    ['tokens', tokens],
    ['reloj', reloj],
  ]) {
    if (!puerto) throw new ErrorDatosInvalidos(`El puerto ${nombre} es obligatorio.`);
  }

  async function registrarPasajero({ email, password, nombre }) {
    const emailNormalizado = normalizarEmail(email);
    validarPassword(password);
    const nombreLimpio = validarNombre(nombre);
    const passwordHash = await hasher.hashear(password);
    // La unicidad del email la garantiza el índice único de la DB; el repo
    // traduce la violación a ErrorEmailEnUso (no hay carrera check-then-insert).
    const usuario = await repositorioUsuarios.crearPasajero({
      email: emailNormalizado,
      passwordHash,
      nombre: nombreLimpio,
    });
    return aPerfil(usuario);
  }

  async function registrarChofer({ email, password, nombre, vehiculo }) {
    const emailNormalizado = normalizarEmail(email);
    validarPassword(password);
    const nombreLimpio = validarNombre(nombre);
    if (
      !vehiculo ||
      typeof vehiculo.patente !== 'string' || vehiculo.patente.trim().length === 0 ||
      vehiculo.patente.trim().length > 10 ||
      typeof vehiculo.marca !== 'string' || vehiculo.marca.trim().length === 0 ||
      typeof vehiculo.modelo !== 'string' || vehiculo.modelo.trim().length === 0 ||
      typeof vehiculo.color !== 'string' || vehiculo.color.trim().length === 0
    ) {
      throw new ErrorDatosInvalidos('El vehículo requiere patente (máx. 10), marca, modelo y color.');
    }
    const passwordHash = await hasher.hashear(password);
    // El chofer SIEMPRE nace no habilitado: lo habilita un administrador por
    // PATCH /admin/choferes/:id/habilitacion.
    const usuario = await repositorioUsuarios.crearChofer(
      { email: emailNormalizado, passwordHash, nombre: nombreLimpio },
      {
        patente: vehiculo.patente.trim().toUpperCase(),
        marca: vehiculo.marca.trim(),
        modelo: vehiculo.modelo.trim(),
        color: vehiculo.color.trim(),
      }
    );
    return aPerfil(usuario);
  }

  async function iniciarSesion({ email, password }) {
    let emailNormalizado;
    try {
      emailNormalizado = normalizarEmail(email);
      validarPassword(password);
    } catch {
      // Formato inválido en login => mismas credenciales inválidas; no se
      // distingue para no filtrar qué emails existen.
      throw new ErrorCredencialesInvalidas();
    }
    const usuario = await repositorioUsuarios.buscarPorEmail(emailNormalizado);
    // Se verifica SIEMPRE un hash (el real o uno señuelo) para que el tiempo de
    // respuesta no revele si el email existe (timing attack).
    const hash = usuario?.passwordHash ?? hasher.hashSenuelo;
    const coincide = await hasher.verificar(hash, password);
    if (!usuario || !coincide) throw new ErrorCredencialesInvalidas();
    if (!usuario.activo) throw new ErrorCuentaInactiva();

    const token = await tokens.firmar({ sub: usuario.id, rol: usuario.rol });
    return { token, usuario: aPerfil(usuario) };
  }

  async function obtenerPerfil({ usuarioId }) {
    const usuario = await repositorioUsuarios.buscarPorId(usuarioId);
    if (!usuario) throw new ErrorNoEncontrado('El usuario no fue encontrado.');
    return aPerfil(usuario);
  }

  async function cambiarHabilitacionChofer({ choferId, habilitado, adminId }) {
    if (typeof habilitado !== 'boolean') {
      throw new ErrorDatosInvalidos('habilitado debe ser booleano.');
    }
    const chofer = await repositorioUsuarios.cambiarHabilitacion({
      choferId,
      habilitado,
      adminId,
      en: reloj.ahora(),
    });
    if (!chofer) throw new ErrorNoEncontrado('El chofer no fue encontrado.');
    return chofer;
  }

  async function listarChoferes({ habilitado } = {}) {
    if (habilitado !== undefined && typeof habilitado !== 'boolean') {
      throw new ErrorDatosInvalidos('El filtro habilitado debe ser booleano.');
    }
    const choferes = await repositorioUsuarios.listarChoferes({ habilitado });
    return choferes.map(aPerfil);
  }

  return {
    registrarPasajero,
    registrarChofer,
    iniciarSesion,
    obtenerPerfil,
    cambiarHabilitacionChofer,
    listarChoferes,
  };
}
