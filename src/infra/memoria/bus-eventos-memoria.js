// Adaptador en memoria del BusEventos.
//
// Por que un bus y no "emitir directo al response": el SSE desacopla al emisor
// (el modulo de viajes/ubicaciones) del conjunto de clientes conectados. El
// emisor solo publica en un canal; N seguidores reciben. Esto permite ademas
// otro transporte (WebSocket) sin tocar el dominio.
//
// Last-Event-ID: el bus conserva un LOG acotado por canal con ids monotonos
// (1, 2, 3...). Si un cliente se reconecta manda `Last-Event-ID` y el bus
// reenvia lo perdido. El id es por canal para que el SSE pueda usarlo tal cual.
//
// Decision: `capacidadPorCanal` es finita a proposito. Un log infinito seria una
// fuga de memoria; si el cliente estuvo desconectado mas alla de la ventana, se
// le entrega el snapshot actual (GET /estado) en vez del historial completo.

export function crearBusEventosMemoria({ capacidadPorCanal = 500 } = {}) {
  if (!Number.isInteger(capacidadPorCanal) || capacidadPorCanal <= 0) {
    throw new Error('capacidadPorCanal debe ser un entero positivo.');
  }

  // canal -> { contador, log: Array<{id, tipo, datos}> }
  const canales = new Map();
  // canal -> Set<manejador>
  const suscriptores = new Map();

  function estadoDe(canal) {
    let estado = canales.get(canal);
    if (!estado) {
      estado = { contador: 0, log: [] };
      canales.set(canal, estado);
    }
    return estado;
  }

  return {
    publicar(canal, { tipo, datos } = {}) {
      if (typeof canal !== 'string' || canal.length === 0) {
        throw new Error('El canal debe ser un string no vacio.');
      }
      if (typeof tipo !== 'string' || tipo.length === 0) {
        throw new Error('El evento debe tener un tipo no vacio.');
      }
      const estado = estadoDe(canal);
      estado.contador += 1;
      const entrada = { id: String(estado.contador), tipo, datos: datos ?? {} };
      estado.log.push(entrada);
      if (estado.log.length > capacidadPorCanal) {
        estado.log.splice(0, estado.log.length - capacidadPorCanal);
      }
      for (const manejador of suscriptores.get(canal) ?? []) {
        // Se aisla cada suscriptor: si uno falla, los demas igual reciben.
        try {
          manejador(entrada);
        } catch {
          /* el bus no debe romperse por un suscriptor defectuoso */
        }
      }
    },

    suscribir(canal, manejador) {
      if (typeof manejador !== 'function') {
        throw new Error('El manejador debe ser una funcion.');
      }
      let conjunto = suscriptores.get(canal);
      if (!conjunto) {
        conjunto = new Set();
        suscriptores.set(canal, conjunto);
      }
      conjunto.add(manejador);
      return () => {
        conjunto.delete(manejador);
        if (conjunto.size === 0) suscriptores.delete(canal);
      };
    },

    eventosDesde(canal, ultimoId = null) {
      const estado = canales.get(canal);
      if (!estado) return [];
      if (ultimoId === null || ultimoId === undefined || ultimoId === '') {
        return estado.log.map((e) => ({ ...e }));
      }
      const desde = Number(ultimoId);
      if (!Number.isFinite(desde)) {
        // Un Last-Event-ID corrupto no debe tumbar la conexion: se ignora y se
        // devuelve el log disponible.
        return estado.log.map((e) => ({ ...e }));
      }
      return estado.log.filter((e) => Number(e.id) > desde).map((e) => ({ ...e }));
    },
  };
}
