// Punto de entrada del servidor HTTP: valida la configuracion, compone la
// aplicacion, escucha, arranca los workers y la apaga de forma ordenada.
//
//   npm run dev     (con --watch)
//   npm start
//
// Apagado ordenado (SIGTERM de Docker/Compose o Ctrl+C):
//   1. Deja de aceptar conexiones nuevas (server.close).
//   2. Cierra las conexiones ociosas; las de SSE son largas, asi que si no
//      terminan antes de APAGADO_TIMEOUT_MS se cortan (el cliente se reconecta
//      con Last-Event-ID y recupera el estado con el snapshot).
//   3. Detiene workers, DRENA la cola del historial a la base y cierra el pool.
// Si algo se cuelga, un temporizador fuerza la salida con codigo 1.

import { pathToFileURL } from 'node:url';

import { cargarConfiguracion, ErrorConfiguracion } from './config/index.js';
import { componerAplicacion } from './composicion.js';

export async function arrancar(env = process.env) {
  const config = cargarConfiguracion(env);
  const aplicacion = await componerAplicacion({ config });
  const { app, logger, workers } = aplicacion;

  const server = app.listen(config.http.puerto, config.http.host);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  logger.info({ host: config.http.host, puerto: port }, 'servidor escuchando');

  workers.reasignacion.iniciar();
  workers.retencion.iniciar();
  workers.vencimiento.iniciar();

  let apagando = null;
  function apagar(senal) {
    if (apagando) return apagando;
    logger.info({ senal }, 'apagando');
    const forzar = setTimeout(() => {
      logger.error('el apagado supero el tiempo limite; se fuerza la salida');
      process.exit(1);
    }, config.http.apagadoTimeoutMs + 5000);
    forzar.unref();

    apagando = (async () => {
      const cerrado = new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections();
      const cortarSse = setTimeout(() => server.closeAllConnections(), config.http.apagadoTimeoutMs);
      cortarSse.unref();
      await cerrado;
      clearTimeout(cortarSse);
      await aplicacion.cerrar();
      logger.info('apagado completo');
    })();
    return apagando;
  }

  return { server, puerto: port, apagar, aplicacion };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { apagar } = await arrancar();
    for (const senal of ['SIGTERM', 'SIGINT']) {
      process.once(senal, () => {
        apagar(senal).then(() => process.exit(0), () => process.exit(1));
      });
    }
  } catch (error) {
    // Configuracion invalida: se imprime legible (no un stack) y no se arranca.
    console.error(error instanceof ErrorConfiguracion ? error.message : error);
    process.exit(1);
  }
}
