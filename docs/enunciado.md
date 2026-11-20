# Extracto del enunciado — TP Final Programación IV (UTN FRRe, 2026)

Comisión 1 — Plataforma de viajes. Grupo 8: variante **H. Reasignación ante fallas**.
Extracto de las secciones relevantes. Ante cualquier duda, vale el PDF original (versión 1.0, 23/09/2026).

Convenciones: *debe / tiene que* = exigible. *Demostrable* = hay un test, comando o log que lo muestra. *Justificado* = hay un ADR con alternativas descartadas.

---

## 4. Requisitos comunes (extracto)

### Bloque 2 — Arquitectura hexagonal
- Ningún archivo del dominio importa Express, el driver de la base ni librerías de infraestructura.
- Cada dependencia externa (base, mapas, correo, pagos, etc.) entra por un **puerto con al menos dos adaptadores**: el real y uno falso o en memoria para tests.
- Existe un **único archivo de composición** que crea los adaptadores y los inyecta. Cambiar real por falso se hace tocando solo ese archivo o una variable de entorno.
- Se demuestra con tests de dominio sin base ni HTTP.

### Bloque 3 — Configuración y ciclo de vida
1. Toda la configuración viene de variables de entorno.
2. Se validan al arrancar con un esquema; si falta una, mensaje claro y exit code distinto de cero.
3. Endpoints separados `/health` (vivo) y `/ready` (base disponible y migraciones aplicadas).
4. Apagado ordenado con SIGTERM: deja de aceptar conexiones, termina las en curso, cierra la base, sale. Timeout límite propio.

### Bloque 4 — Errores y observabilidad
- Un único middleware de errores. Ningún handler async deja promesas sin capturar.
- Formato de error único con identificador de correlación; nunca stack trace ni mensaje crudo de la base.
- Logs JSON con identificador de pedido propagado con `AsyncLocalStorage`.

### Bloque 5 — Seguridad
- Autenticación JWT o sesiones; contraseñas con argon2 o bcrypt.
- **Autorización por recurso** verificada en el servidor: pedir un recurso ajeno devuelve 403/404. Test automatizado.
- Al menos tres roles con permisos distintos (tabla en el README).
- Validación de toda entrada con esquema; campos no declarados se rechazan.
- Prototype pollution: test con `__proto__` y `constructor.prototype`; no lista negra de nombres.
- SQL parametrizado + test de inyección.
- Rate limit en login y endpoints costosos (429 + encabezados).
- helmet y CORS restringido.
- `npm audit` sin altas ni críticas (o justificadas en el README).

### Bloque 6 — Concurrencia, consistencia e idempotencia
1. ADR que identifique qué operaciones pueden entrar en condición de carrera y cómo se resuelve cada una.
2. Test con **al menos 50 pedidos simultáneos** que verifique el dato final (no solo que no hubo error).
3. Idempotencia con `Idempotency-Key` en toda operación que cree, cobre o dispare un efecto externo, con test.

### Bloque 7 — Event loop y tareas pesadas
- Implementar **primero la versión ingenua** (la que bloquea) y medirla.
- Implementar después la versión que no degrada el servicio con una de las cuatro estrategias: chunking, streams, worker threads, cola. Justificar en ADR.
- Medir ambas bajo carga (autocannon, k6 o similar): latencia **p50, p95, p99** de un endpoint liviano, pedidos por segundo, **lag del event loop con `monitorEventLoopDelay`**, memoria.
- Hipótesis escrita antes de medir y conclusión después.

### Bloque 8 — Tests
- Dominio (sin HTTP ni base), integración (base real en Docker), seguridad y concurrencia.
- Un único comando los corre todos. Un test que falla en la entrega cuenta como requisito no cumplido.

---

## 6. Plataforma de viajes

### 6.1 Contexto y roles
Un pasajero pide un viaje; el sistema busca choferes disponibles cerca, les ofrece el viaje y el primero que acepta lo toma. El viaje avanza por estados y ambos ven el estado en tiempo real.
Roles mínimos: pasajero, chofer, operador (ve viajes en curso, cancela con motivo), administrador (tarifas, zonas, parámetros).

### 6.2 Alcance funcional mínimo
- Registro y autenticación de pasajeros y choferes; habilitación del chofer otorgada por el administrador.
- El chofer se declara disponible/no disponible y, mientras está disponible, envía su ubicación periódicamente.
- Solicitud de viaje con origen, destino y estimación de precio y tiempo antes de confirmar.
- Búsqueda de choferes cercanos y oferta con tiempo límite de aceptación.
- Máquina de estados: solicitado, asignado, chofer en camino, en curso, finalizado, cancelado por pasajero, cancelado por chofer, sin choferes disponibles.
- Seguimiento en tiempo real del estado y la posición del chofer.
- Tarifa final al terminar y registro del cobro (simulado).
- Historial por pasajero y por chofer, y panel del operador.

### 6.3 Problema central
Un viaje se asigna a **un solo chofer** y un chofer tiene **un solo viaje activo**, incluso con decenas de solicitudes y aceptaciones simultáneas y con cancelaciones justo mientras un chofer acepta.
Se exige:
- **ADR del mecanismo de asignación**: qué se bloquea, en qué orden, qué pasa si dos choferes aceptan en el mismo milisegundo, por qué no hay doble asignación y cómo se evita el interbloqueo (orden de bloqueos).
- Test de **≥50 aceptaciones simultáneas** sobre el mismo viaje: exactamente una tiene éxito, las otras reciben rechazo claro.
- Test de **cancelación simultánea**: el resultado es uno de dos estados definidos y documentados; nunca un viaje asignado a un chofer sin pasajero ni un chofer ocupado sin viaje.
- Test de que un chofer con viaje activo no puede aceptar otro.

### 6.4 Búsqueda geográfica y ubicaciones
- Los choferes disponibles envían ubicación periódicamente (sugerido cada 2 a 5 s). El sistema soporta que lo hagan al mismo tiempo, y **se mide** (ver 6.6).
- La búsqueda de cercanos usa un mecanismo apropiado: PostGIS, geohash o estructura en memoria. **ADR que compare al menos dos opciones** y explique el costo de cada una. No se acepta traer todos los choferes y calcular distancia en JS sin justificar y medir.
- Las ubicaciones históricas se conservan para el recorrido del viaje; el grupo define y documenta una **política de retención o agregación**.
- El endpoint de seguimiento **no expone** la ubicación de un chofer a quien no es su pasajero actual, ni la de un pasajero a quien no es su chofer asignado. **Test obligatorio**.

### 6.5 Tarifa, oferta y tiempo real
- Tarifa siempre calculada en el servidor (distancia, tiempo, parámetros). La estimación previa y el cálculo final usan la misma función; la diferencia se explica. Tests con bordes: distancia cero, viaje que supera el máximo.
- Cada oferta tiene tiempo límite (sugerido 15 a 30 s). Si el chofer no responde, vence y se ofrece al siguiente; si se agota la lista, estado "sin choferes disponibles". **El vencimiento ocurre aunque el chofer haya cerrado la app**.
- Estado del viaje y posición del chofer al pasajero por WebSocket o SSE (justificado). Documentar qué pasa al cortarse y reconectarse la conexión: el cliente recupera el estado actual.

### 6.6 Tarea pesada obligatoria
Recepción masiva de ubicaciones combinada con búsqueda de candidatos. Se exige:
- Un **simulador propio** de **al menos 500 choferes** enviando ubicación **cada 2 segundos**, de forma sostenida durante varios minutos.
- Medir **con y sin la solución elegida**: latencia p50/p95/p99 del endpoint de solicitud de viaje, tiempo hasta la asignación, lag del event loop, pedidos por segundo y memoria.
- Demostrar que bajo esa carga las asignaciones ocurren en un tiempo razonable **definido y declarado por el grupo** (el número lo eligen ustedes; se evalúa que se midió y se cumple).
- La versión ingenua también se implementa y se mide.

### 6.7 Variante H — Reasignación ante fallas (grupo 8)
- Si un chofer asignado deja de enviar ubicación durante un tiempo configurable, o rechaza continuar, el viaje se reasigna a otro chofer sin que el pasajero tenga que volver a pedirlo.
- El historial del viaje conserva todos los choferes que tuvo y por qué cambió cada uno.
- El chofer que perdió el viaje no queda marcado como ocupado, y el que lo recibe no queda con dos.
- **Carrera propia**: el proceso de reasignación decide reasignar exactamente cuando el chofer original vuelve a reportarse. No puede quedar el viaje con dos choferes ni con ninguno.

### 6.8 Qué se muestra en la demo
- Ciclo completo de un viaje con seguimiento en tiempo real.
- Test de 50 aceptaciones simultáneas sobre el mismo viaje.
- Cancelación simultánea a la aceptación.
- Oferta que vence y pasa al siguiente chofer, con la app del chofer cerrada.
- Intento de ver la ubicación de un viaje ajeno, rechazado.
- Carga de 500 choferes corriendo, con medición de latencia y lag antes y después de la solución.
- La variante obligatoria con su condición de carrera.

---

## 7. Artefactos de proceso (extracto)

### 7.1 ADR
Mínimo seis, uno por archivo, numerados. Obligatorios: (1) sistema de módulos, (2) persistencia y acceso a datos, (3) autenticación y autorización, (4) resolución de la carrera principal, (5) solución de la tarea pesada, (6) uno o más a elección.

Formato obligatorio: **Título** (nombra la decisión, no el tema) · **Estado** · **Fecha y participantes** · **Contexto** · **Opciones consideradas** (al menos dos, con ventajas y desventajas reales) · **Decisión** · **Consecuencias** · **Qué nos haría cambiar de decisión**.
Un ADR sin alternativas descartadas no cuenta.

### 7.2 Informe de medición (`docs/mediciones.md`)
Para la tarea pesada y la carrera principal:
1. **Hipótesis** escrita antes de medir, con un número.
2. **Entorno**: máquina, SO, versión de Node, versión de la base, si corría en Docker, qué más corría.
3. **Comando exacto**, copiable y ejecutable.
4. **Resultados** en tabla, versión ingenua vs final: p50, p95, p99, req/s, lag del event loop (máximo y p99), memoria, con unidades.
5. **Conclusión**: si la hipótesis se cumplió y por qué. Una hipótesis refutada vale lo mismo; ajustarla después de ver los datos es un mal resultado.

Mediciones sobre **al menos 30 s de carga sostenida**, repetidas **al menos 3 veces**.

---

## 11.2 Cómo medir
1. Escribir la hipótesis con un número antes de correr nada.
2. Dejar el sistema en estado conocido: misma carga de base en ambas corridas, nada más corriendo.
3. Carga sostenida sobre un endpoint liviano ≥30 s y registrar la línea de base sin la tarea pesada.
4. Repetir con la tarea pesada: primero versión ingenua, después la final.
5. Repetir cada escenario ≥3 veces y registrar las tres.
6. Anotar números con unidades.

El lag del event loop se mide instrumentando el servidor con `monitorEventLoopDelay` y exponiéndolo en un endpoint o en el log, no estimándolo desde afuera.
