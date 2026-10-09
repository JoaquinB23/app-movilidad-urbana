# ADR-001: Búsqueda geográfica de candidatos (PostGIS frente a alternativas)

- Estado: Aceptada
- Fecha: 2026-10
- Módulo: Ubicaciones (Persona B)

## Contexto

El módulo necesita responder "qué choferes disponibles están cerca de un punto",
con un radio en metros y un límite de resultados. Es la operación central de la
asignación de viajes: se consulta en cada solicitud y, con 500+ choferes
reportando cada 2 s, la tabla `ubicaciones_actuales` tiene una fila por chofer
pero ALTA rotación (UPSERT constante).

El enunciado exige comparar una versión ingenua contra una final y elegirla
justificando el descarte de alternativas.

## Alternativas consideradas

1. **PostgreSQL sin PostGIS (lon/lat como columnas)** — El filtro por radio
   requiere `acos`, `sin`, `cos` por fila en SQL y un barrido completo; no hay
   índice útil. Para el volumen es demasiado lento y el código queda feo.
   Descartada.

2. **Geohash con prefijo de celda** — Se guarda un geohash y se filtra por
   prefijo (recortar dígitos). Funciona por "cajas": hay que traer N vecinas y
   refinar por distancia real, con búsquedas múltiples y error de borde en las
   celdas. Sufre en las fronteras (dos puntos pegados en celdas adyacentes) y
   complica el orden por distancia (no se puede ORDER BY KNN sobre un string).
   Descartada por precisión y complejidad operativa.

3. **En memoria en Node** — Guardar `{choferId: {lat,lng}}` en un Map y
   calcular Haversine en JS. Es exactamente lo que hace la versión **ingenua**
   (que trae todo desde la base). Funciona para miles de choferes, pero con
   decenas de miles el cálculo sincrónico bloquea el event loop y la memoria se
   duplica entre base y proceso. Se usa como adaptador en memoria para TESTS.

4. **PostGIS con columna `geography(Point,4326)` e índice GiST** — Elegida.

## Decisión

`ubicaciones_actuales.geom` es `GEOGRAPHY(Point, 4326)`. La búsqueda usa:

```sql
WHERE ST_DWithin(u.geom, ST_MakePoint($lng, $lat)::geography, $radioMetros)
ORDER BY u.geom <-> ST_MakePoint($lng, $lat)::geography
LIMIT $limite
```

- `ST_DWithin` con `geography` filtra por distancia real en METROS aprovechando
  el índice GiST (bounding box primero, refina después).
- El operador `<->` es KNN: PostGIS devuelve los puntos por orden de cercanía
  sin materializar la distancia de todos.
- El radio va en metros sobre el elipsoide (WGS84), que es la unidad del dominio.

Se definen **tres adaptadores** del puerto `ServicioGeo`:
- `postgis` (final, arriba);
- `ingenuo` (trae todos los choferes con `SELECT` sin filtro y calcula en JS)
  — obligatorio para medir el delta del bloque 7;
- `memoria` (para tests y arranque sin base).

Todas convergen a `seleccionarCandidatos()` del dominio, que define filtro por
radio, redondeo y desempate; así los adaptadores no pueden divergir.

## Consecuencias

- La consulta real es una sola sentencia parametrizada (sin concatenación).
- El orden de parámetros es `[lng, lat, radioMetros, limite]` en PostGIS (x=lng, y=lat);
  mal documentado es una fuente clásica de bugs. Está comentado en el adaptador.
- El coste de índice GiST por UPSERT es pequeño frente al beneficio de lectura.
- La medición (docs/mediciones.md) compara ingenuo vs final con la tabla de
  percentiles exigida y la hipótesis escrita antes de medir.