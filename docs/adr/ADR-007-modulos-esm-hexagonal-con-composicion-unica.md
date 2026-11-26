# ADR-007 · Organizar el backend en módulos ESM con dominio hexagonal y una sola composición

**Estado** Implementada.

**Fecha** 26/11/2026. **Participantes** Frente B, responsable de la aplicación, Ubicaciones, Identidad e infraestructura. Pendiente de revisión por el otro integrante.

## Contexto

El enunciado exige arquitectura hexagonal (bloque 2): el dominio no importa Express, el driver de la base ni librerías de infraestructura; cada dependencia externa entra por un puerto con un adaptador real y uno en memoria; un único archivo de composición crea los adaptadores y cambiar real por falso se hace tocando solo ese archivo o una variable de entorno. Además hay que decidir el sistema de módulos de Node.js (CommonJS o ES Modules) y cómo se reparten los archivos entre dos integrantes que trabajan en paralelo sobre módulos distintos (Viajes por un lado; Ubicaciones, Identidad y la aplicación por el otro).

## Opciones consideradas

**Sistema de módulos**

- **CommonJS (`require`).** Es lo que más ejemplos tiene y no exige `"type": "module"`. Pero `require` es sincrónico y no admite `await` en el nivel superior (el arranque necesita esperar a argon2 y a la base), y las librerías nuevas publican primero en ESM. Mezclar ambos sistemas obliga a `import()` dinámico en los bordes.
- **ES Modules (`import`/`export`).** Es el estándar del lenguaje, permite `await` en el nivel superior (lo usan `servidor.js` y los scripts de seed) y los imports son estáticos, lo que deja que ESLint verifique qué importa cada capa. Obliga a escribir las extensiones `.js` en los imports y no tiene `__dirname` (se usa `import.meta.url`).

**Organización del código**

- **Por capa técnica global** (`controllers/`, `services/`, `repositories/`). Es simple de explicar, pero un cambio de Viajes y uno de Ubicaciones tocan las mismas carpetas, los conflictos de merge se multiplican y nada impide que un servicio importe Express.
- **Hexagonal por módulo de negocio.** `src/dominio/<modulo>` con reglas y puertos (sin infraestructura), `src/infra/{db,http,memoria,seguridad}` con adaptadores, y `src/composicion.js` como único punto que los conecta. Cada integrante es dueño de sus carpetas. Cuesta más archivos y una disciplina explícita para no cruzar capas.

## Decisión

ES Modules en todo el proyecto (`"type": "module"`, Node 22) y arquitectura hexagonal por módulo:

- `src/dominio/` (viajes, ubicaciones, identidad, reasignacion): casos de uso y reglas puras que reciben puertos inyectados. Una regla de ESLint (`no-restricted-imports` en `eslint.config.js`) **rechaza** en el dominio cualquier import de `express`, `pg`, `argon2`, `jsonwebtoken`, `pino`, `zod` o de `src/infra/**`; la CI corre `npm run lint`, así que la regla se cumple en cada PR y no depende de la memoria de nadie.
- `src/infra/`: adaptadores reales (PostgreSQL, Express, argon2, JWT) y en memoria (`src/infra/memoria/`) para los tests de dominio.
- `src/composicion.js`: único lugar que construye adaptadores. Las versiones real e ingenua se eligen con `GEO_ESTRATEGIA` y `HISTORIAL_MODO`, sin tocar código. Devuelve la app y los workers **sin arrancarlos**: escuchar, iniciar timers y apagar es responsabilidad de `src/servidor.js`, por eso los tests componen la aplicación real sin timers en segundo plano.
- `src/config/index.js`: único lector de `process.env` para la aplicación; valida con zod al arrancar y sale con código distinto de cero nombrando la variable inválida.
- Archivos compartidos (`composicion.js`, `servidor.js`, `package.json`, `.env.example`) con secciones por módulo marcadas con comentarios.

## Consecuencias

- Los tests de dominio corren sin base ni HTTP (`tests/dominio/`), usando los adaptadores en memoria.
- Un error de cableado aparece al arrancar y no en medio de un pedido: las rutas y casos de uso exigen sus puertos en el constructor y `combinarMapeosHttp` impide arrancar si dos módulos traducen el mismo código de error a status distintos.
- Hay más archivos y más indirección que en una aplicación por capas; para seguir un pedido hay que pasar por la composición.
- Todos los imports llevan extensión `.js` y los scripts usan `import.meta.url` para ubicar archivos.

## Qué nos haría cambiar de decisión

Si una dependencia imprescindible solo existiera en CommonJS y no funcionara con `import`, la aislaríamos en un adaptador con `createRequire` antes que migrar el proyecto. Si la cantidad de módulos creciera al punto de que `composicion.js` sea inmanejable, lo dividiríamos en una función de composición por módulo, manteniendo un único punto de entrada que las combine.
