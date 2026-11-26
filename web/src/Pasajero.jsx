import { useCallback, useEffect, useRef, useState } from 'react';

import { ETIQUETAS_ESTADO, formatearPesos, pedir, seguir } from './api.js';
import Mapa from './Mapa.jsx';

const TERMINALES = new Set(['finalizado', 'cancelado_pasajero', 'cancelado_chofer', 'sin_choferes']);
const ORIGEN = { lat: -27.4514, lng: -58.9866 };
const DESTINO = { lat: -27.46, lng: -58.99 };

function Coordenadas({ titulo, valor, alCambiar, prefijo }) {
  return (
    <fieldset>
      <legend>{titulo}</legend>
      <input data-testid={`${prefijo}-lat`} type="number" step="0.0001" value={valor.lat}
        onChange={(e) => alCambiar({ ...valor, lat: Number(e.target.value) })} aria-label={`${titulo} latitud`} />
      <input data-testid={`${prefijo}-lng`} type="number" step="0.0001" value={valor.lng}
        onChange={(e) => alCambiar({ ...valor, lng: Number(e.target.value) })} aria-label={`${titulo} longitud`} />
    </fieldset>
  );
}

// Que se muestra como importe en el historial: solo un viaje finalizado tiene
// un total real. Si no hubo chofer no hubo viaje, y uno cancelado no se cobra.
function importeDeHistorial(viaje) {
  if (viaje.estado === 'finalizado') return formatearPesos(viaje.tarifaFinalCentavos);
  if (viaje.estado === 'sin_choferes') return null; // el estado ya lo dice
  if (viaje.estado.startsWith('cancelado')) return 'Sin cargo';
  return `Estimado ${formatearPesos(viaje.tarifaEstimadaCentavos)}`;
}

export default function Pasajero({ token }) {
  const [origen, setOrigen] = useState(ORIGEN);
  const [destino, setDestino] = useState(DESTINO);
  const [estimacion, setEstimacion] = useState(null);
  // Que marca el proximo click en el mapa. Tras elegir el origen pasa solo
  // al destino.
  const [marcando, setMarcando] = useState('origen');
  const [viaje, setViaje] = useState(null); // { id, estado }
  const [posicionChofer, setPosicionChofer] = useState(null);
  const [historial, setHistorial] = useState([]);
  const [cobro, setCobro] = useState(null);
  const [error, setError] = useState(null);
  // Una Idempotency-Key por intento de pedido o de pago: un reintento (doble
  // click, red cortada) reusa la misma clave y no crea un segundo viaje o cobro.
  const clavePedido = useRef(null);
  const clavesCobro = useRef(new Map());

  const actualizarHistorial = useCallback(async () => {
    const { viajes } = await pedir('/pasajeros/me/viajes?limite=10', { token });
    setHistorial(viajes);
    return viajes;
  }, [token]);

  // Al entrar (o recargar) se recupera el viaje en curso desde el historial.
  useEffect(() => {
    actualizarHistorial()
      .then((viajes) => {
        const activo = viajes.find((v) => !TERMINALES.has(v.estado));
        if (activo) setViaje({ id: activo.id, estado: activo.estado });
      })
      .catch(() => setError('No se pudo cargar el historial.'));
  }, [actualizarHistorial]);

  // Seguimiento en tiempo real del viaje actual: estado y posicion del chofer.
  useEffect(() => {
    if (!viaje?.id) return undefined;
    return seguir(viaje.id, token, ({ tipo, datos }) => {
      if (tipo === 'snapshot') {
        setViaje((v) => ({ ...v, estado: datos.estado }));
        if (datos.posicionContraparte) setPosicionChofer(datos.posicionContraparte);
      }
      if (tipo === 'estado' || tipo === 'reasignado') setViaje((v) => ({ ...v, estado: datos.estado }));
      if (tipo === 'posicion') setPosicionChofer({ lat: datos.lat, lng: datos.lng });
    });
  }, [viaje?.id, token]);

  // Al terminar el viaje se refresca el historial (trae la tarifa final).
  useEffect(() => {
    if (viaje && TERMINALES.has(viaje.estado)) actualizarHistorial().catch(() => {});
  }, [viaje, actualizarHistorial]);

  async function ejecutar(accion) {
    setError(null);
    try {
      await accion();
    } catch (err) {
      setError(err.message);
    }
  }

  // Cambiar un punto invalida la estimacion anterior.
  function elegirPunto(tipo, punto) {
    setEstimacion(null);
    if (tipo === 'origen') {
      setOrigen(punto);
      setMarcando('destino');
    } else {
      setDestino(punto);
    }
  }

  const estimar = () => ejecutar(async () => {
    setEstimacion(await pedir('/viajes/estimacion', { metodo: 'POST', token, cuerpo: { origen, destino } }));
  });

  const pedirViaje = () => ejecutar(async () => {
    clavePedido.current ??= crypto.randomUUID();
    const nuevo = await pedir('/viajes', {
      metodo: 'POST', token, cuerpo: { origen, destino },
      encabezados: { 'Idempotency-Key': clavePedido.current },
    });
    clavePedido.current = null;
    setCobro(null);
    setPosicionChofer(null);
    setViaje({ id: nuevo.id, estado: nuevo.estado });
  });

  const cancelar = () => ejecutar(async () => {
    const r = await pedir(`/viajes/${viaje.id}/cancelar`, { metodo: 'POST', token });
    setViaje((v) => ({ ...v, estado: r.estado }));
  });

  const pagar = () => ejecutar(async () => {
    if (!clavesCobro.current.has(viaje.id)) clavesCobro.current.set(viaje.id, crypto.randomUUID());
    setCobro(await pedir(`/viajes/${viaje.id}/cobro`, {
      metodo: 'POST', token, encabezados: { 'Idempotency-Key': clavesCobro.current.get(viaje.id) },
    }));
  });

  const terminado = viaje && TERMINALES.has(viaje.estado);
  const datosViaje = viaje && historial.find((v) => v.id === viaje.id);

  return (
    <section className="columnas">
      <div className="tarjeta principal">
        <h2>Pedir un viaje</h2>
        <div className="acciones selector" role="group" aria-label="Qué marcar en el mapa">
          <button data-testid="marcar-origen" className={marcando === 'origen' ? '' : 'secundario'}
            onClick={() => setMarcando('origen')} aria-pressed={marcando === 'origen'}>A · Origen</button>
          <button data-testid="marcar-destino" className={marcando === 'destino' ? '' : 'secundario'}
            onClick={() => setMarcando('destino')} aria-pressed={marcando === 'destino'}>B · Destino</button>
        </div>
        <p className="tenue ayuda">
          {viaje && !terminado
            ? 'Viaje en curso: el mapa muestra al chofer.'
            : `Tocá el mapa para marcar el ${marcando}. También podés arrastrar los marcadores.`}
        </p>
        <Mapa
          origen={origen}
          destino={destino}
          chofer={viaje && !terminado ? posicionChofer : null}
          editable={!viaje || terminado}
          alHacerClick={(punto) => elegirPunto(marcando, punto)}
          alMover={elegirPunto}
        />
        <details className="avanzado">
          <summary>Coordenadas (avanzado)</summary>
          <Coordenadas titulo="Origen" prefijo="origen" valor={origen} alCambiar={(p) => elegirPunto('origen', p)} />
          <Coordenadas titulo="Destino" prefijo="destino" valor={destino} alCambiar={(p) => elegirPunto('destino', p)} />
        </details>
        <div className="acciones">
          <button data-testid="btn-estimar" className="secundario" onClick={estimar}>Estimar</button>
          <button data-testid="btn-pedir" onClick={pedirViaje} disabled={viaje && !terminado}>Pedir viaje</button>
        </div>
        {estimacion && (
          <p data-testid="estimacion">
            {(estimacion.distanciaMetros / 1000).toFixed(1)} km · {Math.round(estimacion.duracionSegundos / 60)} min ·{' '}
            <strong data-testid="precio-estimado">{formatearPesos(estimacion.precioCentavos)}</strong>
          </p>
        )}
      </div>

      <div className="tarjeta">
        <h2>Mi viaje</h2>
        {!viaje && <p className="tenue">Todavía no pediste un viaje.</p>}
        {viaje && (
          <>
            <p className={`estado estado-${viaje.estado}`} data-testid="estado-viaje" data-estado={viaje.estado}>
              {ETIQUETAS_ESTADO[viaje.estado] ?? viaje.estado}
            </p>
            {posicionChofer && !terminado && (
              <p className="tenue" data-testid="posicion-chofer">
                Chofer en {posicionChofer.lat.toFixed(4)}, {posicionChofer.lng.toFixed(4)}
              </p>
            )}
            {!terminado && <button data-testid="btn-cancelar" className="peligro" onClick={cancelar}>Cancelar viaje</button>}
            {viaje.estado === 'finalizado' && (
              <>
                <p>Tarifa final: <strong data-testid="tarifa-final">{formatearPesos(datosViaje?.tarifaFinalCentavos)}</strong></p>
                {!cobro && <button data-testid="btn-pagar" onClick={pagar}>Pagar</button>}
                {cobro && <p className="ok" data-testid="cobro-ok">Pago aprobado: {formatearPesos(cobro.importeCentavos)}</p>}
              </>
            )}
          </>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </div>

      <div className="tarjeta ancha">
        <h2>Historial</h2>
        {historial.length === 0 && <p className="tenue">Sin viajes.</p>}
        <ul className="lista" data-testid="historial">
          {historial.map((v) => (
            <li key={v.id}>
              <span>{new Date(v.creadoEn).toLocaleString('es-AR')}</span>
              <span>{ETIQUETAS_ESTADO[v.estado] ?? v.estado}</span>
              <span data-testid="historial-importe">{importeDeHistorial(v)}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
