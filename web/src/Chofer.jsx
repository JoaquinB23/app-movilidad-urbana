import { useCallback, useEffect, useRef, useState } from 'react';

import { ETIQUETAS_ESTADO, formatearPesos, pedir, seguir } from './api.js';
import Mapa from './Mapa.jsx';
import { distanciaMetros, formatearDistancia } from './geo.js';

const TERMINALES = new Set(['finalizado', 'cancelado_pasajero', 'cancelado_chofer', 'sin_choferes']);
// Posicion simulada (sin GPS real): el chofer arranca en el centro y se mueve
// un poco en cada envio. Mientras esta disponible reporta cada 3 s.
const BASE = { lat: -27.4514, lng: -58.9866 };
const INTERVALO_UBICACION_MS = 3000;
const INTERVALO_OFERTAS_MS = 2000;

// Siguiente accion del chofer segun el estado del viaje.
const SIGUIENTE = Object.freeze({
  asignado: { ruta: 'en-camino', texto: 'Salir en camino', testid: 'btn-en-camino' },
  chofer_en_camino: { ruta: 'iniciar', texto: 'Iniciar viaje', testid: 'btn-iniciar' },
  en_curso: { ruta: 'finalizar', texto: 'Finalizar viaje', testid: 'btn-finalizar' },
});

export default function Chofer({ token }) {
  const [disponible, setDisponible] = useState(false);
  const [ofertas, setOfertas] = useState([]);
  const [viaje, setViaje] = useState(null); // { id, estado, tarifaFinalCentavos }
  const [envios, setEnvios] = useState(0);
  const [error, setError] = useState(null);
  const posicion = useRef({ ...BASE });
  // Copia en el estado para dibujarla en el mapa (el ref no re-renderiza).
  const [posicionVista, setPosicionVista] = useState({ ...BASE });

  async function ejecutar(accion) {
    setError(null);
    try {
      await accion();
    } catch (err) {
      setError(err.message);
    }
  }

  // Recupera el viaje activo (si se recargo la pagina en medio de un viaje).
  useEffect(() => {
    pedir('/choferes/me/viajes?limite=5', { token })
      .then(({ viajes }) => {
        const activo = viajes.find((v) => !TERMINALES.has(v.estado));
        if (activo) setViaje({ id: activo.id, estado: activo.estado, origen: activo.origen, destino: activo.destino });
      })
      .catch(() => {});
  }, [token]);

  // Reporte periodico de ubicacion mientras esta disponible.
  const enviarUbicacion = useCallback(async () => {
    posicion.current = {
      lat: posicion.current.lat + (Math.random() - 0.5) * 0.0004,
      lng: posicion.current.lng + (Math.random() - 0.5) * 0.0004,
    };
    await pedir('/choferes/me/ubicacion', {
      metodo: 'POST', token, cuerpo: { ...posicion.current, timestamp: new Date().toISOString() },
    });
    setPosicionVista({ ...posicion.current });
    setEnvios((n) => n + 1);
  }, [token]);

  useEffect(() => {
    if (!disponible) return undefined;
    enviarUbicacion().catch(() => {});
    const id = setInterval(() => enviarUbicacion().catch(() => {}), INTERVALO_UBICACION_MS);
    return () => clearInterval(id);
  }, [disponible, enviarUbicacion]);

  // Consulta de ofertas vigentes (solo si esta disponible y sin viaje activo).
  const libre = !viaje || TERMINALES.has(viaje.estado);
  useEffect(() => {
    if (!disponible || !libre) {
      setOfertas([]);
      return undefined;
    }
    let vivo = true;
    async function consultar() {
      try {
        const { ofertas: nuevas } = await pedir('/choferes/me/ofertas', { token });
        if (vivo) setOfertas(nuevas);
      } catch {
        /* se reintenta en el proximo ciclo */
      }
    }
    consultar();
    const id = setInterval(consultar, INTERVALO_OFERTAS_MS);
    return () => {
      vivo = false;
      clearInterval(id);
    };
  }, [disponible, libre, token]);

  // Cambios de estado que no dispara el chofer (p. ej. el pasajero cancela).
  useEffect(() => {
    if (!viaje?.id) return undefined;
    return seguir(viaje.id, token, ({ tipo, datos }) => {
      if (tipo === 'snapshot' || tipo === 'estado') setViaje((v) => (v ? { ...v, estado: datos.estado } : v));
      if (tipo === 'acceso_revocado') setViaje((v) => (v ? { ...v, estado: 'reasignado' } : v));
    });
  }, [viaje?.id, token]);

  const cambiarDisponibilidad = () => ejecutar(async () => {
    const r = await pedir('/choferes/me/disponibilidad', { metodo: 'PUT', token, cuerpo: { disponible: !disponible } });
    setDisponible(r.disponible);
  });

  const aceptar = (oferta) => ejecutar(async () => {
    const r = await pedir(`/ofertas/${oferta.id}/aceptar`, { metodo: 'POST', token });
    setOfertas([]);
    // Donde buscar y donde dejar al pasajero: lo trae GET /viajes/:id.
    const detalle = await pedir(`/viajes/${r.viajeId}`, { token });
    setViaje({ id: r.viajeId, estado: r.estado, origen: detalle.origen, destino: detalle.destino });
  });

  const rechazar = (oferta) => ejecutar(async () => {
    await pedir(`/ofertas/${oferta.id}/rechazar`, { metodo: 'POST', token });
    setOfertas((lista) => lista.filter((o) => o.id !== oferta.id));
  });

  const avanzar = (ruta) => ejecutar(async () => {
    const r = await pedir(`/viajes/${viaje.id}/${ruta}`, { metodo: 'POST', token });
    setViaje((v) => ({ ...v, estado: r.estado, tarifaFinalCentavos: r.tarifaFinalCentavos }));
  });

  const cancelar = () => ejecutar(async () => {
    const r = await pedir(`/viajes/${viaje.id}/cancelar`, { metodo: 'POST', token });
    setViaje((v) => ({ ...v, estado: r.estado }));
  });

  const siguiente = viaje && SIGUIENTE[viaje.estado];
  // En el mapa: el viaje activo o, si esta libre, la primera oferta.
  const enViaje = viaje && !libre && viaje.estado !== 'reasignado';
  const enMapa = enViaje ? viaje : ofertas[0] ?? null;
  const indicacion = !enViaje ? null
    : viaje.estado === 'en_curso' ? 'Llevá al pasajero a B (destino).'
      : 'Buscá al pasajero en A (origen).';

  return (
    <section className="columnas">
      <div className="tarjeta principal">
        <h2>Disponibilidad</h2>
        <button data-testid="toggle-disponible" className={disponible ? 'peligro' : ''} onClick={cambiarDisponibilidad}>
          {disponible ? 'Dejar de estar disponible' : 'Estar disponible'}
        </button>
        <p className="tenue" data-testid="envios-ubicacion">
          {disponible ? `Disponible · ${envios} ubicaciones enviadas` : 'No disponible'}
        </p>
        <p className="tenue ayuda">
          {enViaje ? indicacion : ofertas[0] ? 'A: dónde buscar al pasajero · B: dónde dejarlo.' : 'Tu posición es simulada: tocá el mapa para moverte.'}
        </p>
        <Mapa
          testid="mapa-chofer"
          chofer={posicionVista}
          origen={enMapa?.origen ?? null}
          destino={enMapa?.destino ?? null}
          etiquetaOrigen="Buscar al pasajero"
          etiquetaDestino="Dejar al pasajero"
          editable
          alHacerClick={(punto) => {
            posicion.current = punto;
            setPosicionVista(punto);
          }}
        />
      </div>

      <div className="tarjeta">
        <h2>Ofertas</h2>
        {libre && ofertas.length === 0 && <p className="tenue">{disponible ? 'Esperando ofertas…' : 'Ponete disponible para recibir ofertas.'}</p>}
        <ul className="lista">
          {ofertas.map((oferta) => (
            <li key={oferta.id} data-testid="oferta-item">
              <span className="detalle-oferta">
                {oferta.origen ? (
                  <>
                    <span data-testid="oferta-retiro">Pasajero a {formatearDistancia(distanciaMetros(posicionVista, oferta.origen))} de vos</span>
                    <span className="tenue">
                      Viaje de {formatearDistancia(distanciaMetros(oferta.origen, oferta.destino))} · {formatearPesos(oferta.tarifaEstimadaCentavos)}
                      {' '}· vence {new Date(oferta.expiraEn).toLocaleTimeString('es-AR')}
                    </span>
                  </>
                ) : (
                  <span>Viaje nuevo · vence {new Date(oferta.expiraEn).toLocaleTimeString('es-AR')}</span>
                )}
              </span>
              <span className="acciones">
                <button data-testid="btn-aceptar" onClick={() => aceptar(oferta)}>Aceptar</button>
                <button data-testid="btn-rechazar" className="secundario" onClick={() => rechazar(oferta)}>Rechazar</button>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="tarjeta ancha">
        <h2>Viaje actual</h2>
        {!viaje && <p className="tenue">Sin viaje asignado.</p>}
        {viaje && (
          <>
            <p className={`estado estado-${viaje.estado}`} data-testid="estado-viaje-chofer" data-estado={viaje.estado}>
              {viaje.estado === 'reasignado' ? 'El viaje fue reasignado a otro chofer' : ETIQUETAS_ESTADO[viaje.estado] ?? viaje.estado}
            </p>
            {indicacion && <p data-testid="indicacion-chofer">{indicacion}</p>}
            <div className="acciones">
              {siguiente && (
                <button data-testid={siguiente.testid} onClick={() => avanzar(siguiente.ruta)}>{siguiente.texto}</button>
              )}
              {(viaje.estado === 'asignado' || viaje.estado === 'chofer_en_camino') && (
                <button data-testid="btn-cancelar-chofer" className="peligro" onClick={cancelar}>Cancelar</button>
              )}
            </div>
            {viaje.estado === 'finalizado' && (
              <p>Tarifa final: <strong data-testid="tarifa-final-chofer">{formatearPesos(viaje.tarifaFinalCentavos)}</strong></p>
            )}
          </>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </section>
  );
}
