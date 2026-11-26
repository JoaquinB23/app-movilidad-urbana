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
// Recuperacion ante fallas de la base (P1):
//   * Un lote que falla VUELVE AL FRENTE de la cola (se conserva el orden) en
//     vez de perderse. Antes se tragaba el error y las posiciones desaparecian.
//   * Reintentos automaticos con espera creciente (esperaInicialMs, x2 por
//     falla, tope esperaMaximaMs): con la base caida, los encolar() no la
//     martillan con un INSERT por request. Un exito vuelve la espera a cero.
//   * Tope de memoria `maxPendientes`: si la caida dura tanto que el buffer
//     superaria el tope, se descartan las posiciones MAS VIEJAS (la ultima
//     posicion es la que mas vale) y se cuentan en estadisticas().descartados.
//     Alternativa descartada: buffer sin tope (una caida larga tumba el
//     proceso por memoria y se pierde TODO, no solo lo viejo).
//   * `drenar()` ignora la espera (es explicito: tests y apagado) y, si la base
//     sigue caida, RECHAZA dejando lo pendiente en memoria, para que quien
//     apaga lo registre en el log en vez de creer que se escribio.
//
// Alternativas descartadas (documentadas en el ADR): worker_threads (el cuello
// es I/O de base, no CPU, moverlo a otro hilo no ayuda) y stream directo al
// request (no permite batchear entre requests y complica el ciclo de vida).

export function crearColaHistorial({
  escribirLote,
  maxLote = 200,
  intervaloMs = 0,
  maxPendientes = Math.max(50_000, maxLote),
  esperaInicialMs = 500,
  esperaMaximaMs = Math.max(30_000, esperaInicialMs),
  ahora = Date.now,
  alFallar = null,
  alDescartar = null,
}) {
  if (typeof escribirLote !== 'function') {
    throw new Error("La cola del historial requiere 'escribirLote'.");
  }
  if (!Number.isInteger(maxLote) || maxLote <= 0) {
    throw new Error('maxLote debe ser un entero positivo.');
  }
  if (!Number.isInteger(intervaloMs) || intervaloMs < 0) {
    throw new Error('intervaloMs debe ser un entero no negativo.');
  }
  if (!Number.isInteger(maxPendientes) || maxPendientes < maxLote) {
    throw new Error('maxPendientes debe ser un entero mayor o igual a maxLote.');
  }
  if (!Number.isInteger(esperaInicialMs) || esperaInicialMs <= 0) {
    throw new Error('esperaInicialMs debe ser un entero positivo.');
  }
  if (!Number.isInteger(esperaMaximaMs) || esperaMaximaMs < esperaInicialMs) {
    throw new Error('esperaMaximaMs debe ser un entero mayor o igual a esperaInicialMs.');
  }

  let buffer = [];
  let temporizador = null;
  let enFlush = null;
  let fallos = 0;
  let descartados = 0;
  let espera = 0;
  let reintentarDesde = 0;

  function aplicarTope() {
    const exceso = buffer.length - maxPendientes;
    if (exceso <= 0) return;
    buffer.splice(0, exceso);
    descartados += exceso;
    alDescartar?.({ descartados: exceso, pendientes: buffer.length });
  }

  // Escribe UN lote de hasta maxLote. Si falla, lo devuelve al frente de la
  // cola, agranda la espera y relanza el error.
  async function escribirUnLote() {
    const lote = buffer.splice(0, maxLote);
    if (lote.length === 0) return 0;
    try {
      await escribirLote(lote);
      espera = 0;
      reintentarDesde = 0;
      return lote.length;
    } catch (error) {
      buffer = lote.concat(buffer);
      fallos += 1;
      espera = espera === 0 ? esperaInicialMs : Math.min(espera * 2, esperaMaximaMs);
      reintentarDesde = ahora() + espera;
      aplicarTope();
      alFallar?.({ error, reencolados: lote.length, pendientes: buffer.length, esperaMs: espera });
      throw error;
    }
  }

  // Flush en segundo plano: escribe mientras haya al menos `minimo` pendientes
  // y no se este dentro de la espera posterior a una falla.
  function programarFlush(minimo) {
    if (enFlush || ahora() < reintentarDesde) return enFlush;
    enFlush = (async () => {
      while (buffer.length >= minimo && buffer.length > 0) {
        await escribirUnLote();
      }
    })()
      .catch(() => {}) // ya se reporto por alFallar y el lote quedo en la cola
      .finally(() => {
        enFlush = null;
      });
    return enFlush;
  }

  if (intervaloMs > 0) {
    temporizador = setInterval(() => {
      void programarFlush(1);
    }, intervaloMs);
    // No mantener vivo el proceso solo por el temporizador.
    if (typeof temporizador.unref === 'function') temporizador.unref();
  }

  return {
    encolar(registro) {
      buffer.push(registro);
      aplicarTope();
      if (buffer.length >= maxLote) {
        void programarFlush(maxLote);
      }
    },

    async drenar() {
      // Espera cualquier flush en curso y luego vacia todo lo pendiente.
      if (enFlush) await enFlush;
      let total = 0;
      while (buffer.length > 0) {
        total += await escribirUnLote();
      }
      return total;
    },

    tamano() {
      return buffer.length;
    },

    estadisticas() {
      return { pendientes: buffer.length, fallos, descartados };
    },

    detener() {
      if (temporizador) {
        clearInterval(temporizador);
        temporizador = null;
      }
    },
  };
}
