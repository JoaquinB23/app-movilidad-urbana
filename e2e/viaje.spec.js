// E2E con DOS sesiones a la vez (pasajero y chofer, contextos de navegador
// separados). Evidencia pedida: el pasajero ve cada cambio de estado SIN
// RECARGAR la pagina (llega por el SSE).

import { expect, test } from '@playwright/test';

const API = `http://localhost:${process.env.E2E_PUERTO_API ?? 3310}`;
const PASSWORD = process.env.SEED_PASSWORD;

// Los mapas de OpenStreetMap se descargan de internet: en las pruebas se
// bloquean para no depender de un servidor externo (el mapa se ve gris pero
// funciona igual: los clicks y marcadores no necesitan las imagenes).
async function nuevoContexto(browser) {
  const contexto = await browser.newContext();
  await contexto.route(/tile\.openstreetmap\.org/, (ruta) => ruta.abort());
  return contexto;
}

async function entrar(page, email) {
  await page.goto('/');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-entrar').click();
  await expect(page.getByTestId('rol')).toBeVisible();
}

// Marca la pagina: si algo la recargara, la marca desaparece.
async function marcarSinRecarga(page) {
  await page.evaluate(() => { window.__sinRecargar = true; });
}
async function seguiaSinRecargar(page) {
  return page.evaluate(() => window.__sinRecargar === true);
}

async function tokenDe(request, email) {
  const res = await request.post(`${API}/auth/login`, { data: { email, password: PASSWORD } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).token;
}

test('viaje completo con dos sesiones: el pasajero ve cada estado sin recargar y paga', async ({ browser }, testInfo) => {
  const contextoPasajero = await nuevoContexto(browser);
  const contextoChofer = await nuevoContexto(browser);
  const pasajero = await contextoPasajero.newPage();
  const chofer = await contextoChofer.newPage();

  try {
    // Chofer disponible y reportando ubicacion.
    await entrar(chofer, 'chofer1@movilidad.invalid');
    await chofer.getByTestId('toggle-disponible').click();
    await expect(chofer.getByTestId('envios-ubicacion')).toContainText('1 ubicaciones enviadas');

    // Pasajero estima y pide.
    await entrar(pasajero, 'pasajero1@movilidad.invalid');
    await marcarSinRecarga(pasajero);
    await pasajero.getByTestId('btn-estimar').click();
    await expect(pasajero.getByTestId('precio-estimado')).toBeVisible();
    await pasajero.getByTestId('btn-pedir').click();
    const estado = pasajero.getByTestId('estado-viaje');
    await expect(estado).toHaveAttribute('data-estado', 'solicitado');

    // El chofer ve la oferta con donde es el viaje: distancia al pasajero y,
    // en su mapa, A (buscarlo) y B (dejarlo). Despues la acepta.
    await expect(chofer.getByTestId('oferta-retiro')).toContainText('Pasajero a');
    await expect(chofer.locator('.pin-origen')).toBeVisible();
    await expect(chofer.locator('.pin-destino')).toBeVisible();
    await chofer.getByTestId('btn-aceptar').click();
    await expect(chofer.getByTestId('indicacion-chofer')).toContainText('Buscá al pasajero en A');
    await expect(estado).toHaveAttribute('data-estado', 'asignado');
    await testInfo.attach('pasajero-asignado', { body: await pasajero.screenshot(), contentType: 'image/png' });

    await chofer.getByTestId('btn-en-camino').click();
    await expect(estado).toHaveAttribute('data-estado', 'chofer_en_camino');
    await chofer.getByTestId('btn-iniciar').click();
    await expect(estado).toHaveAttribute('data-estado', 'en_curso');
    await expect(chofer.getByTestId('indicacion-chofer')).toContainText('Llevá al pasajero a B');
    await chofer.getByTestId('btn-finalizar').click();
    await expect(estado).toHaveAttribute('data-estado', 'finalizado');
    await expect(chofer.getByTestId('tarifa-final-chofer')).toBeVisible();

    // Paga: el cobro se aprueba con la tarifa final.
    await expect(pasajero.getByTestId('tarifa-final')).not.toHaveText('—');
    await pasajero.getByTestId('btn-pagar').click();
    await expect(pasajero.getByTestId('cobro-ok')).toBeVisible();
    await testInfo.attach('pasajero-finalizado-y-pagado', { body: await pasajero.screenshot(), contentType: 'image/png' });

    // Evidencia: todos los cambios llegaron sin recargar la pagina.
    expect(await seguiaSinRecargar(pasajero)).toBe(true);

    await chofer.getByTestId('toggle-disponible').click();
  } finally {
    await contextoPasajero.close();
    await contextoChofer.close();
  }
});

test('la oferta vence aunque el chofer haya cerrado la app: el pasajero ve "sin choferes"', async ({ browser, request }) => {
  const admin = await tokenDe(request, 'admin1@movilidad.invalid');
  const tiempo = (valor) => request.put(`${API}/admin/parametros`, {
    headers: { authorization: `Bearer ${admin}` }, data: { tiempo_limite_oferta_s: valor },
  });
  expect((await tiempo(3)).ok()).toBeTruthy();

  const contextoPasajero = await nuevoContexto(browser);
  const contextoChofer = await nuevoContexto(browser);
  const pasajero = await contextoPasajero.newPage();
  const chofer = await contextoChofer.newPage();
  try {
    // El chofer se pone disponible, reporta y CIERRA la app.
    await entrar(chofer, 'chofer1@movilidad.invalid');
    await chofer.getByTestId('toggle-disponible').click();
    await expect(chofer.getByTestId('envios-ubicacion')).toContainText('1 ubicaciones enviadas');
    await contextoChofer.close();

    await entrar(pasajero, 'pasajero1@movilidad.invalid');
    await marcarSinRecarga(pasajero);
    await pasajero.getByTestId('btn-pedir').click();
    const estado = pasajero.getByTestId('estado-viaje');
    await expect(estado).toHaveAttribute('data-estado', 'solicitado');

    // Nadie responde: el servidor vence la oferta y, sin otro candidato,
    // el viaje pasa a "sin choferes". El pasajero lo ve sin recargar.
    await expect(estado).toHaveAttribute('data-estado', 'sin_choferes', { timeout: 20_000 });
    expect(await seguiaSinRecargar(pasajero)).toBe(true);

    // En el historial dice que no se encontro chofer y NO muestra un importe.
    const fila = pasajero.getByTestId('historial').locator('li').first();
    await expect(fila).toContainText('No se encontró chofer');
    await expect(fila).not.toContainText('$');
  } finally {
    await tiempo(30);
    await contextoPasajero.close();
    // El chofer quedo disponible al cerrar la app: se lo apaga por la API.
    const tokenChofer = await tokenDe(request, 'chofer1@movilidad.invalid');
    await request.put(`${API}/choferes/me/disponibilidad`, {
      headers: { authorization: `Bearer ${tokenChofer}` }, data: { disponible: false },
    });
  }
});

test('el pasajero marca origen y destino tocando el mapa', async ({ browser }) => {
  const contexto = await nuevoContexto(browser);
  const pasajero = await contexto.newPage();
  try {
    await entrar(pasajero, 'pasajero2@movilidad.invalid');
    const mapa = pasajero.getByTestId('mapa');
    const latOrigen = pasajero.getByTestId('origen-lat');
    const latDestino = pasajero.getByTestId('destino-lat');
    const origenAntes = await latOrigen.inputValue();
    const destinoAntes = await latDestino.inputValue();

    // Primer toque: origen (y el selector pasa solo a destino).
    await mapa.click({ position: { x: 60, y: 60 } });
    await expect(latOrigen).not.toHaveValue(origenAntes);
    await expect(pasajero.getByTestId('marcar-destino')).toHaveAttribute('aria-pressed', 'true');

    // Segundo toque: destino, en otro lugar del mapa.
    const box = await mapa.boundingBox();
    await mapa.click({ position: { x: box.width - 60, y: box.height - 60 } });
    await expect(latDestino).not.toHaveValue(destinoAntes);
    // Arriba en el mapa = mas al norte = latitud mayor (menos negativa).
    expect(Number(await latOrigen.inputValue())).toBeGreaterThan(Number(await latDestino.inputValue()));

    // Con los puntos del mapa se estima normalmente.
    await pasajero.getByTestId('btn-estimar').click();
    await expect(pasajero.getByTestId('precio-estimado')).toBeVisible();
  } finally {
    await contexto.close();
  }
});

test('busqueda continua (prendida por el admin): el viaje espera y se asigna cuando aparece un chofer', async ({ browser, request }) => {
  const admin = await tokenDe(request, 'admin1@movilidad.invalid');
  const busqueda = (segundos) => request.put(`${API}/admin/parametros`, {
    headers: { authorization: `Bearer ${admin}` }, data: { tiempo_busqueda_s: segundos },
  });
  expect((await busqueda(120)).ok()).toBeTruthy();

  const contextoPasajero = await nuevoContexto(browser);
  const contextoChofer = await nuevoContexto(browser);
  const pasajero = await contextoPasajero.newPage();
  const chofer = await contextoChofer.newPage();
  try {
    // No hay ningun chofer disponible: el viaje queda buscando (no "sin choferes").
    await entrar(pasajero, 'pasajero1@movilidad.invalid');
    await marcarSinRecarga(pasajero);
    await pasajero.getByTestId('btn-pedir').click();
    const estado = pasajero.getByTestId('estado-viaje');
    await expect(estado).toHaveAttribute('data-estado', 'solicitado');
    await pasajero.waitForTimeout(3000);
    await expect(estado).toHaveAttribute('data-estado', 'solicitado');

    // Recien ahora se conecta un chofer: el worker le ofrece el viaje.
    await entrar(chofer, 'chofer1@movilidad.invalid');
    await chofer.getByTestId('toggle-disponible').click();
    await chofer.getByTestId('btn-aceptar').click({ timeout: 15_000 });
    await expect(estado).toHaveAttribute('data-estado', 'asignado');
    expect(await seguiaSinRecargar(pasajero)).toBe(true);

    // Se cierra el viaje para no dejar al chofer ocupado.
    await pasajero.getByTestId('btn-cancelar').click();
    await expect(estado).toHaveAttribute('data-estado', 'cancelado_pasajero');
    await chofer.getByTestId('toggle-disponible').click();
  } finally {
    await busqueda(0);
    await contextoPasajero.close();
    await contextoChofer.close();
  }
});
