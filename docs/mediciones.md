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

## Entorno (documentado para reproducibilidad)

- Máquina: [completar: CPU, RAM, SO]
- Node: v22 LTS (o superior compatible)
- PostgreSQL 16 + PostGIS 3.4 en Docker Compose (mismo contenedor, volumen local)
- API en `localhost:3000`, base en `localhost:5432`
- Carga: `scripts/carga/simulador-choferes.js` (500 choferes, 1 ubicación/2 s)

## Comandos exactos

```bash
# 1) Preparar (máquina limpia)
Copy-Item .env.example .env
docker compose up -d
npm run setup

# 2) Levantar API (dos terminales para medir y cargar)
npm run dev

# 3) Carga + medición del endpoint liviano en paralelo
#    Terminal A: carga de choferes
node scripts/carga/simulador-choferes.js        # 500 choferes, 5 minutos
#    Terminal B: medición de /health mientras carga
node scripts/carga/carga-autocannon.js --health

# 4) Medición directa del endpoint de ubicación
node scripts/carga/carga-autocannon.js --ubicacion

# 5) Medidas internas con el endpoint interno
#    GET /metricas (rol administrador) → p50/p95/p99 + lag event loop + memoria
```

> Para conmutar versión ingenua/final se toca SOLO `src/composicion.js`:
> `colaHistorial: null` (escritura síncrona) vs inyectado (batcheada).

## Protocolo de corrida

- Duración mínima por corrida: **30 s**.
- **3 repeticiones** por versión; se informan medias y el peor de los tres.
- Entre corridas: 10 s de enfriamiento para que drene la cola.
- Se reporta: p50, p95, p99 de `/health`, req/s, lag del event loop (máx y p99,
  `monitorEventLoopDelay`) y memoria (RSS) como `GET /metricas`.

## Resultados (completar tras correr)

### Busca geográfica: ingenua vs PostGIS (5000 candidatos)

| Versión | r1 p50/p95/p99 | r2 | r3 | req/s | lag máx / p99 | memoria RSS |
|---|---|---|---|---|---|---|
| Ingenua | / | / | / | / | / | / |
| PostGIS | / | / | / | / | / | / |

### Escritura de historial: insert por request vs cola+batching

| Versión | r1 p50/p95/p99 | r2 | r3 | req/s | lag máx / p99 | memoria RSS |
|---|---|---|---|---|---|---|
| Ingenua | / | / | / | / | / | / |
| Final | / | / | / | / | / | / |

## Conclusión (completar tras medir)

[Comparar contra las hipótesis: cuáles se cumplieron, cuáles no, y por qué.
Ej. si la cola no baja la latencia, explicar que el cuello era el UPSERT y no
el INSERT del historial.]