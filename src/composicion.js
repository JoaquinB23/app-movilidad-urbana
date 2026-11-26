// Composicion de dependencias: este archivo construye los adaptadores concretos a partir de la configuracion.
import { crearRutasViajes } from './infra/http/rutas/viajes.js';
import { crearEstimarViaje } from './dominio/viajes/casos-de-uso/estimar-viaje.js';
import { crearSolicitarViaje } from './dominio/viajes/casos-de-uso/solicitar-viaje.js';
import { crearObtenerViaje } from './dominio/viajes/casos-de-uso/obtener-viaje.js';
import { crearAceptarOferta } from './dominio/viajes/casos-de-uso/aceptar-oferta.js';
import { crearRechazarOferta } from './dominio/viajes/casos-de-uso/continuar-oferta.js';
import { crearListarOfertasVigentes } from './dominio/viajes/casos-de-uso/listar-ofertas-vigentes.js';

// Viajes
export function montarViajes(app, deps) {
  app.use(crearRutasViajes({
    autenticar: deps.autenticar,
    requerirRol: deps.requerirRol,
    estimarViaje: crearEstimarViaje(deps),
    solicitarViaje: crearSolicitarViaje(deps),
    obtenerViaje: crearObtenerViaje(deps),
    listarOfertasVigentes: crearListarOfertasVigentes(deps),
    aceptarOferta: crearAceptarOferta(deps),
    rechazarOferta: crearRechazarOferta(deps),
  }));
}
