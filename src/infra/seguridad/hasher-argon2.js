// Adaptador del puerto `hasher` sobre argon2id.
//
// El COSTO viene de variables de entorno para poder bajarlo en tests (rápidos)
// y subirlo en producción sin tocar código:
//   ARGON2_MEMORIA_KIB (default 65536 = 64 MiB)
//   ARGON2_ITERACIONES (default 3)
//   ARGON2_PARALELISMO (default 1)
//
// `hashSenuelo` es un hash válido de una contraseña aleatoria que el servicio
// de login verifica cuando el email NO existe: así el tiempo de respuesta es
// el mismo exista o no la cuenta (mitiga enumeración por timing).

import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

function leerEnteroEnv(env, nombre, defecto) {
  const crudo = env[nombre];
  if (crudo === undefined || crudo === '') return defecto;
  const valor = Number.parseInt(crudo, 10);
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nombre} debe ser un entero positivo; se recibió '${crudo}'.`);
  }
  return valor;
}

export async function crearHasherArgon2(env = process.env) {
  const opciones = {
    type: argon2.argon2id,
    memoryCost: leerEnteroEnv(env, 'ARGON2_MEMORIA_KIB', 65536),
    timeCost: leerEnteroEnv(env, 'ARGON2_ITERACIONES', 3),
    parallelism: leerEnteroEnv(env, 'ARGON2_PARALELISMO', 1),
  };

  const hashSenuelo = await argon2.hash(randomBytes(32).toString('hex'), opciones);

  return {
    hashSenuelo,
    hashear: (plano) => argon2.hash(plano, opciones),
    async verificar(hash, plano) {
      try {
        return await argon2.verify(hash, plano);
      } catch {
        // Hash corrupto o de otro algoritmo: credenciales inválidas, no 500.
        return false;
      }
    },
  };
}
