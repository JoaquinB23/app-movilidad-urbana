# AGENTS.md — Plataforma de viajes (TP Final Programación IV, UTN FRRe)

Este archivo le da contexto y procedimientos reutilizables ("skills") al asistente de código.
El enunciado está en `docs/enunciado.md`. Ante cualquier duda, manda el enunciado.

---

## 1. Contexto del proyecto

- Backend de una plataforma de viajes: pasajeros piden viajes y el sistema los asigna a choferes.
- Comisión 1, grupo 8. Variante obligatoria: **H, reasignación ante fallas**.
- Stack: Node.js 22, Express, PostgreSQL + PostGIS (Docker Compose), `node:test`.
- Módulos del equipo:
  - **Ubicaciones** (recepción masiva de ubicaciones, búsqueda de cercanos, historial, retención, tarea pesada 6.6).
  - **Viajes** (solicitud, ofertas, `aceptarOferta` con bloqueo ordenado).
  - **Identidad, administración y reasignación** (auth, roles, variante H).
- Cada integrante es dueño de su módulo. No se editan archivos de otro módulo sin avisar.

## 2. Reglas duras (no negociables)

1. **Hexagonal**: nada en `src/dominio/` importa Express, el driver de la base ni librerías de infraestructura.
2. **Puertos con dos adaptadores**: cada puerto tiene adaptador real y adaptador en memoria para tests.
3. **Un único archivo de composición** (`src/composicion.js`) crea y inyecta adaptadores.
4. **SQL siempre parametrizado** (`$1`, `$2`…). Nunca interpolar valores en el SQL.
5. **Schema real del equipo**: IDs UUID, nombres de tablas y columnas tal como están en `migraciones/`. Antes de escribir SQL, leer las migraciones.
6. **Autorización por recurso en el servidor**: no alcanza con verificar el token.
7. **Los tests verifican el dato final**, no solo que no hubo error.
8. **Sin secretos en el repo**. Todo valor de conexión viene de variables de entorno y figura en `.env.example`.
9. **Sin commit ni push sin confirmación explícita** del usuario.
10. **No inventar números**: toda cifra de `docs/mediciones.md` sale de una corrida real con comando reproducible.

## 3. Archivos compartidos

`src/composicion.js`, `src/servidor.js`, `package.json`, `.env.example`, `docs/api.md` y `docs/ataque.md` los tocan varias personas.
Antes de editarlos: **mostrar el diff propuesto y esperar OK**, para coordinar con el resto del equipo.
Editar solo la sección del propio módulo, marcada con comentarios.

## 4. Comandos útiles

```bash
# migrar una base limpia
node src/infra/db/migrar.js

# suite completa (las pruebas comparten base, por eso concurrencia 1)
node --test --test-concurrency=1

# un archivo puntual
node --test tests/dominio/servicios-ubicaciones.test.js
```

Variables necesarias para los tests de integración y concurrencia: `DATABASE_URL` y `DATABASE_URL_TEST`,
apuntando a bases distintas del contenedor `movilidad-db` (puerto 5439 en esta máquina).
Sin `DATABASE_URL_TEST`, esos tests lanzan error al importar.

## 5. Estructura

```
src/dominio/            reglas de negocio y puertos (sin infraestructura)
src/infra/http/         Express: rutas, middlewares, traducción de errores
src/infra/db/           adaptadores PostgreSQL, migrador
src/infra/memoria/      adaptadores en memoria para tests
src/workers/            procesos en segundo plano
src/composicion.js      único lugar que crea e inyecta adaptadores
tests/dominio|integracion|seguridad|concurrencia/
migraciones/            SQL numerado (001, 101..104, 200, 300, ...)
docs/                   ADR, mediciones, modelo, guías de defensa
```

---

## 6. Skills

Cada skill es un procedimiento. Seguirlo en orden cuando la tarea coincide con su disparador.

### Skill: revisar un pull
**Cuándo**: el usuario hizo `git pull` y quiere saber qué entró.
1. Listar commits y autores desde el último commit local.
2. Listar archivos agregados, modificados y borrados.
3. Detectar cambios de schema: migraciones nuevas, tablas renombradas, FKs, numeración repetida.
4. Detectar cambios de contrato en puertos y composición.
5. Buscar choques con el módulo del usuario (tablas, columnas, funciones que use).
6. Correr migraciones sobre una base limpia y la suite completa.
7. Resumir en lista corta: qué cambió, qué afecta, qué riesgos. **Solo lectura**: no modificar nada.

### Skill: implementar un paso del plan
**Cuándo**: se aprobó un paso numerado.
1. Decir qué archivos se van a tocar.
2. Escribir primero el test que falla, después el código.
3. Correr los tests del archivo tocado y luego la suite completa.
4. Mostrar el diff y **frenar**. No pasar al paso siguiente ni commitear sin OK.
5. Cerrar con las decisiones tomadas, redactadas para defenderlas oralmente.

### Skill: explicar para la defensa oral
**Cuándo**: siempre, al terminar un paso o tomar una decisión.
La defensa es individual, no se puede consultar IA y el docente introduce fallas en el código. Por cada decisión:
- Qué se decidió y qué alternativa se descartó.
- Qué pasaría si se quitara (predicción concreta: qué dato queda mal).
- En qué línea o archivo vive.
- Una pregunta de práctica que el docente podría hacer.
Preferir explicaciones en texto plano, sin diagramas, salvo pedido explícito.

### Skill: escribir un ADR
**Cuándo**: hay una decisión técnica no trivial.
Archivo numerado en `docs/adr/`. Formato obligatorio:
Título (nombra la decisión, no el tema) · Estado · Fecha y participantes · Contexto · Opciones consideradas (mínimo dos, con ventajas y desventajas reales) · Decisión · Consecuencias · Qué nos haría cambiar de decisión.
Un ADR sin alternativas descartadas no cuenta. No inventar desventajas para llenar el formato.

### Skill: test de concurrencia
**Cuándo**: hay una operación con riesgo de condición de carrera.
1. Identificar el recurso compartido y el invariante (ej.: exactamente un ganador).
2. Disparar **50 o más** operaciones simultáneas con `Promise.all`.
3. Verificar el **estado final en la base**: contar filas y estados, no solo códigos de respuesta.
4. Verificar que los perdedores reciben un rechazo claro y definido.
5. Antes de correr: predecir en voz alta qué pasaría sin el bloqueo o la transacción.

### Skill: medir (docs/mediciones.md)
**Cuándo**: se compara versión ingenua vs final.
1. Escribir la **hipótesis con número antes** de correr nada. No editarla después.
2. Registrar entorno: CPU, RAM, SO, versión de Node, versión de la base, Docker, qué más corría.
3. Dejar la base en estado conocido y el mismo volumen en ambas corridas.
4. Línea de base sin la tarea pesada, **al menos 30 s** de carga sostenida.
5. Repetir **3 veces** cada escenario (ingenua y final) y registrar las tres.
6. Tabla con unidades: p50, p95, p99, req/s, lag del event loop (máximo y p99, con `monitorEventLoopDelay`), memoria.
7. Comando exacto, copiable y ejecutable tal cual.
8. Conclusión honesta. Si la hipótesis falló, documentarlo igual.

### Skill: test de autorización por recurso
**Cuándo**: un endpoint devuelve o modifica datos de un recurso con dueño.
1. Crear dos usuarios del mismo rol y un recurso del primero.
2. Pedir el recurso con el token del segundo, cambiando el identificador en la URL.
3. Esperar 403 o 404, nunca el recurso. Verificar que el error no revela si el recurso existe.
4. Probar también con rol distinto y sin token.

### Skill: tocar un archivo compartido
**Cuándo**: hay que editar `composicion.js`, `servidor.js`, `package.json` o `.env.example`.
1. No editar todavía. Mostrar el diff propuesto.
2. Limitarlo a la sección del propio módulo.
3. Esperar OK del usuario, que avisa al resto del equipo.

---

## 7. Estilo

- Respuestas en español rioplatense, directas y sin relleno.
- Código y comentarios en el idioma ya usado en el repo.
- No usar el nombre del usuario en ejemplos de código.
- Si falta un dato (enunciado, variable, decisión del equipo), preguntarlo en vez de suponerlo.
