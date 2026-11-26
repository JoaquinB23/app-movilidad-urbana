// Pruebas E2E (Playwright) del frontend de pasajero y chofer.
//
//   npm run e2e            # levanta API + web contra la base de TEST y corre
//   npx playwright show-report
//
// Usa DATABASE_URL_TEST (nunca la base de desarrollo): el setup global la
// migra, carga el seed y limpia los viajes de los usuarios del seed.

import { existsSync } from 'node:fs';

import { defineConfig, devices } from '@playwright/test';

if (existsSync('.env')) process.loadEnvFile('.env');

const PUERTO_API = Number(process.env.E2E_PUERTO_API ?? 3310);
// Puerto propio (no el 5173 de npm run web:dev): se puede tener la app
// abierta y correr los E2E a la vez.
const PUERTO_WEB = Number(process.env.E2E_PUERTO_WEB ?? 5174);
const API = `http://localhost:${PUERTO_API}`;
const WEB = `http://localhost:${PUERTO_WEB}`;

if (!process.env.DATABASE_URL_TEST) {
  throw new Error('Las pruebas E2E necesitan DATABASE_URL_TEST (ver .env.example).');
}

export default defineConfig({
  testDir: './e2e',
  // Comparten la base y los usuarios del seed: de a una.
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  globalSetup: './e2e/preparar-base.js',
  use: {
    baseURL: WEB,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Playwright arranca los webServer ANTES del globalSetup: con una base
      // nueva (CI) /ready daria 503 por migraciones pendientes. Se migra
      // antes de arrancar, igual que el contenedor de la API.
      command: 'node src/infra/db/migrar.js && node src/servidor.js',
      url: `${API}/ready`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL_TEST,
        PUERTO_HTTP: String(PUERTO_API),
        HOST: '127.0.0.1',
        CORS_ORIGENES: WEB,
        LOG_NIVEL: 'warn',
        // Ofertas cortas para que el E2E de vencimiento no espere 30 s.
        WORKER_VENCIMIENTO_INTERVALO_MS: '500',
      },
    },
    {
      command: `npm --prefix web run dev -- --port ${PUERTO_WEB}`,
      url: WEB,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { ...process.env, VITE_API_BASE: API },
    },
  ],
});
