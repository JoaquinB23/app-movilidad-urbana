// Cliente de la API. Todo pedido lleva el JWT en Authorization: Bearer.

export const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3000';

export class ErrorApi extends Error {
  constructor(status, cuerpo) {
    super(cuerpo?.error?.mensaje ?? `HTTP ${status}`);
    this.status = status;
    this.codigo = cuerpo?.error?.codigo ?? null;
  }
}

export async function pedir(ruta, { metodo = 'GET', token, cuerpo, encabezados = {}, signal } = {}) {
  const res = await fetch(`${API_BASE}${ruta}`, {
    method: metodo,
    headers: {
      ...(cuerpo === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...encabezados,
    },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    signal,
  });
  const texto = await res.text();
  const datos = texto ? JSON.parse(texto) : null;
  if (!res.ok) throw new ErrorApi(res.status, datos);
  return datos;
}

// Seguimiento por SSE leido con fetch (no EventSource): asi el stream usa el
// MISMO Bearer que el resto de la API (EventSource no permite encabezados).
// Si la conexion se corta, reconecta con Last-Event-ID; el servidor manda
// primero un snapshot con el estado actual, asi que nada se pierde.
export function seguir(viajeId, token, alEvento) {
  const controlador = new AbortController();
  let ultimoId = null;

  async function conectar() {
    while (!controlador.signal.aborted) {
      try {
        const res = await fetch(`${API_BASE}/viajes/${viajeId}/seguimiento`, {
          headers: {
            authorization: `Bearer ${token}`,
            ...(ultimoId ? { 'last-event-id': ultimoId } : {}),
          },
          signal: controlador.signal,
        });
        if (!res.ok) return; // 403/404: no hay nada que seguir
        const lector = res.body.getReader();
        const decodificador = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await lector.read();
          if (done) break;
          buffer += decodificador.decode(value, { stream: true });
          let corte;
          while ((corte = buffer.indexOf('\n\n')) >= 0) {
            const bloque = buffer.slice(0, corte);
            buffer = buffer.slice(corte + 2);
            const tipo = bloque.match(/^event: (.+)$/m)?.[1];
            const datos = bloque.match(/^data: (.+)$/m)?.[1];
            const id = bloque.match(/^id: (.+)$/m)?.[1];
            if (id) ultimoId = id;
            if (tipo && datos) alEvento({ tipo, datos: JSON.parse(datos) });
            if (tipo === 'acceso_revocado') return;
          }
        }
      } catch (error) {
        if (controlador.signal.aborted) return;
        console.warn('Seguimiento interrumpido, reconectando...', error);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  conectar();
  return () => controlador.abort();
}

export const formatearPesos = (centavos) =>
  centavos === null || centavos === undefined
    ? '—'
    : (centavos / 100).toLocaleString('es-AR', { style: 'currency', currency: 'ARS' });

export const ETIQUETAS_ESTADO = Object.freeze({
  solicitado: 'Buscando chofer',
  asignado: 'Chofer asignado',
  chofer_en_camino: 'Chofer en camino',
  en_curso: 'Viaje en curso',
  finalizado: 'Finalizado',
  cancelado_pasajero: 'Cancelado',
  cancelado_chofer: 'Cancelado por el chofer',
  sin_choferes: 'No se encontró chofer',
});
