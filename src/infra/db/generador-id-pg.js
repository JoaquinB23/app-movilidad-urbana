import { randomUUID } from 'node:crypto';

export function crearGeneradorIdPg() {
  return { nuevo: () => randomUUID() };
}
