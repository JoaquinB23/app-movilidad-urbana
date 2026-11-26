// Logger JSON (pino) con el id de pedido propagado por AsyncLocalStorage.
//
// Bloque 4 del enunciado: cualquier log que se emita MIENTRAS se atiende un
// pedido (en un repositorio, un caso de uso, despues de varios await) lleva el
// mismo idCorrelacion, sin pasarlo a mano por cada funcion. El middleware abre
// el contexto con `contextoPedido.run(...)` y el `mixin` de pino lo lee en cada
// linea. Fuera de un pedido (workers, arranque) el campo no aparece.

import { AsyncLocalStorage } from 'node:async_hooks';

import pino from 'pino';

export const contextoPedido = new AsyncLocalStorage();

export function idCorrelacionActual() {
  return contextoPedido.getStore()?.idCorrelacion ?? null;
}

export function crearLogger({ nivel = 'info', destino } = {}) {
  return pino(
    {
      level: nivel,
      mixin() {
        const id = idCorrelacionActual();
        return id ? { idCorrelacion: id } : {};
      },
    },
    destino
  );
}
