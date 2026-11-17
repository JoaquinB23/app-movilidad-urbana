// Adaptador del puerto `tokens` sobre jsonwebtoken (HS256).
//
// Config por entorno: JWT_SECRETO (obligatorio, >= 32 chars), JWT_EMISOR,
// JWT_AUDIENCIA, JWT_EXPIRACION (default '8h').
// `verificar` fija el algoritmo esperado explícitamente: nunca se acepta
// `alg: none` ni un downgrade de algoritmo.

import jwt from 'jsonwebtoken';

export function crearTokensJwt(env = process.env) {
  const secreto = env.JWT_SECRETO;
  if (typeof secreto !== 'string' || secreto.length < 32) {
    throw new TypeError('JWT_SECRETO es obligatorio y debe tener al menos 32 caracteres.');
  }
  const emisor = env.JWT_EMISOR || 'app-movilidad-urbana';
  const audiencia = env.JWT_AUDIENCIA || 'app-movilidad-urbana';
  const expiracion = env.JWT_EXPIRACION || '8h';

  return {
    firmar(payload) {
      return jwt.sign(payload, secreto, {
        algorithm: 'HS256',
        issuer: emisor,
        audience: audiencia,
        expiresIn: expiracion,
      });
    },
    // Devuelve el payload o null (nunca lanza): la capa HTTP traduce null a 401.
    verificar(token) {
      try {
        return jwt.verify(token, secreto, {
          algorithms: ['HS256'],
          issuer: emisor,
          audience: audiencia,
        });
      } catch {
        return null;
      }
    },
  };
}
