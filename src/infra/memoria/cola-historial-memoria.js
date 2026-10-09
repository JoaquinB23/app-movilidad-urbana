// Cola de escritura del historial de ubicaciones (tarea pesada del modulo).
//
// Problema: con 500 choferes enviando ubicacion cada 2 s son ~250 escrituras/s
// en la tabla de historial. Hacer un INSERT por request mete ese trabajo en el
// camino critico del request (mas latencia) y satura la base con round-trips.
//
// Solucion (ver ADR de tarea pesada): ENCOLAR en memoria (O(1)) y hacer flush
// por LOTES con un solo INSERT multi-fila. El request responde apenas encola; la
// escritura real ocurre en segundo plano.
//
// Decision: el buffer se vacia cuando llega a `maxLote` o cada `intervaloMs`.
// Ambos parametros configurables. `drenar()` fuerza el flush (tests y SIGTERM).
//
// Alternativas descartadas (documentadas en el ADR): worker_threads (el cuello
// es I/O de base, no CPU, moverlo a otro hilo no ayuda) y stream directo al
// request (no permite batchear entre requests y complica el ciclo de vida).

export function crearColaHistorial({ escribirLote, maxLote = 200, intervaloMs = 0 }) {
  if (typeof escribirLote !== 'function') {
    throw new Error("La cola del historial requiere 'escribirLote'.");
  }
  if (!Number.isInteger(maxLote) || maxLote <= 0) {
    throw new Error('maxLote debe ser un entero positivo.');
  }
  if (!Number.isInteger(intervaloMs) || intervaloMs < 0) {
    throw new Error('intervaloMs debe ser un entero no negativo.');
  }

  let buffer = [];
  let temporizador = null;
  let enFlush = null;

  async function flush() {
    if (buffer.length === 0) return 0;
    const lote = buffer;
    buffer = [];
    // Se asigna antes del await para que otros `encolar` no pierdan el lote.
    await escribirLote(lote);
    return lote.length;
  }

  function programarFlush() {
    if (enFlush) return enFlush;
    enFlush = flush()
      .catch(() => 0)
      .finally(() => {
        enFlush = null;
      });
    return enFlush;
  }

  if (intervaloMs > 0) {
    temporizador = setInterval(() => {
      void programarFlush();
    }, intervaloMs);
    // No mantener vivo el proceso solo por el temporizador.
    if (typeof temporizador.unref === 'function') temporizador.unref();
  }

  return {
    encolar(registro) {
      buffer.push(registro);
      if (buffer.length >= maxLote) {
        void programarFlush();
      }
    },

    async drenar() {
      // Espera cualquier flush en curso y luego vacia todo lo pendiente.
      if (enFlush) await enFlush;
      let total = 0;
      while (buffer.length > 0) {
        total += await flush();
      }
      return total;
    },

    tamano() {
      return buffer.length;
    },

    detener() {
      if (temporizador) {
        clearInterval(temporizador);
        temporizador = null;
      }
    },
  };
}
