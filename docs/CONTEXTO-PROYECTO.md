# CONTEXTO DEL PROYECTO: Plataforma de viajes tipo Uber

Documento para agentes de código (Claude Code u otros). Leelo completo antes de tocar nada. Reúne los requisitos de dos materias que se evalúan sobre el mismo repositorio, las decisiones de arquitectura acordadas, el reparto de trabajo y los puntos a revisar. Lo que está escrito en los enunciados es contrato: lo que no está, no se exige.

Última actualización de este documento: 26/11/2026.

---

## 0. Reglas de trabajo para el agente

1. Idioma: todo en español (código de dominio, comentarios, mensajes, docs, commits), salvo nombres técnicos estándar.
2. Entorno del equipo: Windows con PowerShell, Docker Desktop, Node.js 22 LTS (nvm-windows). Los comandos que propongas tienen que funcionar en PowerShell (sin `grep`, sin `&&` encadenado como en bash, `Select-String` no tiene `-Recurse`: usá `Get-ChildItem -Recurse | Select-String`).
3. Antes de modificar: leé el código existente de la zona y resumí cómo está hoy. No asumas que algo existe o no existe: verificalo.
4. Alcance: hacé solo la tarea pedida. No toques módulos de otros frentes (ver sección 12) salvo para montarlos o corregir un contrato acordado, y avisá.
5. No hagas commits ni cambies de rama salvo que te lo pidan. Una rama y un PR por tarea.
6. Docker: usá únicamente el contenedor y la base de ESTE proyecto (`movilidad-db`, bases `movilidad` y `movilidad_test`). No crees, borres ni reinicies contenedores o volúmenes de otros proyectos. No ejecutes `docker rm`, `docker volume rm` ni `docker compose down -v` salvo que lo pidan explícitamente.
7. Secretos: nunca los escribas en el repo ni en el historial (claves, tokens, `.env` reales). Si encontrás uno, informá solo archivo y línea, nunca el valor. Los tokens de Grafana, claves JWT y contraseñas van solo en `.env` local o en secrets de GitHub. `.env.example` lleva solo valores de ejemplo.
8. Si un comando falla más de dos veces con el mismo error, detenete, explicá el problema y no sigas probando variantes. No copies `node_modules` de otra carpeta. No instales dependencias globales sin avisar.
9. No inventes: si no encontraste algo, decí "no encontrado". Para cada afirmación sobre el estado del repo, citá archivo, test o salida de comando.
10. El equipo tiene que poder defender cada línea en una defensa oral individual (sin IA ni internet). Por eso: código simple y legible, comentarios breves que expliquen decisiones (por qué), y al terminar un resumen de decisiones tomadas y alternativas descartadas.
11. Tests: toda funcionalidad nueva lleva tests. Un test concurrente verifica el dato final, no solo la ausencia de error. Los tests de integración usan solo `DATABASE_URL_TEST` y se niegan a correr si es igual a `DATABASE_URL`.
12. Nunca uses el tipo `number` de JavaScript para dinero: centavos enteros.
13. Prohibido: NestJS/AdonisJS o frameworks que impongan estructura, ORM (decisión acordada: SQL directo con `pg`), persistir en archivos JSON o en memoria, mezclar CommonJS y ESM, stack traces o mensajes crudos de la base hacia el cliente, consultas SQL por concatenación, listas negras de nombres como defensa de prototype pollution, abrir CORS a `*`.

---

## 1. Qué es el proyecto

Backend (más un frontend mínimo) de una plataforma de viajes: un pasajero pide un viaje desde su ubicación a un destino, el sistema busca choferes disponibles cercanos, les ofrece el viaje con un tiempo límite de aceptación, el primero que acepta lo toma, el viaje avanza por estados hasta completarse, y pasajero y chofer ven el estado en tiempo real.

Se evalúa en dos materias sobre el mismo repositorio:

- **Programación IV (UTN FRRe, ciclo 2026, segundo cuatrimestre), TP Final Integrador**: "Backend en Node.js: concurrencia, seguridad y arquitectura". Enunciado versión 1.0 del 23/09/2026 (secciones 1 a 11, resumidas abajo; es el contrato principal).
- **Criterios adicionales "TP Integrador, Backend-Jueves"** (otra materia, mismos entregables): 3 temas de exposiciones, framework frontend, E2E con Playwright, CI con análisis estático, k6, Grafana Cloud (sección 11).

Grupo: **grupo 8 de la comisión de la plataforma de viajes**, 3 integrantes (Bordon Joaquin, Pibernus Santiago, Maza Bruno). **Variante obligatoria: H, "Reasignación ante fallas"**. Joaquin lidera el proyecto y toma el frente A. Los frentes B y C los toman los otros dos integrantes (confirmar quién es quién con el equipo). Por ser grupo de tres no corresponde reducción de alcance.

Nota sobre el enunciado: la portada llama "Comisión 2" a la plataforma de viajes y "Comisión 1" a proyectos por grupo, y las secciones 5 y 6 los nombran al revés. Lo relevante: nuestra comisión desarrolla la plataforma de viajes (sección 6 del enunciado) y nuestro grupo es el 8.

Fase de ataque cruzado: el grupo 8 ataca al grupo 1 (variante A, precio dinámico) y es atacado por el grupo 7 (variante G, flotas y zonas). Ver sección 8.

Sistema de un solo repositorio Git privado, un solo sistema. **No se pide microservicios**: la arquitectura acordada es un monolito modular con arquitectura hexagonal (ver sección 12).

---

## 2. Reglas generales de Programación IV

### 2.1 Evaluación
- Nota final individual: entrega grupal (sistema y requisitos) 40 %, artefactos de proceso 20 %, defensa oral individual 40 %. Se aprueba con 6 o más y la defensa requiere 6 o más por sí sola.
- Un bloque de requisitos comunes ausente por completo limita la nota de la entrega grupal a 5. Un sistema que solo expone CRUD sin resolver los problemas de la sección 4 obtiene la nota mínima.
- Se puede usar IA para programar; no se puede delegar el entender (defensa individual, falla introducida en el código, artefactos con decisiones y números propios, ataque cruzado en vivo).

Rúbrica de la entrega grupal (40 %):

| Criterio | Peso | Qué se mira |
|---|---|---|
| Problema central del proyecto | 30 % | Resuelto, con tests, demostrado funcionando |
| Seguridad | 20 % | Bloque 5 completo, tests de autorización por recurso, resultado de los ataques recibidos |
| Concurrencia e idempotencia | 20 % | Bloque 6: carreras identificadas, resueltas y verificadas con tests concurrentes |
| Arquitectura y configuración | 15 % | Bloques 2 y 3: dominio aislado, puertos con doble adaptador, arranque y apagado correctos |
| Tests, documentación y reproducibilidad | 15 % | Bloques 1, 4 y 8: la secuencia de 2.4 funciona, los tests pasan, los logs sirven |

Rúbrica de artefactos de proceso (20 %): ADR con alternativas reales 30 %; informe de medición 30 %; fase de ataque cruzado 30 %; historial de Git y controles 10 %.

### 2.2 Tecnología obligatoria

| Ítem | Exigencia |
|---|---|
| Runtime | Node.js 22 LTS; declarar en `package.json` el campo `engines` |
| HTTP | Express (no NestJS, AdonisJS ni similares) |
| Base de datos | Relacional, se recomienda PostgreSQL. Redis u otro para cache o colas solo con justificación. No se acepta persistir en archivos JSON ni en memoria |
| Acceso a datos | Libre (SQL directo, query builder u ORM), justificado en un ADR; hay que poder mostrar el SQL que se ejecuta |
| Lenguaje | JavaScript o TypeScript (TS no suma nota por sí mismo; no reemplaza validación en runtime) |
| Contenedores | Docker y Docker Compose: la base y todo servicio auxiliar levantan con un solo comando |
| Módulos | CommonJS o ESM a elección, justificado en un ADR; no mezclar sin explicar |

### 2.3 Repositorio y entrega
- Un único repositorio Git privado, con la cátedra como colaboradora desde el primer control. La entrega es el repo en la fecha límite (no zip por correo ni carpetas compartidas).
- Un commit con tag `entrega-final` marca el estado que se corrige; lo posterior no se mira.
- Todos los integrantes tienen commits propios a lo largo del cuatrimestre (cada uno con su `git config user.name/user.email` y su cuenta). Dos commits enormes la última semana pierde puntos.
- El trabajo se integra mediante pull requests revisados por al menos otro integrante, con comentarios reales (no solo aprobación).
- No se suben secretos reales (claves, contraseñas, `.env` verdaderos), ni `node_modules`, ni volcados de base con datos personales reales. Sí se sube `.env.example` con todas las variables y valores de ejemplo.

### 2.4 Qué pasa cuando la cátedra clona el repo (si falla, no se aprueba)
1. Copiar `.env.example` a `.env` y ajustar, como máximo, valores obvios.
2. `docker compose up`.
3. Un comando de preparación que crea el esquema y carga datos de prueba (por ejemplo `npm run setup`).
4. Un comando único de tests (`npm test`), que pasen.
5. Levantar el servidor y ejecutar la colección de requests de la demo.

Debe funcionar sin intervención ni preguntas, en una máquina que nunca vio el proyecto.

### 2.5 Documentación mínima del repo
- `README.md`: qué hace el sistema en cinco líneas; comandos exactos de la secuencia anterior; roles y usuarios de prueba con credenciales; índice de la carpeta `docs`.
- `docs/adr/`: decisiones de arquitectura (sección 7).
- `docs/mediciones.md`: informe de medición.
- `docs/ataque.md`: bitácora de ataque y respuestas a hallazgos.
- `docs/modelo.md`: modelo de dominio (entidades, invariantes, estados) con diagrama.
- `docs/api.md`: OpenAPI o endpoints con códigos de respuesta y errores posibles.

### 2.6 Fuera de alcance de Programación IV
Frontend (opcional y no suma nota ahí; para la demo alcanza una colección de requests: Bruno, Insomnia, Postman o `.http`), despliegue en nube paga (alcanza Docker Compose en una máquina accesible durante la semana de ataque), app móvil, entrenamiento de modelos de IA. (El frontend sí es obligatorio por los criterios adicionales de la sección 11.)

### 2.7 Condiciones que desaprueban el TP, sin compensación
1. El sistema no levanta siguiendo el README desde un clon limpio (secuencia 2.4).
2. Hay secretos reales versionados en el repo o en su historial.
3. Un integrante no puede explicar código que figura a su nombre en el historial de Git.
4. Falta por completo alguno de los ocho bloques de la sección 4.
5. No se realizó la fase de ataque cruzado (ni como atacante ni como defensor).
6. Se incumplió alguna regla de la sección 8.3 (ataque).

### 2.8 Cronograma de controles (sin nota propia; un control salteado descuenta del 10 % de historial)
Las semanas se cuentan desde la publicación del enunciado (23/09/2026). Las fechas exactas las publica la cátedra en el aula virtual (si difieren, vale la publicada). Estimación de fechas calendario por si no se consultaron:

| Control | Semana | Estimación | Qué se muestra |
|---|---|---|---|
| 1. Diseño | 2 | ~30/09 | Repo con la cátedra como colaboradora, modelo de dominio, puertos, ADR de módulos y persistencia |
| 2. Núcleo | 5 | ~21/10 | Flujos principales, tests de dominio sin base, auth y autorización por recurso, configuración validada |
| 3. Problema difícil | 8 | ~11/11 | Carrera principal resuelta con test concurrente; tarea pesada en dos versiones con primera medición |
| 4. Congelamiento | 10 | ~25/11 | Sistema desplegado, accesible y congelado; usuarios de prueba y documentación de la API publicados para el grupo atacante |
| 5. Ataque cruzado | 11 | ~02/12 | Bitácora del atacante entregada; el defensor recibe hallazgos y corrige |
| 6. Entrega final | 12 | ~09/12 | Correcciones con tests, informe de medición completo, todos los ADR, tag `entrega-final` |
| 7. Defensa oral | 13 | ~16/12 | Defensa individual en grupo |

Verificar las fechas reales con el equipo y la cátedra; el calendario está apretado.

---

## 3. Conceptos que se evalúan (definiciones del enunciado)

- **Condición de carrera**: dos o más operaciones sobre el mismo dato cuyo resultado depende del orden en que se intercalen (leer, decidir, escribir). Node es de un solo hilo pero igual ocurre: entre dos `await` el event loop atiende otro pedido; la carrera está en la base y en la lógica de negocio. Formas aceptadas de resolverla: transacción con aislamiento adecuado, bloqueo explícito de fila (`SELECT ... FOR UPDATE`), restricción de base que haga imposible el estado inválido (CHECK, único), o control optimista con número de versión. Se evalúa que el grupo sepa cuál eligió, por qué y qué pasa cuando dos pedidos chocan.
- **Idempotencia**: ejecutar varias veces con los mismos datos da el mismo resultado que una vez. Mecanismo exigido: el cliente envía el encabezado `Idempotency-Key` (único por intención); el servidor guarda la clave con el resultado; si llega la misma clave, devuelve el resultado guardado sin volver a ejecutar. Se demuestra con un test que envía la misma petición dos veces y verifica que el efecto ocurrió una vez.
- **Event loop, bloqueo y lag**: una tarea sincrónica pesada frena a todos los usuarios. El lag se mide con `monitorEventLoopDelay` de `perf_hooks`. Salidas posibles frente a una tarea pesada: chunking, streams, worker threads, o sacarla del pedido HTTP a una cola. Todas válidas, el grupo elige y justifica.
- **Arquitectura hexagonal**: el dominio (reglas) no conoce Express, el driver de la base ni servicios externos. Puerto: interfaz definida por el dominio en términos del dominio (sin SQL ni HTTP). Adaptador: implementación concreta (PostgreSQL, en memoria para tests). Composición: único archivo que crea adaptadores concretos y los inyecta. Prueba práctica: se puede correr toda la lógica en un test sin Express ni base, y cambiar un adaptador tocando solo el archivo de composición.
- **ADR**: registro corto de una decisión técnica, las opciones consideradas y por qué se eligió una. Escrito cuando se decide.
- **Percentiles**: se informa siempre p50, p95 y p99, nunca solo el promedio.
- **Fallar cerrado**: si un servicio del que depende una decisión de seguridad, cobro o control de acceso no responde, se niega la operación y se registra.

---

## 4. Los ocho bloques de requisitos comunes (obligatorios)

### Bloque 1: Proyecto, dependencias y arranque
Proyecto que arranca en máquina limpia siguiendo el README, con Node 22, Express y Docker Compose. Archivo de bloqueo (`package-lock.json`) versionado. Scripts npm para: arrancar en desarrollo, arrancar en producción, preparar la base, cargar datos de prueba, correr tests, correr el linter. Defensa: diferencia entre dependencias de desarrollo y producción, por qué `^` puede cambiar entre dos instalaciones.

### Bloque 2: Arquitectura hexagonal
- Ningún archivo del dominio importa Express, el driver de la base ni librerías de infraestructura (se verifica leyendo imports).
- Cada dependencia externa (base de datos, servicio de IA, mapas, correo, pagos, almacenamiento) entra por un puerto con al menos dos adaptadores: el real y uno falso o en memoria para tests.
- Un único archivo de composición crea los adaptadores y los inyecta. Cambiar real por falso se hace tocando solo ese archivo o una variable de entorno.
- Demostración: tests de dominio sin base ni HTTP; en la defensa se pide cambiar el adaptador de notificaciones por uno que escriba en un archivo (pocas líneas, un solo lugar).

### Bloque 3: Configuración y ciclo de vida
1. Toda la configuración viene de variables de entorno; ningún valor de conexión, clave ni URL en el código.
2. Las variables se validan al arrancar con un esquema; si falta o es inválida una, el proceso imprime exactamente cuál y termina con código distinto de cero (no arranca a medias).
3. Dos endpoints separados: `/health` (el proceso está vivo) y `/ready` (puede atender de verdad: conexión a la base y migraciones aplicadas). No responden lo mismo.
4. Apagado ordenado con `SIGTERM`: deja de aceptar conexiones nuevas, termina las en curso, cierra conexiones a la base y sale; si tarda más de un tiempo límite definido por el grupo, sale igual y lo registra.
Demostración: borrar una variable y mostrar el mensaje; mandar SIGTERM durante un pedido lento y mostrar en el log que el pedido terminó antes de salir.

### Bloque 4: Manejo de errores y observabilidad
- Un único middleware de errores al final de la cadena. Ningún handler asincrónico deja una promesa rechazada sin capturar (una sola solución consistente: envoltorio, o mecanismo de Express 5).
- Errores de dominio se traducen a HTTP en la capa web, no en el dominio.
- Formato único y documentado de error, con identificador de correlación; nunca incluye stack trace ni el mensaje crudo de la base.
- Logs estructurados JSON, con identificador de pedido propagado con `AsyncLocalStorage` (no pasado de función en función). El log de un pedido y el de su error se encuentran por ese identificador.
- Demostración: provocar un error y mostrar la respuesta al cliente (sin detalles internos), la línea de log JSON y la búsqueda por id. Defensa: por qué AsyncLocalStorage funciona a través de operaciones asincrónicas y una variable global no.

### Bloque 5: Seguridad (todo verificable)
- Autenticación por JWT o sesiones (elección justificada). Contraseñas con argon2 o bcrypt con factor de costo declarado; nunca texto plano ni MD5/SHA sin derivación.
- Autorización por recurso, siempre en el servidor: pedir un recurso ajeno cambiando el id en la URL devuelve 403 o 404, nunca el recurso. Test automatizado.
- Autorización por rol: al menos tres roles con permisos distintos, definidos en una tabla del README; la verificación no está en el frontend.
- Validación de toda entrada (cuerpo, parámetros de ruta, query string, encabezados relevantes) con esquema (zod, ajv u otra); los campos no declarados se rechazan explícitamente.
- Prototype pollution: test que envía cuerpos con `__proto__` y `constructor.prototype` en distintas posiciones y verifica que el objeto global no se contamina y que el pedido se rechaza. La defensa no puede ser una lista negra de nombres.
- Inyección SQL: todas las consultas parametrizadas; test con una carga de inyección típica en un campo de búsqueda.
- Límite de tasa: en el login y en los endpoints costosos, con 429 y encabezados informativos; test o demostración.
- Encabezados de seguridad (helmet) y CORS restringido a orígenes concretos.
- Dependencias: `npm audit` sin vulnerabilidades altas ni críticas; si queda alguna, justificada por escrito en el README.

### Bloque 6: Concurrencia, consistencia e idempotencia
1. Identificar por escrito, en un ADR, qué operaciones pueden entrar en condición de carrera y cómo se resuelve cada una.
2. Test automatizado que dispare al menos 50 pedidos simultáneos sobre la operación y verifique el dato final (no alcanza con que no haya error).
3. Idempotencia con `Idempotency-Key` en todas las operaciones que crean algo, cobran algo o disparan un efecto externo, con test.
Defensa: qué pasa si se quita el bloqueo o la transacción; hay que poder predecirlo antes de ejecutarlo y después mostrarlo.

### Bloque 7: Event loop y tareas pesadas
- Implementar primero la versión ingenua (la que bloquea) y medirla; después la que no degrada el servicio con una de las cuatro estrategias, justificada en un ADR.
- Medir ambas bajo carga (autocannon, k6 o similar): latencia p50, p95 y p99 de un endpoint liviano (por ejemplo `/health`), pedidos por segundo, lag del event loop (`monitorEventLoopDelay`) y memoria.
- Hipótesis con número antes de medir y conclusión después. Los comandos del informe tienen que ser ejecutables tal como están escritos. Se ejecuta en vivo en la corrección.

### Bloque 8: Tests (tres niveles, un único comando que corre todos)
- Dominio: unitarios, sin HTTP ni base, con `node:test` o vitest; cubren reglas de negocio y casos de borde.
- Integración: flujos principales contra la base real en Docker, con la base en estado conocido al empezar cada test.
- Seguridad y concurrencia: los de los bloques 5 y 6 (autorización por recurso, prototype pollution, inyección, límite de tasa, carrera, idempotencia).
- La cobertura no se evalúa como número; se evalúa qué eligieron testear y por qué. Un test que falla en la entrega cuenta como requisito no cumplido.

---

## 5. Plataforma de viajes (requisitos del proyecto)

### 5.1 Contexto y roles
Roles mínimos: **pasajero**, **chofer**, **operador** (soporte: ve viajes en curso, puede cancelar con motivo) y **administrador** (configura tarifas, zonas y parámetros).

### 5.2 Alcance funcional mínimo
- Registro y autenticación de pasajeros y choferes, con datos del vehículo para el chofer y un estado de habilitación que otorga el administrador.
- El chofer se declara disponible o no disponible y, mientras está disponible, envía su ubicación periódicamente.
- Solicitud de viaje con origen, destino y una estimación de precio y tiempo mostrada antes de confirmar.
- Búsqueda de choferes disponibles cercanos y oferta del viaje con tiempo límite de aceptación.
- Máquina de estados del viaje: solicitado, asignado, chofer en camino, en curso, finalizado, cancelado por pasajero, cancelado por chofer, sin choferes disponibles.
- Seguimiento en tiempo real del estado y de la posición del chofer, para el pasajero y para el chofer.
- Cálculo de la tarifa final al terminar el viaje y registro del cobro (simulado).
- Historial de viajes por pasajero y por chofer, y panel del operador con los viajes en curso.

### 5.3 Problema central (30 % de la entrega)
Un viaje se asigna a un solo chofer y un chofer tiene un solo viaje activo, incluso con decenas de solicitudes y aceptaciones simultáneas y con pasajeros que cancelan justo mientras un chofer acepta. Dos recursos limitados a la vez: viaje y chofer. Se exige:
- Un ADR del mecanismo de asignación: qué se bloquea, en qué orden, qué pasa si dos choferes aceptan en el mismo milisegundo, por qué no puede haber doble asignación y cómo se evita el interbloqueo (dos operaciones que toman los mismos recursos en orden distinto).
- Test de al menos 50 aceptaciones simultáneas sobre el mismo viaje: exactamente una tiene éxito y las demás reciben un rechazo claro.
- Test de cancelación simultánea (pasajero cancela mientras un chofer acepta): el resultado es uno de dos estados definidos y documentados; nunca un viaje asignado a un chofer sin pasajero ni un chofer ocupado sin viaje.
- Test de que un chofer con un viaje activo no puede aceptar otro.

### 5.4 Búsqueda geográfica y ubicaciones
- Los choferes disponibles envían ubicación periódicamente (sugerido cada 2 a 5 s); el sistema soporta que lo hagan al mismo tiempo, y esto se mide.
- La búsqueda de cercanos usa un mecanismo apropiado (PostGIS, geohash o estructura en memoria), con ADR que compare al menos dos opciones y su costo. No se acepta traer todos los choferes y calcular distancias en JavaScript sin justificarlo y medirlo.
- El historial de ubicaciones se conserva para el recorrido del viaje; el grupo define y documenta una política de retención o agregación.
- El endpoint de seguimiento no expone la ubicación de un chofer a quien no es su pasajero actual, ni la de un pasajero a quien no es su chofer asignado. Test.

### 5.5 Tarifa, oferta y tiempo real
- Tarifa siempre en el servidor, a partir de distancia, tiempo y parámetros configurados. Estimación y cálculo final usan la misma función; la diferencia queda explicada. Tests con casos concretos incluidos los bordes: distancia cero, viaje que supera el máximo permitido.
- Cada oferta tiene tiempo límite de aceptación (sugerido 15 a 30 s). Si el chofer no responde, la oferta vence y se ofrece al siguiente candidato; si se agota la lista, el viaje pasa a "sin choferes disponibles". El vencimiento ocurre aunque el chofer haya cerrado la app (no depende de que el cliente avise).
- Tiempo real por WebSocket o Server-Sent Events (elección justificada). Documentar qué pasa si la conexión se corta y reconecta: el cliente recupera el estado actual sin desincronizarse.

### 5.6 Tarea pesada obligatoria: recepción masiva de ubicaciones con búsqueda de candidatos
- Simulador propio de al menos 500 choferes enviando ubicación cada 2 s, sostenido varios minutos.
- Medir con y sin la solución elegida: latencia p50/p95/p99 del endpoint de solicitud de viaje, tiempo hasta la asignación, lag del event loop, pedidos por segundo y memoria.
- Demostrar que bajo esa carga las asignaciones siguen ocurriendo en un tiempo razonable definido y declarado por el grupo (el número lo elige el grupo; se evalúa que se haya medido y se cumpla).
- La versión ingenua también se implementa y se mide.

### 5.7 Variante H (obligatoria para nuestro grupo): Reasignación ante fallas
- Si un chofer asignado deja de enviar ubicación durante un tiempo configurable, o rechaza continuar, el viaje se reasigna a otro chofer sin que el pasajero tenga que volver a pedirlo.
- El historial del viaje conserva todos los choferes que tuvo y por qué cambió cada uno.
- El chofer que perdió el viaje no queda marcado como ocupado, y el que lo recibe no queda con dos.
- Carrera propia: el proceso de reasignación decide reasignar exactamente cuando el chofer original vuelve a reportarse. No puede quedar el viaje con dos choferes ni con ninguno.
- La variante se suma al alcance común (no lo reemplaza). Si no se llega, se descuenta del problema central; conviene entregarla con alcance mínimo y bien resuelta antes que a medias.

### 5.8 Qué se muestra en la demo (toda la comisión)
- Ciclo completo de un viaje con seguimiento en tiempo real del lado del pasajero.
- Test de 50 aceptaciones simultáneas sobre el mismo viaje.
- Caso de cancelación simultánea a la aceptación.
- Oferta que vence y pasa al siguiente chofer, con la aplicación del chofer cerrada.
- Intento de ver la ubicación de un viaje ajeno, rechazado.
- Carga de 500 choferes corriendo, con medición de latencia y lag antes y después de la solución.
- La variante del grupo (H) con su condición de carrera.

---

## 6. Artefactos de proceso

### 6.1 ADR (mínimo seis, uno por archivo, numerados, en `docs/adr/`)
Obligatorios: 1) sistema de módulos (CommonJS o ESM) con consecuencias; 2) persistencia y acceso a datos (base y SQL directo/query builder/ORM); 3) autenticación y autorización (JWT o sesiones; cómo se verifica el acceso por recurso); 4) resolución de la condición de carrera principal; 5) solución de la tarea pesada (cuál de las cuatro estrategias y por qué); 6) uno o más a elección sobre las decisiones más discutidas.

Formato obligatorio de cada ADR:
- **Título**: frase que nombra la decisión (bien: "Usamos bloqueo pesimista de la fila del viaje para la asignación"; mal: "Concurrencia").
- **Estado**: propuesto, aceptado o reemplazado por (número).
- **Fecha y quiénes participaron.**
- **Contexto**: problema y restricciones.
- **Opciones consideradas**: al menos dos, con ventajas y desventajas reales (una opción que solo tiene desventajas no cuenta).
- **Decisión**: una o dos oraciones.
- **Consecuencias**: qué gana, qué pierde, qué queda más difícil.
- **Qué nos haría cambiar de decisión**: condición concreta.

Un ADR sin alternativas descartadas no cuenta. Se escriben durante el cuatrimestre, cuando se decide; no la noche anterior. Los agentes no deben inventar las alternativas por el equipo: pueden armar el esqueleto y las preguntas, pero las opciones reales y las decisiones las completa el grupo.

### 6.2 Informe de medición (`docs/mediciones.md`, cubre la tarea pesada y la carrera principal)
Por cada medición: 1) hipótesis escrita antes de medir, con un número; 2) entorno (máquina, SO, versión de Node, versión de la base, si corría en Docker, qué más corría); 3) comando exacto, copiable y ejecutable; 4) resultados en tabla para versión ingenua y final: p50, p95, p99, pedidos por segundo, lag del event loop (máximo y p99) y memoria, con unidades; 5) conclusión honesta (una hipótesis refutada con números es un buen resultado; ajustarla después de ver los datos es malo). Mínimo 30 segundos de carga sostenida, repetido al menos 3 veces; si difieren mucho, también es un resultado.

Método (anexo 11.2): hipótesis antes de correr; estado conocido (misma carga de base en las dos corridas, nada más corriendo); línea de base sin la tarea pesada; después con la tarea pesada en versión ingenua y luego final; 3 repeticiones por escenario; números con unidades, no capturas sin contexto. El lag se mide instrumentando el propio servidor con `monitorEventLoopDelay`, no desde afuera.

### 6.3 Historial de trabajo
El historial de Git: commits de todos los integrantes distribuidos en el cuatrimestre, mensajes que digan qué cambió y por qué, integraciones por PR con revisión real.

---

## 7. Fase de ataque cruzado

Una semana, con los sistemas congelados: cada grupo ataca el sistema de otro grupo de su comisión y después defiende el propio. Emparejamiento: grupo 1 ataca al 2, 2 al 3, etc., y el 8 ataca al 1. Nosotros (grupo 8) atacamos al grupo 1 y somos atacados por el grupo 7.

Qué se busca: acceso a recursos ajenos cambiando identificadores; escalada de privilegios; inyección (SQL, prototype pollution); romper consistencia con pedidos concurrentes (asignar dos veces el mismo recurso, estados imposibles); saltear validaciones (campos no declarados, tipos inesperados, valores límite, cuerpos enormes, ids con formato raro); reutilizar o falsificar credenciales (tokens vencidos o de otro usuario, reenvío de pedidos ya procesados); degradar el servicio con una operación costosa disparada pocas veces.

Reglas (de cumplimiento obligatorio; incumplir invalida la fase y es falta de conducta académica):
1. Se ataca únicamente el entorno publicado por el defensor, con los usuarios de prueba que provee.
2. Prohibido atacar infraestructura compartida del laboratorio, la red de la facultad o cualquier sistema fuera del entorno publicado.
3. Prohibidos los ataques de volumen para tirar el servicio (DoS por saturación). Sí se permite demostrar que una operación costosa degrada el servicio con pocos pedidos.
4. Prohibido acceder al repo privado del otro grupo, sus máquinas o cuentas; el trabajo es de caja negra salvo lo documentado públicamente.
5. Prohibida la ingeniería social.
6. Si un ataque provoca caída o pérdida de datos en el entorno del defensor, se avisa de inmediato al defensor y a la cátedra y se documenta.
7. Todo lo encontrado se usa solo para este trabajo.

Bitácora del atacante (`docs/ataque.md`, una entrada por intento, incluidos los fallidos): número y fecha; hipótesis; petición exacta (método, URL, encabezados, cuerpo; copiable y repetible); resultado esperado; resultado obtenido; veredicto (hallazgo confirmado, defensa efectiva o no concluyente); severidad (alta, media, baja con justificación); impacto.

Respuesta del defensor (en el mismo archivo), por cada hallazgo confirmado: severidad acordada o discutida; causa raíz (qué decisión u olvido lo hizo posible, no alcanza con "faltaba una validación"); commit que lo corrige; test automatizado que reproduce el ataque y falla antes del arreglo y pasa después; si no se corrige, justificación del riesgo aceptado. El defensor no pierde puntos por tener vulnerabilidades sino por no corregirlas, no entender la causa o no poder explicarla. Un sistema no disponible en la semana pierde los puntos del defensor: el entorno tiene que estar arriba (Docker Compose en una máquina accesible).

---

## 8. Defensa oral (40 % de la nota)

Individual aunque se tome en grupo, 20 a 30 minutos por grupo. El docente elige quién responde cada pregunta; no se reparten temas. Se trabaja sobre el repo entregado y el sistema corriendo en una máquina propia preparada antes. Se puede consultar el propio código y documentación; no se puede usar asistentes de IA ni buscar en internet. Cada integrante es preguntado sobre al menos un fragmento que figure a su nombre en el historial de Git. Tipos de pregunta:
- **Predicción**: qué pasa ante una entrada u orden de eventos concreto (se predice en voz alta y luego se ejecuta).
- **Diagnóstico**: el docente introduce una falla (quitar un `await`, quitar el bloqueo de la asignación, aflojar una validación, invertir una autorización, cambiar el orden de dos middlewares, quitar el manejo de un error asincrónico) y hay que encontrarla.
- **Modificación en vivo**: un cambio chico de requisito que toca dominio o un adaptador (nueva regla de negocio, cambiar el adaptador de notificaciones, agregar un rol con permisos limitados, cambiar un criterio de orden).
- **Justificación**: defender un ADR frente a la alternativa descartada.

Lo que lleva el grupo: el sistema corriendo con datos de prueba, la colección de requests de la demo, los tests corriendo y el generador de carga instalado y probado, y el repo y las mediciones accesibles sin internet.

### Autoevaluación antes de entregar
Clon en máquina limpia con la secuencia 2.4 sin tocar más que `.env`; todos los tests pasan con un comando; borrar una variable falla con mensaje claro; SIGTERM durante un pedido lento deja terminar el pedido; acceso al recurso de otro da 403/404 (con test); test concurrente de la carrera principal verifica el dato final; misma operación dos veces con la misma clave de idempotencia produce un solo efecto; tarea pesada medida en dos versiones con comandos en `docs/mediciones.md`; al menos seis ADR con alternativas descartadas; bitácora de ataque completa y hallazgos respondidos con tests; sin secretos en el repo ni el historial y `.env.example` completo; `npm audit` sin altas ni críticas (o justificadas); cada integrante puede explicar el fragmento más complicado.

### Errores frecuentes de años anteriores (evitarlos)
Empezar por el frontend; dejar la seguridad para el final (la autorización por recurso atraviesa todos los endpoints); confundir autenticación con autorización; escribir los ADR después de las decisiones; medir una sola vez sin línea de base; creer que un solo hilo evita las condiciones de carrera; usar `number` para dinero; tener un solo integrante que entiende el proyecto; no probar el clon limpio en otra máquina hasta el día de la entrega.

---

## 9. Requisitos adicionales (criterios "TP Integrador, Backend-Jueves", además del coloquio)

Se evalúa no solo la configuración de las herramientas sino su implementación efectiva, funcionamiento y presentación de evidencias de los resultados. Todos son obligatorios.

- **TEMA 1: tres temas de las presentaciones grupales**, implementados funcionalmente en el TP demostrando su aplicación práctica.
- **TEMA 2: framework frontend** integrado con los servicios del backend por API.
- **TEMA 3: pruebas End-to-End con Playwright** que validen los principales flujos funcionales.
- **TEMA 4: Integración Continua**: pipeline (GitHub Actions u otro) que ejecute automáticamente las pruebas unitarias y E2E ante cambios en el repo, más análisis de código estático (SAST).
- **TEMA 5: pruebas de carga y estrés con k6** sobre los servicios del backend, analizando tiempos de respuesta, concurrencia, rendimiento y errores (de manera local).
- **TEMA 6: observabilidad con Grafana Cloud**: integrar el backend para recopilar y visualizar métricas, logs y/o trazas mediante dashboards que permitan monitorear la aplicación.

### Temas de exposiciones disponibles para el Tema 1
Redis (caché y datos efímeros); colas de mensajes y procesamiento asíncrono; publicación/suscripción y eventos; monolito modular y microservicios; API Gateway y reverse proxy; REST frente a gRPC; Circuit Breaker, timeout y reintentos; Bulkhead, rate limiting y backpressure; idempotencia y deduplicación; condiciones de carrera y control de concurrencia; Saga y transacciones distribuidas; base de datos por servicio y propiedad de datos; CQRS; Docker Compose para un sistema distribuido; Blue-Green Deployment; Canary Deployment y feature flags; health checks, balanceo y auto-recuperación; logs, métricas y trazas distribuidas; OAuth 2.0/OIDC, JWT y autorización entre servicios; WebSockets y actualización en tiempo real.

**Elección recomendada (para no sumar trabajo, los tres ya los exige Programación IV):** (1) condiciones de carrera y control de concurrencia, (2) idempotencia y deduplicación, (3) health checks y auto-recuperación (app en Compose con `healthcheck` y `restart: unless-stopped`, demostrar que si se mata el proceso se recupera). Alternativa para el tercero: monolito modular y microservicios (ADR más un test que impida que un módulo importe las partes internas de otro). Documentar en `docs/temas-exposiciones.md`: por tema, la decisión, dónde está en el código, el comando o test que lo demuestra y la evidencia (salida de terminal o captura). Confirmar la elección con el equipo y, si hace falta, con el docente.

### Lineamientos de implementación acordados
- **Frontend (Tema 2)**: React con Vite, mínimo: login; solicitar viaje con estimación previa; seguimiento del viaje en tiempo real (`EventSource` sobre el SSE); vista del chofer (disponibilidad, ofertas, aceptar). Panel del operador si hay tiempo. CORS del backend permite el origen del servidor de Vite (`http://localhost:5173`) sin abrir a todos. Carpeta propia (`frontend/`) sin tocar el backend. No empezar hasta que existan las rutas y la autenticación.
- **Playwright (Tema 3)**: 2 o 3 flujos E2E (por ejemplo: login; pasajero solicita viaje y ve la estimación; chofer acepta y el pasajero ve el cambio de estado). Requiere datos de prueba deterministas (seed) y base de test. Config en `playwright.config.js`, tests en `e2e/` o `tests/e2e/`, script `npm run test:e2e`.
- **CI (Tema 4)**: GitHub Actions en `.github/workflows/ci.yml` con Node 22 y `npm ci`: lint; tests de dominio, integración, seguridad y concurrencia con un servicio PostgreSQL (`postgis/postgis:16-3.4`, healthcheck con `pg_isready`) y variables no secretas definidas en el workflow; `npm audit --audit-level=high`; análisis estático con **Semgrep** (CLI, reglas `p/javascript` y `p/nodejs`; no CodeQL porque el repo es privado y requeriría GitHub Advanced Security); job E2E con Playwright cuando exista. Template de PR y CONTRIBUTING.md.
- **k6 (Tema 5)**: scripts en `scripts/carga/k6/`, ejecución local (k6 instalado en la máquina, no vía npm). Escenarios mínimos: login, estimación de viaje, solicitud de viaje, aceptación concurrente de ofertas; con `thresholds` (por ejemplo p95 y tasa de errores) y `summaryTrendStats` para incluir p99 (k6 muestra p90 y p95 por defecto). Guardar resultados y análisis (tiempos de respuesta, concurrencia, rendimiento, errores) en `docs/` y reutilizarlos para `docs/mediciones.md`.
- **Grafana Cloud (Tema 6)**: endpoint `/metrics` en formato Prometheus con `prom-client` (histograma de duración HTTP, lag del event loop, memoria, métricas por defecto; protegido con token de entorno); logs JSON de pino; Grafana Alloy como servicio en Docker Compose enviando métricas y logs a Grafana Cloud. Dashboards con latencia, pedidos por segundo, errores y lag del event loop (y métricas de negocio como ofertas aceptadas si hay tiempo). Exportar el JSON de los dashboards a `docs/`. Tokens y URLs de Grafana solo en `.env` o secrets, nunca en el repo.
- **Si falta tiempo, recortar a**: un dashboard de 4 paneles, k6 con 3 escenarios, frontend de 4 pantallas y 2 flujos de Playwright. Priorizar siempre lo que más pesa en Programación IV (problema central, seguridad, concurrencia, tests).

---

## 10. Decisiones de arquitectura acordadas (ADR pendientes de redactar con alternativas reales)

- **Monolito modular con arquitectura hexagonal**, no microservicios (el enunciado exige un solo sistema en un solo repo; la asignación atómica de viaje y chofer se resuelve con bloqueos y transacciones en una sola base). Los módulos son carpetas por dueño. Los workers (vencimiento de ofertas, reasignación, retención de ubicaciones) son puntos de entrada separados del mismo repo, que pueden correr como procesos o contenedores distintos.
- **ESM** (`"type": "module"`), **Express 5** (los handlers asincrónicos propagan errores al middleware), **PostgreSQL con PostGIS** (imagen `postgis/postgis:16-3.4`), **SQL directo con `pg`** y consultas parametrizadas, **zod** (esquemas estrictos), **pino** (logs JSON), **argon2** (contraseñas), **jsonwebtoken** (JWT), **helmet**, **cors**, **express-rate-limit**, **prom-client**, **node:test** para tests, **autocannon** y **k6** para carga. (ESM y `pg` son propuestas pendientes de ADR 1 y 2 con alternativas.)
- **Orden de bloqueos fijo en TODO caso de uso que bloquee**: primero la fila del viaje, después la del chofer, después las ofertas (siempre ese orden), con `SELECT ... FOR UPDATE`. Aplica a aceptar, cancelar, rechazar, vencer ofertas, finalizar y reasignar. La reasignación bloquea viaje, chofer saliente y chofer entrante en ese orden. Los workers que buscan trabajo usan `FOR UPDATE SKIP LOCKED`.
- **Red de seguridad en la base** además de los bloqueos: índices únicos parciales que impiden dos asignaciones abiertas para el mismo viaje, dos abiertas para el mismo chofer y dos ofertas aceptadas para el mismo viaje. Los errores de unicidad (23505), deadlock (40P01) y serialización (40001) se traducen a errores de dominio (nunca mensajes crudos).
- **Unidad de trabajo transaccional**: `Transaccion.ejecutar(fn)` entrega a `fn` los repositorios (`viajes`, `ofertas`, `choferes`, `asignaciones`) ligados a la misma conexión (un único client del pool con BEGIN/COMMIT/ROLLBACK y release en `finally`). Sin eso `FOR UPDATE` no bloquea nada.
- **Dinero en centavos enteros** (nunca float). Redondeo half-up por componente, documentado. La estimación previa y la tarifa final usan la misma función.
- **El chofer ocupado se deduce de la asignación abierta**, no de un flag; `choferes.disponible` lo gestiona el chofer.
- **El chofer actual de un viaje sale de `asignaciones_viaje`** (una sola fuente de verdad); `viajes` no guarda `chofer_id`.
- **Tiempo real por SSE** con reconexión por `Last-Event-ID` y un endpoint de snapshot (`/viajes/:id/estado`), bus de eventos detrás de un puerto.
- **Autorización por recurso**: el actor debe ser dueño o participante; para terceros se responde como si el recurso no existiera (`VIAJE_NO_ENCONTRADO` / 404). Rol no es identidad: además del rol hay que verificar que el actor sea el pasajero dueño o el chofer asignado.
- **Retención de ubicaciones**: tabla `ubicaciones_actuales` (UPSERT, última posición) más historial con política de retención/agregación documentada.
- **Migraciones numeradas con rangos por frente**: `001_*` base, `1xx_*` viajes, `2xx_*` ubicaciones, `3xx_*` identidad y reasignación. Runner propio (`src/infra/db/migrar.js`): aplica los `.sql` en orden alfabético, cada uno en transacción, registra en `schema_migraciones`, con advisory lock. Si se necesitan columnas en tablas de otro rango, se agregan con `ALTER TABLE` en el rango propio sin editar migraciones ajenas.
- **Convención de errores de dominio con código estable** (la capa web los traduce a HTTP con una tabla explícita): `TRANSICION_INVALIDA`, `ACTOR_NO_AUTORIZADO`, `DATOS_INVALIDOS`, `VIAJE_FUERA_DE_LIMITE`, `VIAJE_NO_ENCONTRADO`, `OFERTA_NO_ENCONTRADA`, `OFERTA_NO_VIGENTE`, `VIAJE_NO_DISPONIBLE`, `CHOFER_NO_DISPONIBLE`, `CHOFER_OCUPADO`, `CONFLICTO_CONCURRENTE`, `RECURSO_AJENO`, `NO_ENCONTRADO`. Formato de respuesta de error: `{ error: { codigo, mensaje, idCorrelacion } }`.

---

## 11. Modelo de datos y máquina de estados

### 11.1 Estados del viaje
`solicitado`, `asignado`, `chofer_en_camino`, `en_curso`, `finalizado`, `cancelado_pasajero`, `cancelado_chofer`, `sin_choferes`. Terminales: `finalizado`, `cancelado_pasajero`, `cancelado_chofer`, `sin_choferes`.

Transiciones válidas (la tabla `TRANSICIONES` es dato exportado en `src/dominio/viajes/maquina-estados.js`; los tests se generan recorriéndola; toda combinación estado x evento fuera de la tabla falla; `aplicarTransicion` es pura y no muta):

| Evento | Quién | Desde | Hacia |
|---|---|---|---|
| `aceptar_oferta` | chofer | solicitado | asignado |
| `agotar_candidatos` | sistema | solicitado | sin_choferes |
| `cancelar_pasajero` | pasajero | solicitado, asignado, chofer_en_camino | cancelado_pasajero |
| `cancelar_chofer` | chofer asignado | asignado, chofer_en_camino | cancelado_chofer |
| `salir_en_camino` | chofer asignado | asignado | chofer_en_camino |
| `iniciar` | chofer asignado | chofer_en_camino | en_curso |
| `finalizar` | chofer asignado | en_curso | finalizado |
| `cancelar_operador` | operador (motivo obligatorio) | cualquier estado no terminal | cancelado_pasajero (actor=operador y motivo registrados) |

Reglas pendientes de confirmar con el equipo y dejar escritas en `docs/modelo.md`: qué pasa con cancelar durante `en_curso` (hoy solo el operador puede); evento `reasignar` (sistema) de la variante H: un viaje en `asignado` o `chofer_en_camino` que se reasigna queda en `asignado` con el nuevo chofer.

Orden de validación en `aplicarTransicion`: evento conocido, actor, par (estado, evento), motivo obligatorio. Esto separa `ACTOR_NO_AUTORIZADO` de `TRANSICION_INVALIDA`. El tiempo llega por datos (`datos.en`), no se usa `Date.now()` en el dominio.

### 11.2 Tablas
- `001_base.sql`: extensión postgis; `usuarios` (id uuid, email único case-insensitive guardado en minúsculas, password_hash, nombre, rol CHECK pasajero/chofer/operador/administrador, activo, creado_en); `choferes` (usuario_id PK y FK, patente única, vehiculo_marca/modelo/color, habilitado default false, habilitado_por, habilitado_en, disponible default false); `claves_idempotencia` (usuario_id, clave, hash_pedido, estado_http, respuesta jsonb, creada_en; PK (usuario_id, clave)); más `schema_migraciones` (creada por el runner).
- `101_viajes.sql`: `viajes` (id, pasajero_id, estado con CHECK de los 8 estados, origen/destino lat/lng con CHECK de rangos, distancia_estimada_m, duracion_estimada_s, tarifa_estimada_centavos, tarifa_final_centavos nullable, motivo_cierre, creado_en, actualizado_en); índices por (pasajero_id, creado_en) y estado.
- `102_ofertas_viaje.sql`: `ofertas_viaje` (id, viaje_id, chofer_id, estado pendiente/aceptada/rechazada/vencida/cancelada, orden >= 1, expira_en, creada_en, respondida_en); UNIQUE (viaje_id, chofer_id); índice único parcial: una sola oferta aceptada por viaje; índice (estado, expira_en) para el worker de vencimientos.
- `103_asignaciones_viaje.sql`: `asignaciones_viaje` (id, viaje_id, chofer_id, desde, hasta nullable, motivo_fin; CHECK hasta >= desde); índices únicos parciales: una sola asignación abierta (`hasta IS NULL`) por viaje y una por chofer. Cerrar la asignación es parte de finalizar o cancelar (si no, el chofer queda bloqueado).
- `104_viajes_eventos.sql`: `viajes_eventos` append-only (id, viaje_id, evento, actor_tipo pasajero/chofer/operador/sistema, actor_id, estado_anterior, estado_nuevo, motivo, en); la aplicación nunca hace UPDATE ni DELETE.
- `105_cobros.sql` (a crear): `cobros` con UNIQUE (viaje_id) para que el cobro sea idempotente, monto en centavos y estado.
- `200_ubicaciones.sql`: ubicaciones actuales de choferes y `ubicaciones_historial` (referencia a `viajes`; cuidado al limpiar tablas en tests).
- `300_*`: identidad, administración (tarifas, zonas, parámetros) y reasignación.

### 11.3 Puertos del dominio (con adaptador PostgreSQL y adaptador en memoria)
RepositorioViajes, RepositorioOfertas, RepositorioChoferes, RepositorioAsignaciones, Transaccion (unidad de trabajo), Reloj, GeneradorId, EstimadorRuta, ServicioGeo (`buscarCandidatos({lat, lng, radioMetros, limite})` ordenado por cercanía; real con PostGIS, ingenuo y en memoria), ParametrosViajes (tarifa, tiempo de oferta, radio, máximo de candidatos), PasarelaPagos (adaptador simulado), bus de eventos SSE, cola de escritura de historial de ubicaciones, repositorios de usuarios/administración/ubicaciones, hasher de contraseñas. Todo se crea en `src/composicion.js`.

---

## 12. Reparto de frentes y rutas por módulo

Cada frente es dueño de su carpeta (`src/dominio/<modulo>/`, `src/infra/http/rutas/<modulo>.js`, `src/infra/db/`, migraciones de su rango, tests). Cambios en archivos compartidos (`composicion.js`, contratos de puertos, `package.json`) se hacen mínimos y por PR.

### Frente A: Viajes (Joaquin)
Rutas:
- `POST /viajes/estimacion` (pasajero): distancia, tiempo y precio estimado con la misma función de tarifa.
- `POST /viajes` (pasajero, `Idempotency-Key`): crea el viaje en `solicitado`, busca candidatos (puerto `ServicioGeo`) y crea la primera oferta.
- `GET /viajes/:id` (pasajero dueño, chofer asignado u operador/administrador; el resto recibe como si no existiera).
- `POST /viajes/:id/cancelar` (pasajero) con motivo.
- `GET /choferes/me/ofertas` (chofer: ofertas vigentes).
- `POST /ofertas/:id/aceptar` y `POST /ofertas/:id/rechazar` (chofer).
- `POST /viajes/:id/en-camino`, `/iniciar`, `/finalizar`, `/cancelar-chofer` (chofer asignado).
- `GET /pasajeros/me/viajes` y `GET /choferes/me/viajes` (historial paginado).
- `GET /operador/viajes?estado=` y `POST /operador/viajes/:id/cancelar` con `{motivo}` (operador).

Funcionalidad: máquina de estados; ofertas con tiempo límite; `aceptarOferta` con bloqueo viaje, chofer, oferta (autorización por recurso, validaciones de vigencia, disponibilidad y asignación abierta, cancelación de las otras ofertas pendientes, apertura de asignación, evento); `rechazarOferta` que ofrece al siguiente o deja `sin_choferes`; **worker de vencimiento de ofertas** (`FOR UPDATE SKIP LOCKED`, funciona con la app del chofer cerrada); transiciones del chofer; tarifa final con `calcularTarifa` y cobro simulado idempotente al finalizar (puerto `PasarelaPagos`, tabla `cobros`); cancelaciones de pasajero, chofer y operador (cierran la asignación y liberan al chofer); idempotencia con `Idempotency-Key` en `POST /viajes` y en el cobro (considerar agregar la ruta a la clave).
Tests: dominio con adaptadores en memoria; integración contra `DATABASE_URL_TEST`; concurrencia (50 aceptaciones simultáneas sobre el mismo viaje, chofer con dos ofertas de dos viajes, cancelación simultánea con aceptación con resultado en uno de dos estados documentados, doble envío con la misma `Idempotency-Key`). Experimento para la defensa y el informe: repetir el test sin los `FOR UPDATE` (con y sin índices únicos) y registrar qué falla y qué reciben los perdedores.
Documentación: ADR de la asignación (bloqueo pesimista, orden, interbloqueo; alternativas: solo restricción de base, optimista con versión, combinación), sección de máquina de estados y diagrama en `docs/modelo.md`.

### Frente B: Ubicaciones, geografía, tiempo real y carga
Rutas: `PUT /choferes/me/disponibilidad` (chofer habilitado); `POST /choferes/me/ubicacion` (chofer disponible, con rate limit propio); `GET /viajes/:id/estado` (snapshot); `GET /viajes/:id/seguimiento` (SSE con `Last-Event-ID`; solo el pasajero actual ve al chofer y solo el chofer asignado ve al pasajero); `GET /viajes/:id/recorrido`; `GET /metricas` (administrador).
Funcionalidad: `ServicioGeo` con tres adaptadores (PostGIS con índice GiST y `ST_DWithin`, ingenuo que trae todos y calcula en JS a propósito, y en memoria); bus de eventos; retención del historial de ubicaciones; cola/batching de escritura del historial; simulador de 500 choferes cada 2 s (`scripts/carga/simulador-choferes.js`) y carga con autocannon y k6; medición con y sin la solución (versión ingenua y final) en `docs/mediciones.md`.
Documentación: ADR geográfico (PostGIS vs geohash vs memoria), ADR de tarea pesada, ADR SSE vs WebSocket, política de retención.
Extras del Backend-Jueves que encajan aquí: k6 (Tema 5) y la parte de métricas de Grafana (Tema 6).

### Frente C: Identidad, administración, seguridad transversal y variante H
Rutas: `POST /auth/registro/pasajero`, `POST /auth/registro/chofer` (queda no habilitado), `POST /auth/login` (rate limit), `GET /me`; `PATCH /admin/choferes/:id/habilitacion`, `GET /admin/choferes`; `GET|PUT /admin/tarifas`, `/admin/zonas`, `/admin/parametros` (tiempo límite de oferta, umbral de reasignación por falta de ubicación); `POST /viajes/:id/rechazar-continuar` (chofer asignado); `GET /viajes/:id/asignaciones` (pasajero dueño, operador, administrador).
Funcionalidad: argon2 con costo en variables de entorno, JWT, middlewares `autenticar` y `requerirRol(...)`, helper de autorización por recurso reutilizable, roles pasajero/chofer/operador/administrador con tabla en el README; **variante H**: worker de reasignación que detecta viajes asignados cuyo chofer no reporta ubicación hace más que el umbral y reasigna con `FOR UPDATE SKIP LOCKED` revalidando el umbral dentro de la transacción; caso de uso único `reasignarViaje(viajeId, motivo)` (bloquea viaje, chofer saliente, chofer entrante; cierra la asignación vigente, libera al saliente, asigna al nuevo sin dejarlo con dos viajes); historial de choferes con motivo; carrera propia (reasignación vs. chofer original que vuelve a reportarse).
Tests de seguridad: autorización por recurso (acceder a un viaje ajeno por id), escalada de rol, prototype pollution (`__proto__` y `constructor.prototype`), inyección SQL, rate limit 429, carrera de H, el chofer anterior no queda ocupado.
Documentación: ADR de autenticación y autorización, ADR de reasignación.
Además: **aplicación arrancable** (ver 13): composición, servidor, configuración validada, `/health`, `/ready`, SIGTERM, middleware de errores, logs JSON con AsyncLocalStorage, helmet, CORS, `/metrics`, app en Compose, scripts npm reales, seed por rol.

### Frente grupal / calidad
CI con análisis estático, lint real, corrección de dependencias con alertas altas; frontend y Playwright; k6 y Grafana; `api.md`, `ataque.md`, ADR faltantes, mediciones con 3 corridas, `temas-exposiciones.md`; colección de requests de la demo; fase de ataque cruzado.

---

## 13. Aplicación arrancable (requisito transversal)

- `src/config/`: esquema zod de todas las variables de entorno; falla con mensaje exacto y código distinto de 0.
- `src/composicion.js`: único lugar que crea el pool de pg, adaptadores (PostgreSQL o en memoria según variable de entorno), casos de uso, hasher, workers y routers; exporta una función que construye la app a partir de la config.
- App Express: límite de tamaño de body; helmet; CORS restringido por variable; middleware de id de pedido con AsyncLocalStorage (`X-Request-Id` en la respuesta); logs JSON con pino incluyendo ese id; montaje de los routers de cada módulo; `/health`, `/ready` (conexión a la base y migraciones aplicadas comparando archivos con `schema_migraciones`), 404 y un único middleware de errores.
- `/metrics` Prometheus protegido con token de entorno.
- `src/servidor.js`: arranque y apagado ordenado con SIGTERM/SIGINT (deja de aceptar conexiones, termina las en curso, detiene workers, cierra el pool, sale; timeout configurable y registro si se forzó).
- `Dockerfile` y servicio `app` en `docker-compose.yml` con `depends_on` la base `healthy`, `restart: unless-stopped` y healthcheck contra `/health`.
- Scripts npm reales: `dev` (con `--watch`), `start`, `setup` (migrate + seed), `seed` (un usuario de prueba por rol con argon2, idempotente), `migrate`, `test`, `test:dominio`, `test:integracion`, `test:seguridad`, `test:concurrencia`, `test:concurrencia:repetido`, `test:e2e`, `lint`, `audit`. Los que leen `.env` usan `--env-file=.env` (o `--env-file-if-exists=.env`, que requiere Node 22.9 o superior).

---

## 14. Entorno de desarrollo

- Estructura de carpetas: `src/dominio/<modulo>/` (con `casos-de-uso/`), `src/dominio/puertos/`, `src/infra/http/` (rutas y middlewares), `src/infra/db/` (adaptadores PostgreSQL, runner de migraciones), `src/infra/externos/`, `src/infra/memoria/`, `src/infra/workers/` (o `src/workers/`), `src/config/`, `src/composicion.js`, `src/servidor.js`, `migraciones/`, `tests/{dominio,integracion,seguridad,concurrencia}/`, `docs/{adr,mediciones.md,ataque.md,modelo.md,api.md}`, `scripts/carga/`, `.github/` (workflows, `pull_request_template.md`), `frontend/`, `e2e/`.
- Repo fuera de OneDrive (por rendimiento de `node_modules` y sincronización).
- Node 22 (agregar `.nvmrc` con `22`). Con nvm-windows: `nvm install 22` y `nvm use 22`; después de cambiar de versión, reinstalar con `npm ci` (binarios nativos como argon2).
- Docker Compose: `name: movilidad` (fija el nombre del proyecto para que no dependa de la carpeta), servicio `db` con imagen `postgis/postgis:16-3.4`, `container_name: movilidad-db`, volumen `movilidad-datos-postgres`, puerto del host `${DB_PUERTO_HOST}`, healthcheck con `pg_isready`.
- Variables de entorno (`.env.example`): `NODE_ENV`, `HOST`, `PUERTO_HTTP`, `DB_HOST`, `DB_PUERTO`, `DB_PUERTO_HOST`, `DB_NOMBRE`, `DB_USUARIO`, `DB_PASSWORD` (obligatoria, sin ella Compose falla), `DATABASE_URL`, `DATABASE_URL_TEST`, `JWT_SECRETO`, `JWT_EMISOR`, `JWT_AUDIENCIA`, `CORS_ORIGENES`, `LIMITE_CUERPO_BYTES`, `RATE_LIMIT_VENTANA_MS`, `RATE_LIMIT_MAX_PETICIONES`, costos de argon2, y las que sumen los frentes (timeouts de ofertas, token de métricas, credenciales de Grafana solo locales). `DB_PUERTO_HOST`, la clave y el puerto de `DATABASE_URL` y `DATABASE_URL_TEST` tienen que coincidir entre sí (solo cambia el nombre de la base: `movilidad` y `movilidad_test`). `node --env-file` no expande `${...}`, así que `DATABASE_URL` repite los valores. Evitar `@`, `:` y `/` en la clave local. Postgres ignora `POSTGRES_PASSWORD` si el volumen ya estaba inicializado: si cambia la clave, recrear el volumen (`docker compose down -v`, solo con datos de prueba).
- Base de test: `docker exec movilidad-db psql -U movilidad -c "CREATE DATABASE movilidad_test"` y aplicar migraciones apuntando a esa URL. La limpieza entre tests no borra `schema_migraciones` ni tablas de otros módulos que tengan referencias a las suyas.
- Conexión a la base: usuario `movilidad`, base `movilidad`. Para consultas manuales: `docker exec -it movilidad-db psql -U movilidad -d movilidad`.

---

## 15. Convenciones de trabajo

- Ramas por feature (`feat/...`, `fix/...`, `chore/...`) desde `main` actualizado; PR hacia `main` revisado por otro integrante con comentarios reales; commits que digan qué y por qué (cada integrante con su identidad Git).
- Template de PR: qué cambia, por qué, cómo se probó, checklist de tests y ADR.
- Antes de commitear: `git status`, verificar que no entran `.env`, `node_modules` ni secretos.
- Cada integrante lee y entiende el código que genera su agente antes de abrir el PR (la defensa es individual).
- Si un frente depende de otro y no está listo, usar el adaptador en memoria o un middleware provisional (ej. autenticación que lea el usuario de un encabezado, claramente marcada como temporal y fuera de `main`) en vez de bloquearse.

---

## 16. Puntos a revisar (verificar el estado real antes de actuar; borrar cada ítem cuando esté resuelto)

1. **Servidor y composición**: revisar si `src/servidor.js` y `src/composicion.js` tienen implementación real o solo comentarios; sin eso no hay API ejecutable ni demo.
2. **Scripts npm**: revisar `dev`, `start`, `setup`, `seed` y `lint`; confirmar que no sean placeholders ("pendiente"). Revisar que exista el script para los tests de seguridad (`tests/seguridad/*.test.js`) y que `npm test` corra todos los niveles. Revisar que `test:concurrencia` incluya todos los archivos de concurrencia (aceptación simultánea y carrera de reasignación).
3. **Dependencias**: revisar `npm audit --audit-level=high` (se detectaron altas en `body-parser` y `zod`); confirmar que `express` esté instalado para los tests de seguridad HTTP; no usar `npm audit fix --force`.
4. **Versión de Node**: confirmar que todo pasa en Node 22 (se probó en 24 y 26); agregar `.nvmrc`.
5. **`.env.example`**: revisar que `DB_PASSWORD`, `DATABASE_URL` y `DATABASE_URL_TEST` usen la misma clave y que los puertos coincidan con `DB_PUERTO_HOST`; que no contenga secretos reales.
6. **Contratos duplicados**: revisar que `ServicioGeo` y los contratos de repositorio no estén definidos dos veces con firmas distintas (`src/dominio/puertos/index.js` y `src/dominio/ubicaciones/puertos.js`); unificar y que exista un único modo de crear el pool de pg.
7. **Orden de bloqueos**: revisar que TODOS los casos de uso que bloquean (aceptar, cancelar, rechazar, vencer, finalizar, reasignar) respeten viaje, chofer, oferta.
8. **Ciclo del viaje**: revisar la existencia de transiciones del chofer, tarifa final y cobro, cancelaciones, `rechazarOferta`, worker de vencimiento de ofertas, historiales y panel del operador, y de los tests de cancelación simultánea y chofer con viaje activo.
9. **Idempotencia**: revisar la existencia de un middleware `Idempotency-Key` aplicado a `POST /viajes` y al cobro, con test de doble envío; evaluar si la clave primaria de `claves_idempotencia` debe incluir la ruta.
10. **Seguridad de aplicación**: revisar helmet, CORS restringido, rate limit montado, validación estricta, middleware global de errores sin stack trace, logs JSON con `AsyncLocalStorage` e id de correlación, `/health`, `/ready` y SIGTERM.
11. **Integridad**: revisar que `viajes_eventos` sea realmente append-only (hoy solo por comentario; se puede reforzar con un trigger), que `actualizado_en` se actualice en cada cambio de estado, y que la coherencia chofer/rol de usuario se valide en la capa de aplicación.
12. **Migraciones desde cero**: revisar que `001`, `101` a `105`, `200` y `300` se apliquen limpias en una base vacía y en orden, sin dependencias cruzadas entre rangos.
13. **Documentación**: revisar que el README tenga las cinco líneas, la secuencia exacta de arranque, la tabla de roles con usuarios de prueba y el índice de docs; que `docs/api.md`, `docs/modelo.md` (con diagrama de estados), `docs/mediciones.md` (hipótesis, entorno, comando exacto, tabla, conclusión) y `docs/ataque.md` tengan contenido real; que existan los ADR obligatorios (módulos, persistencia, autenticación, carrera principal, tarea pesada, uno más) y que cada uno tenga opciones consideradas, consecuencias y "qué nos haría cambiar".
14. **Proceso**: revisar que haya commits de los tres integrantes con su propia identidad, `pull_request_template.md`, `CONTRIBUTING.md`, ausencia de secretos en el historial y el tag `entrega-final` al final.
15. **Requisitos del Backend-Jueves**: revisar si existen frontend, Playwright, workflows de CI con análisis estático, scripts k6 con resultados guardados, `/metrics`, agente de Grafana en Compose y dashboards exportados, y `docs/temas-exposiciones.md`.
16. **Entorno**: revisar que el clon limpio funcione en otra máquina (secuencia 2.4) y que el repo no esté dentro de OneDrive.
