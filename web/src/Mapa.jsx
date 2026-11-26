import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapContainer, Marker, Polyline, TileLayer, Tooltip, useMapEvents } from 'react-leaflet';

// Centro por defecto: Resistencia, Chaco.
export const CENTRO = { lat: -27.4514, lng: -58.9866 };

// Marcadores dibujados con CSS (divIcon): los iconos de imagen por defecto de
// Leaflet se rompen al empaquetar con Vite y no hacen falta.
const icono = (clase, texto) => L.divIcon({
  className: '',
  html: `<div class="pin ${clase}"><span>${texto}</span></div>`,
  iconSize: [30, 30],
  iconAnchor: [15, 30],
});
const ICONOS = {
  origen: icono('pin-origen', 'A'),
  destino: icono('pin-destino', 'B'),
  chofer: icono('pin-chofer', '🚗'),
};

const redondear = ({ lat, lng }) => ({ lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) });

function AlHacerClick({ alHacerClick }) {
  useMapEvents({ click: (evento) => alHacerClick?.(redondear(evento.latlng)) });
  return null;
}

// Mapa reutilizable: muestra origen, destino y chofer. Si `editable`, un
// click llama a alHacerClick; los marcadores de origen y destino se pueden
// arrastrar solo si ademas se pasa alMover (en el mapa del chofer son fijos).
export default function Mapa({
  origen, destino, chofer, editable = false, alHacerClick, alMover, testid = 'mapa',
  etiquetaOrigen = 'Origen', etiquetaDestino = 'Destino',
}) {
  const marcadorEditable = (tipo, punto) => (
    <Marker
      position={[punto.lat, punto.lng]}
      icon={ICONOS[tipo]}
      draggable={editable && Boolean(alMover)}
      eventHandlers={{ dragend: (e) => alMover?.(tipo, redondear(e.target.getLatLng())) }}
    >
      <Tooltip>{tipo === 'origen' ? etiquetaOrigen : etiquetaDestino}</Tooltip>
    </Marker>
  );

  return (
    <div className={`mapa ${editable ? 'mapa-editable' : ''}`} data-testid={testid}>
      <MapContainer center={[CENTRO.lat, CENTRO.lng]} zoom={14} scrollWheelZoom>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {editable && <AlHacerClick alHacerClick={alHacerClick} />}
        {origen && marcadorEditable('origen', origen)}
        {destino && marcadorEditable('destino', destino)}
        {origen && destino && (
          <Polyline positions={[[origen.lat, origen.lng], [destino.lat, destino.lng]]} pathOptions={{ dashArray: '6 8', weight: 3 }} />
        )}
        {chofer && (
          <Marker position={[chofer.lat, chofer.lng]} icon={ICONOS.chofer}>
            <Tooltip>Chofer</Tooltip>
          </Marker>
        )}
      </MapContainer>
    </div>
  );
}
