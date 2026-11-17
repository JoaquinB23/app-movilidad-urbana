// Middlewares de autenticación y autorización por ROL, compartidos por todos
// los módulos HTTP del proyecto (ubicaciones ya recibe `autenticar` inyectado;
// esta es la implementación real).
//
// Contrato que consumen las rutas: `req.actor = { id, rol }`.
//
// `autenticar` exige `Authorization: Bearer <jwt>`; un token ausente, mal
// formado, vencido o con firma inválida responde SIEMPRE el mismo 401 (no se
// distingue el motivo para no dar pistas). `requerirRol(...roles)` responde
// 403 cuando el rol del token no está en la lista: la IDENTIDAD es válida pero
// el permiso no alcanza.

function respuestaError(res, status, codigo, mensaje) {
  return res.status(status).json({
    error: {
      codigo,
      mensaje,
      idCorrelacion: res.locals?.idCorrelacion ?? null,
    },
  });
}

export function crearAutenticar({ tokens }) {
  if (typeof tokens?.verificar !== 'function') {
    throw new TypeError('crearAutenticar requiere el puerto tokens.verificar.');
  }
  return function autenticar(req, res, next) {
    const encabezado = req.headers.authorization;
    const [esquema, token] = typeof encabezado === 'string' ? encabezado.split(' ') : [];
    if (esquema !== 'Bearer' || !token) {
      return respuestaError(res, 401, 'NO_AUTENTICADO', 'Falta el token Bearer.');
    }
    const payload = tokens.verificar(token);
    if (!payload || typeof payload.sub !== 'string' || typeof payload.rol !== 'string') {
      return respuestaError(res, 401, 'NO_AUTENTICADO', 'Token inválido o vencido.');
    }
    req.actor = { id: payload.sub, rol: payload.rol };
    next();
  };
}

export function requerirRol(...roles) {
  return function exigirRol(req, res, next) {
    const rol = req.actor?.rol;
    if (!roles.includes(rol)) {
      return respuestaError(
        res,
        403,
        'ROL_NO_AUTORIZADO',
        `Se requiere rol ${roles.join(' o ')}, se recibió ${rol ?? 'ninguno'}.`
      );
    }
    next();
  };
}
