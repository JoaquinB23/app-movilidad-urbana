# Mediciones

Módulo: Ubicaciones (Persona B). Bloque 7 — Event loop y tareas pesadas.

La tarea pesada del módulo es el **registro de ubicaciones con historial**
(`POST /choferes/me/ubicacion` y su escritura en `ubicaciones_historial`).
Se comparan dos versiones:

| Versión | Qué hace | Archivo clave |
|---|---|---|
| **Ingenua** | `INSERT` del historial DENTRO del request, uno por fila | `registrarUbicacionChofer` (sin cola) + `agregarHistorial` |
| **Final** | Encola en `ColaHistorial` y escribe en LOTES con `unnest` | `cola-historial-memoria.js` + `agregarHistorialEnLote` |

Se mide también el costo de la búsqueda geográfica (PostGIS GiST vs ingenua en
JS), porque es candidata a tarea pesada del módulo.

## Hipótesis (escritas ANTES de medir)

1. La latencia p95 de `POST /choferes/me/ubicacion` en la versión ingenua crece
   con la concurrencia: con 500 choferes enviando a la vez será al menos **3×**
   la versión final (más de 300 ms de p95 contra ~100 ms).
2. El lag del event loop bajo carga de la versión ingenua supera los **50 ms**
   de p99 (el INSERT síncrono bloquea liberando la cola de conexiones), mientras
   que la versión final se mantiene por debajo de **10 ms**.
3. La búsqueda geográfica ingenua (traer todas las filas y calcular en JS) será
   **≥10×** más lenta que PostGIS con GiST en p95 con 5000 candidatos.
4. `GET /health` (endpoint liviano) degrada su p99 en la versión ingenua al
   menos **2 ms** por cada lote de ubicaciones; en la versión final no debería
   moverse del ruido (< 1 ms de delta).
5. Memoria: la versión final usa ~**10-40 MB** extra (buffer de la cola y el
   bus), despreciable frente al RSS del proceso (~100 MB).

6. Demo, hipótesis previa a las corridas: con 500 choferes enviando posición
   cada 2 s y una solicitud de viaje por segundo, al menos el 95 % de todos
   los pedidos de la versión final tendrá chofer en menos de **30 segundos**.
   Se informan también el p95 de los asignados y los pedidos fallidos, sin
   chofer o fuera de plazo. La observación continúa hasta 60 s.

## Entorno

Registrado automáticamente por `scripts/carga/medir-escenario.js` en cada JSON
de `resultados/`.

- Máquina: AMD Ryzen 5 7600 (6 núcleos / 12 hilos), 31,7 GB de RAM.
- SO: Windows 11 Pro (NT 10.0.26300), Docker Desktop (motor Linux sobre WSL2).
- Node: **v24.18.0** (el proyecto exige ≥ 22; la CI corre en 22).
- PostgreSQL 16.4 + PostGIS 3.4.3 en Docker Compose (`movilidad-db`, volumen
  local). La API corre en el host (fuera de Docker) y llega a la base por el
  puerto publicado 5432.
- Corriendo al mismo tiempo: la API, el simulador de choferes y autocannon en
  la misma máquina (compiten por CPU: es parte del entorno, igual en todas las
  corridas). Además, tres contenedores de otro proyecto sin carga.
- Fecha: 2026-11-26.

### Entorno y protocolo de la serie de asignación (hipótesis 6)

La serie de asignación se ejecutó en otra máquina: Windows 11 Pro, AMD Ryzen
5 PRO 5650G, 15,37 GiB de RAM. Docker Desktop 29.9.3 disponía de 12 CPU
virtuales y 7,44 GiB. La API (Node 22.23.5), PostgreSQL 16.4 con la imagen
`postgis/postgis:16-3.4`, el simulador y k6 1.0.0 corrieron dentro de Docker.
También estaban levantados la API, PostgreSQL y Alloy de la demo, y dos
contenedores de otro proyecto. La carga de esta serie usó una red sin salida
y una base nueva para cada corrida.

Para reproducir desde la raíz, con las dependencias del proyecto instaladas
y Docker en ejecución:

```powershell
node scripts/carga/medir-asignacion.js
```

El comando alterna ingenua (búsqueda JS e historial directo) y final (PostGIS
e historial en cola), tres veces cada una. Cada corrida comienza con las
mismas migraciones, 500 choferes y 50 pasajeros. Primero solicita `/health`
durante 30 s sin carga. Luego programa 60 tandas de 500 posiciones a intervalos
de 2 s. Los choferes consultan sus ofertas y aceptan la primera. Cuando la base
tiene las 500 posiciones iniciales, k6 empieza a enviar un pedido por segundo
durante 60 s. El cliente consulta el estado cada 250 ms hasta observar la
asignación, agotar los candidatos o alcanzar el límite de observación.
La ubicación y el destino se eligen aleatoriamente, por lo que se compara el
mismo perfil de carga con rutas distintas.

La latencia del POST es la duración HTTP medida por k6. La espera del pasajero
se cuenta desde antes de enviar el POST hasta observar el estado `asignado`.
El porcentaje dentro del plazo usa todos los pedidos en el denominador.
El lag del event loop se mide en el servidor con `monitorEventLoopDelay`
durante la ventana de k6, incluido el tiempo para terminar viajes pendientes.
RSS es la memoria del proceso de la API al cerrar la ventana. Los JSON con
los datos de cada repetición están en `resultados/asignacion/`.

### Resultados de asignación bajo carga

| Corrida | POST p50 / p95 / p99 (ms) | Espera p50 / p95 / p99 (s) | Asignados / pedidos | En menos de 30 s | HTTP de k6 (req/s) | Lag máx / p99 (ms) | RSS (MB) |
|---|---|---|---|---|---|---|---|
| ingenua 1 | 8,0 / 88,4 / 144,2 | 2,21 / 3,85 / 33,26 | 60/60 | 57 (95,0 %) | 8,9 | 133,2 / 79,3 | 229,7 |
| ingenua 2 | 12,1 / 117,2 / 209,1 | 2,28 / 32,28 / 32,30 | 61/61 | 54 (88,5 %) | 12,6 | 127,3 / 84,0 | 225,4 |
| ingenua 3 | 11,8 / 220,1 / 281,5 | 1,56 / 32,35 / 32,42 | 61/61 | 56 (91,8 %) | 9,6 | 289,1 / 91,4 | 234,5 |
| final 1 | 12,1 / 90,4 / 151,3 | 2,22 / 2,37 / 33,26 | 61/61 | 58 (95,1 %) | 8,1 | 128,4 / 86,2 | 225,9 |
| final 2 | 21,8 / 236,3 / 328,1 | 2,31 / 32,31 / 32,37 | 61/61 | 55 (90,2 %) | 11,6 | 167,1 / 87,5 | 223,1 |
| final 3 | 18,5 / 149,2 / 192,9 | 2,25 / 32,29 / 32,39 | 61/61 | 54 (88,5 %) | 12,3 | 138,5 / 92,2 | 227,9 |

La tasa HTTP de k6 incluye el pedido y las consultas de estado durante toda
la ejecución. El simulador genera tráfico adicional. En cada corrida completó
60 tandas en aproximadamente 119 s, desde el inicio de la primera hasta la
última respuesta. Los percentiles de la columna POST son del cliente; los de
la línea base son del servidor.

| Corrida | Base /health p50 / p95 / p99 (ms) | Base req/s | Base lag máx / p99 (ms) | Base RSS (MB) | Ubicaciones completadas bajo carga | Fallidas |
|---|---|---|---|---|---|---|
| ingenua 1 | 0,42 / 0,59 / 0,77 | 9,8 | 21,3 / 20,8 | 102,5 | 30000 | 0 |
| ingenua 2 | 0,42 / 0,58 / 1,07 | 9,8 | 21,1 / 20,8 | 89,2 | 30000 | 0 |
| ingenua 3 | 0,41 / 0,57 / 0,82 | 9,8 | 21,0 / 20,8 | 92,0 | 30000 | 0 |
| final 1 | 0,42 / 0,61 / 0,80 | 9,8 | 21,4 / 20,9 | 89,2 | 30000 | 0 |
| final 2 | 0,40 / 0,58 / 0,91 | 9,8 | 22,4 / 20,8 | 89,0 | 30000 | 0 |
| final 3 | 0,42 / 0,58 / 1,35 | 9,8 | 21,3 / 20,9 | 87,1 | 30000 | 0 |

**Conclusión de la hipótesis 6.** La versión final asignó los 183 pedidos y
167 (91,3 %) cumplieron el plazo. La meta del 95 % se alcanzó en una de las
tres repeticiones. Los 16 restantes consiguieron chofer después de los 30 s.
La ingenua asignó 182 de 182, con 167 (91,8 %) dentro del plazo. En esta
serie ambas versiones tuvieron esperas similares para el pasajero.

En la tercera corrida final se contrastó la espera con las filas de ofertas:
54 viajes aceptaron la primera oferta entre 1,01 y 2,16 s después de crearse
el viaje; los otros siete aceptaron la segunda entre 31,01 y 32,12 s. El
vencimiento de la primera oferta está configurado en 30 s. Esto explica los
siete casos tardíos de esa corrida. Los tiempos observados por k6 también
incluyen la red y la consulta periódica del estado. La consulta de contraste,
ejecutada en la base temporal antes de cerrarla, fue:

```sql
SELECT o.orden, count(*),
       round(min(extract(epoch FROM (o.respondida_en - v.creado_en)))::numeric, 2) AS min_s,
       round(max(extract(epoch FROM (o.respondida_en - v.creado_en)))::numeric, 2) AS max_s
FROM ofertas_viaje o JOIN viajes v ON v.id = o.viaje_id
WHERE o.estado = 'aceptada'
GROUP BY o.orden ORDER BY o.orden;
```

Una ejecución preliminar no llegó a iniciar k6 por una diferencia entre los
loopbacks IPv4 e IPv6. También se repitió la segunda corrida final cuando el
lector del resumen mezcló JSON y texto de consola. Las seis filas de las
tablas corresponden a corridas completas con su JSON guardado.

## Comandos exactos

```powershell
# 1) Preparar (una vez)
Copy-Item .env.example .env        # completar DB_PASSWORD, JWT_SECRETO, SEED_PASSWORD
docker compose up -d
npm ci
npm run setup
npm run carga:seed                 # 500 choferes y 50 pasajeros de carga

# 2) Historial: tres escenarios, tres corridas cada uno
#    (cada corrida levanta su propio servidor; no hace falta npm run dev)
foreach ($c in 1..3) { foreach ($e in 'base','ingenua','final') {
  node --env-file=.env scripts/carga/medir-escenario.js --escenario $e --corrida $c --salida resultados
} }

# 3) Búsqueda geográfica con 5000 candidatos
$env:CANTIDAD_CHOFERES='5000'; npm run carga:seed
foreach ($c in 1..3) { foreach ($e in 'postgis','ingenua') {
  node --env-file=.env scripts/carga/medir-busqueda-geo.js --estrategia $e --corrida $c --salida resultados
} }
```

La versión se elige por variable de entorno, sin tocar código:
`HISTORIAL_MODO=directo` (ingenua) o `cola` (final); `GEO_ESTRATEGIA=ingenua`
o `postgis`.

## Protocolo de corrida

**Historial** (`scripts/carga/medir-escenario.js`):

1. Estado conocido: se borran historial y últimas posiciones de los choferes de
   carga, y quedan no disponibles.
2. Se levanta la API con el escenario: `base` (final, sin carga), `ingenua`
   (`HISTORIAL_MODO=directo` + 500 choferes) o `final` (`HISTORIAL_MODO=cola` +
   500 choferes). Pool de PostgreSQL por defecto (10 conexiones).
3. El simulador pone disponibles a los 500 choferes y cada uno envía su
   ubicación cada **2 s**; 15 s de calentamiento.
4. `GET /metricas?reiniciar=1`: la ventana medida no incluye el arranque.
5. **30 s** de autocannon sobre `GET /health` (10 conexiones).
6. `GET /metricas`: lag del event loop (`monitorEventLoopDelay`, máximo y p99)
   y memoria del servidor en esa ventana.
7. El simulador informa la latencia de cada `POST /ubicacion` que envió
   (12.500 por corrida) y cuántas fallaron.

**Búsqueda geográfica** (`scripts/carga/medir-busqueda-geo.js`): 5000
choferes disponibles en una espiral de ~10 km; 30 s de búsquedas
(`radio 5000 m`, `límite 5`) con 10 en vuelo contra el adaptador real, midiendo
la latencia de cada una y el lag del event loop del proceso. Antes de cada
corrida: reposicionar y `VACUUM (ANALYZE)`.

Ninguna corrida tuvo errores ni respuestas que no fueran 2xx/202.

## Resultados

Las celdas por corrida son `p50 / p95 / p99` en milisegundos. "Prom." es el
promedio de las tres corridas.

### Escritura de historial: insert por request vs cola + lotes (serie oficial)

Código final de esta rama (sentencias preparadas en el camino de ubicación).

`POST /choferes/me/ubicacion` (medido por el simulador, 500 choferes cada 2 s):

| Versión | r1 | r2 | r3 | Prom. p95 |
|---|---|---|---|---|
| Ingenua | 491,2 / 880,6 / 916,6 | 561,1 / 989,5 / 1072,4 | 570,0 / 975,5 / 1122,8 | **948,5 ms** |
| Final | 454,8 / 672,5 / 737,8 | 471,9 / 743,0 / 785,2 | 539,1 / 839,0 / 1388,6 | **751,5 ms** |

`GET /health` (endpoint liviano, autocannon 30 s) y servidor:

| Versión | r1 p50/p95/p99 | r2 | r3 | req/s (r1/r2/r3) | lag máx (ms) | lag p99 (ms) | RSS (MB) |
|---|---|---|---|---|---|---|---|
| Base (sin carga) | 1,4 / 2,2 / 3,4 | 1,5 / 2,4 / 3,4 | 1,5 / 2,4 / 3,4 | 7258 / 6678 / 6661 | 60,9 / 50,2 / 31,7 | 23,8 / 23,4 / 23,7 | 115 / 116 / 116 |
| Ingenua | 1,4 / 2,9 / 3,9 | 1,5 / 3,2 / 4,3 | 1,5 / 3,2 / 4,5 | 6046 / 5741 / 5696 | 45,9 / 49,9 / 60,6 | 28,5 / 30,1 / 30,6 | 318 / 289 / 315 |
| Final | 1,4 / 2,9 / 4,1 | 1,5 / 3,2 / 4,6 | 1,5 / 3,5 / 5,7 | 6227 / 5764 / 5621 | 45,2 / 44,8 / 43,7 | 26,9 / 30,3 / 31,7 | 302 / 286 / 243 |

Promedios: `/health` p99 base 3,4 · ingenua 4,2 · final 4,8 ms. Lag p99 base
23,6 · ingenua 29,7 · final 29,6 ms. RSS base 116 · ingenua 307 · final 277 MB.

**Serie 1 (anterior, sin sentencias preparadas)**, mismo protocolo
(`resultados/serie-1-sin-preparar/`): `POST /ubicacion` p95 promedio ingenua
843,9 ms · final 695,9 ms; `/health` p99 base 3,6 · ingenua 4,0 · final 4,0 ms;
lag p99 base 24,3 · ingenua 27,7 · final 29,6 ms; RSS 117 · 310 · 286 MB.
Misma conclusión que la serie oficial.

### Búsqueda geográfica: ingenua vs PostGIS (5000 candidatos, serie oficial)

| Versión | r1 p50/p95/p99 | r2 | r3 | búsquedas/s | lag máx (ms) | lag p99 (ms) | RSS (MB) | Prom. p95 |
|---|---|---|---|---|---|---|---|---|
| PostGIS | 1,2 / 2,1 / 3,2 | 1,2 / 2,4 / 3,7 | 1,2 / 2,1 / 3,3 | 7725 / 7052 / 7494 | 21,2 / 18,7 / 46,3 | 10,8 / 11,1 / 11,1 | 100 / 99 / 99 | **2,2 ms** |
| Ingenua | 64,3 / 83,8 / 98,9 | 65,7 / 88,5 / 101,6 | 63,6 / 87,4 / 103,4 | 151 / 149 / 153 | 175,8 / 163,5 / 153,6 | 87,2 / 90,8 / 92,2 | 239 / 310 / 317 | **86,6 ms** |

**Series anteriores de la búsqueda** (se conservan en `resultados/`):

- `serie-descartada-geo/`: sin `VACUUM` entre corridas. La primera corrida de
  PostGIS dio p95 6,6 ms y las dos siguientes ~430 ms. Se descartó porque la
  base no quedaba en un estado conocido entre corridas.
- `serie-sin-preparar-geo/`: con `VACUUM`, pero con la consulta **sin
  preparar**: PostGIS p95 promedio **449,6 ms** contra la ingenua 84,5 ms (la
  ingenua resultaba más rápida). `EXPLAIN ANALYZE` mostró que planificar la
  consulta de PostGIS costaba ~10 ms y ejecutarla ~7 ms; preparada, 1,4 + 1,5 ms.
  A partir de ese hallazgo el adaptador usa una sentencia preparada con nombre
  (`src/infra/db/servicio-geo-postgis.js`) y se repitió la serie.

## Conclusión

| # | Hipótesis | Resultado |
|---|---|---|
| 1 | `POST /ubicacion` ingenua ≥3× la final (p95 >300 ms vs ~100 ms) | **Refutada.** La ingenua es 1,26× la final (948 vs 752 ms de p95) y las dos están muy por encima de lo esperado. |
| 2 | Lag p99 ingenua >50 ms; final <10 ms | **Refutada.** Ingenua 29,7 ms y final 29,6 ms: iguales entre sí y solo ~6 ms sobre la línea de base (23,6 ms). |
| 3 | Búsqueda ingenua ≥10× más lenta que PostGIS en p95 | **Se cumple**: 86,6 vs 2,2 ms, ~39× (y 50× más búsquedas por segundo). Solo con la consulta preparada; sin preparar, la hipótesis fallaba. |
| 4 | `/health` p99 +2 ms en la ingenua; final <1 ms de delta | **Refutada.** Ingenua +0,8 ms y final +1,4 ms sobre la base: ninguna degrada lo previsto y la final no queda en el ruido. |
| 5 | La final usa 10-40 MB extra, despreciable frente a ~100 MB | **No se pudo observar.** La base usa 116 MB; con carga, las dos versiones suben a ~280-310 MB y la final queda por **debajo** de la ingenua. Lo que pesa es la carga (500 conexiones, pedidos en vuelo), no la cola. |

**Por qué la cola no cambió casi nada.** La hipótesis 1 suponía que el
`INSERT` del historial dentro del pedido era el cuello. No lo es: cada
`POST /ubicacion` hace además, siempre, la lectura del chofer, el `UPSERT` de su
última posición y la búsqueda de su viaje activo, y con 500 pedidos que llegan
juntos cada 2 s la mayor parte del tiempo se va **esperando a la base**. El lado
servidor lo confirma: en una corrida de control, el servidor midió ~316 ms de
mediana por pedido con el lag p99 del event loop en 35 ms, es decir, el proceso
no estaba bloqueado sino esperando. Quitar un `INSERT` de cuatro operaciones
baja la latencia ~20 %, que es lo que se ve.

Se probaron tres explicaciones del cuello, ninguna alcanza sola (corridas de
control de 30 s con el simulador, fuera de la tabla):

- **Planificación de consultas**: el `UPSERT` con `geography` tardaba ~8 ms en
  planificarse y 0,4 ms en ejecutarse. Se prepararon las sentencias del camino
  caliente; la latencia de `POST /ubicacion` no cambió (serie oficial vs serie 1).
- **Tamaño del pool**: con `DB_POOL_MAX=40` en lugar de 10, la mediana bajó de
  449 a 381 ms (~15 %).
- **Espera de escritura del WAL**: con `synchronous_commit=off`, la mediana del
  servidor bajó de 311 a 252 ms (~19 %).

La causa que queda sin aislar es el costo de cada ida y vuelta entre la API en
Windows y PostgreSQL dentro de la VM de Docker Desktop. **No está medido**; es
la próxima medición a hacer: la API dentro de Compose (`--profile app`), en la
misma red que la base.

**Lag de la línea de base.** El lag p99 de ~24 ms ya está en la línea de base
sin carga: lo produce el propio autocannon saturando el event loop con ~7000
pedidos/s a `/health`. Por eso las hipótesis 2 y 4, que esperaban diferencias
de pocos milisegundos, quedan dentro de ese piso. Para separarlas haría falta
medir `/health` a una tasa fija y baja, en lugar de a máxima velocidad.

**Qué sí resolvió la versión final.** La cola saca el `INSERT` del pedido y
escribe por lotes (12.500 posiciones en lotes de hasta 200), y desde esta
entrega además no pierde lotes si la base falla (reintentos con espera
creciente y tope de memoria). Bajo esta carga y en este entorno, eso no se
traduce en una latencia menor apreciable.

**Hallazgo de la búsqueda geográfica.** PostGIS es la opción correcta, pero
solo con la consulta preparada: sin preparar, planificar costaba más que
ejecutar y bajo concurrencia la cola de PostGIS (p95 ~450 ms) quedaba peor que
la ingenua. Se corrigió en el adaptador y beneficia a `POST /viajes`, que usa
esta búsqueda.
