// Adaptador del puerto ParametrosViajes (lo consumen estimarViaje y
// solicitarViaje) construido sobre la configuracion administrable
// (repositorioAdministracion: tablas tarifas y parametros).
//
// Por que un adaptador y no leer las tablas desde viajes: la configuracion la
// edita el administrador (modulo de identidad/administracion); viajes solo
// necesita una vista con SUS nombres. Este archivo es la traduccion entre los
// dos vocabularios, y funciona igual sobre el repo PG o el de memoria.
//
// Se lee en cada llamada (sin cache): un PUT /admin/parametros aplica al
// proximo viaje sin reiniciar. Son dos consultas indexadas por PK por viaje;
// si alguna vez pesara, se agrega un cache con vencimiento corto.

function exigirNumero(parametros, clave) {
  const valor = parametros[clave];
  if (typeof valor !== 'number' || !Number.isFinite(valor)) {
    // Falla cerrado: sin un parametro no se cotiza con un valor inventado.
    throw new Error(`Falta el parametro '${clave}' (¿se aplicaron las migraciones 300 y 301?).`);
  }
  return valor;
}

export function crearParametrosViajes({ repositorioAdministracion }) {
  if (
    typeof repositorioAdministracion?.obtenerTarifas !== 'function' ||
    typeof repositorioAdministracion?.obtenerParametros !== 'function'
  ) {
    throw new TypeError('crearParametrosViajes requiere repositorioAdministracion.');
  }

  return {
    async obtener() {
      const [tarifas, parametros] = await Promise.all([
        repositorioAdministracion.obtenerTarifas(),
        repositorioAdministracion.obtenerParametros(),
      ]);
      if (!tarifas) throw new Error('No hay una tarifa vigente cargada (tabla tarifas).');

      return {
        tarifa: {
          tarifaBaseCentavos: tarifas.bajadaBanderaCentavos,
          porKmCentavos: tarifas.precioKmCentavos,
          porMinutoCentavos: tarifas.precioMinutoCentavos,
          tarifaMinimaCentavos: exigirNumero(parametros, 'tarifa_minima_centavos'),
          distanciaMaximaMetros: exigirNumero(parametros, 'distancia_maxima_m'),
        },
        tiempoOfertaSegundos: exigirNumero(parametros, 'tiempo_limite_oferta_s'),
        radioBusquedaMetros: exigirNumero(parametros, 'radio_busqueda_m'),
        maxCandidatos: exigirNumero(parametros, 'max_candidatos'),
      };
    },
  };
}
