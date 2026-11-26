// E2E con DOS sesiones a la vez (pasajero y chofer, contextos de navegador
// separados). Evidencia pedida: el pasajero ve cada cambio de estado SIN
// RECARGAR la pagina (llega por el SSE).

import { expect, test } from '@playwright/test';

const API = `http://localhost:${process.env.E2E_PUERTO_API ?? 3310}`;
const PASSWORD = process.env.SEED_PASSWORD;

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
  const contextoPasajero = await browser.newContext();
  const contextoChofer = await browser.newContext();
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

    // El chofer recibe la oferta y la acepta: el pasajero ve "asignado".
    await chofer.getByTestId('btn-aceptar').click();
    await expect(estado).toHaveAttribute('data-estado', 'asignado');
    await testInfo.attach('pasajero-asignado', { body: await pasajero.screenshot(), contentType: 'image/png' });

    await chofer.getByTestId('btn-en-camino').click();
    await expect(estado).toHaveAttribute('data-estado', 'chofer_en_camino');
    await chofer.getByTestId('btn-iniciar').click();
    await expect(estado).toHaveAttribute('data-estado', 'en_curso');
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

  const contextoPasajero = await browser.newContext();
  const contextoChofer = await browser.newContext();
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
