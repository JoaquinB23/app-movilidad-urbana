// Configuracion de ESLint (flat config). La corre `npm run lint` y la CI.
//
// Base: reglas recomendadas de ESLint para Node (ESM). Ademas, una regla que
// hace cumplir la arquitectura hexagonal (bloque 2 del enunciado): ningun
// archivo de src/dominio puede importar Express, el driver de la base ni
// librerias de infraestructura.

import js from '@eslint/js';
import globals from 'globals';

const INFRAESTRUCTURA_PROHIBIDA_EN_DOMINIO = [
  { name: 'express', message: 'El dominio no conoce HTTP: va en src/infra/http.' },
  { name: 'pg', message: 'El dominio no conoce la base: usá un puerto.' },
  { name: 'argon2', message: 'El dominio recibe un puerto hasher.' },
  { name: 'jsonwebtoken', message: 'El dominio recibe un puerto tokens.' },
  { name: 'pino', message: 'El dominio no loguea con infraestructura.' },
  { name: 'zod', message: 'La validacion de entrada HTTP vive en src/infra/http.' },
];

export default [
  {
    ignores: ['node_modules/**', 'coverage/**', 'playwright-report/**', 'test-results/**', 'resultados/**', 'web/dist/**', 'web/node_modules/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // `_algo` marca a proposito un parametro o variable que no se usa.
      // `next` se permite: Express reconoce un handler de errores por tener
      // 4 parametros, aunque no llame a next.
      'no-unused-vars': ['error', { argsIgnorePattern: '^(_|next$)', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['src/dominio/**/*.js'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: INFRAESTRUCTURA_PROHIBIDA_EN_DOMINIO,
        patterns: [{ group: ['**/infra/**'], message: 'El dominio no importa adaptadores: se inyectan.' }],
      }],
    },
  },
  {
    // Frontend React (JSX) y E2E: corren en el navegador o lo manejan.
    files: ['web/**/*.{js,jsx}', 'e2e/**/*.js'],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    // k6 corre su propio runtime (no Node): globals propios.
    files: ['scripts/k6/**/*.js'],
    languageOptions: { globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly' } },
  },
];
