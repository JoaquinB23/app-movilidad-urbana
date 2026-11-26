# Modelo de dominio y de datos

## Entidades y tablas

| Entidad | Tabla | Migración | Qué guarda |
|---|---|---|---|
| Usuario | `usuarios` | 001 | Email único (sin distinguir mayúsculas), hash argon2id, rol (`pasajero`, `chofer`, `operador`, `administrador`) |
| Chofer | `choferes` | 001 | Vehículo (patente única), `habilitado` (lo otorga un administrador), `disponible` (lo declara el chofer) |
| Viaje | `viajes` | 101 | Pasajero, estado, origen y destino, estimación (distancia, duración, tarifa), tarifa final, motivo de cierre |
| Oferta | `ofertas_viaje` | 102 | Viaje ofrecido a un chofer, en orden, con vencimiento; `pendiente → aceptada \| rechazada \| vencida \| cancelada` |
| Asignación | `asignaciones_viaje` | 103 | Qué chofer tuvo el viaje y cuándo (`desde`, `hasta`, `motivo_fin`). Abierta = `hasta IS NULL`. Es el historial de choferes de la variante H |
| Evento de viaje | `viajes_eventos` | 104 | Registro append-only de cada transición: quién, cuándo, de qué estado a cuál y por qué |
| Cobro | `cobros` | 105 | Cobro simulado de un viaje finalizado |
| Clave de idempotencia | `claves_idempotencia` | 001 | `(usuario, clave)` → hash del pedido y respuesta original |
| Ubicación actual | `ubicaciones_actuales` | 200 | Última posición de cada chofer (`geography`, índice GiST) |
| Historial de ubicaciones | `ubicaciones_historial` | 200 | Posiciones crudas, asociadas al viaje activo; clave natural `(chofer_id, timestamp)` |
| Configuración | `parametros`, `tarifas`, `zonas` | 300, 301 | Lo que edita el administrador: tiempo de oferta, umbral de reasignación, radio de búsqueda, tarifa |

Rangos de migraciones por módulo: `001` base, `1xx` Viajes, `2xx` Ubicaciones,
`3xx` Identidad y reasignación.

## Máquina de estados del viaje

Tabla canónica: `TRANSICIONES` en `src/dominio/viajes/maquina-estados.js` (los
tests recorren esa tabla; no se duplica en otro lado).

```
                 aceptar_oferta (chofer)          salir_en_camino (chofer)        iniciar (chofer)         finalizar (chofer)
  solicitado ──────────────────────► asignado ─────────────────────► chofer_en_camino ──────────────► en_curso ──────────────► finalizado
      │                                 │  ▲                              │                                │
      │ agotar_candidatos (sistema)     │  └── reasignar (sistema, H) ────┘                                │
      ▼                                 │                                                                   │
  sin_choferes                          ├── cancelar_pasajero (pasajero) ─► cancelado_pasajero              │
                                        ├── cancelar_chofer (chofer) ─────► cancelado_chofer                │
                                        └── cancelar_operador (operador, con motivo) ─► cancelado_pasajero ◄┘
```

- `cancelar_pasajero`: desde `solicitado`, `asignado` y `chofer_en_camino`.
- `cancelar_chofer`: desde `asignado` y `chofer_en_camino` (no en curso).
- `cancelar_operador`: desde cualquier estado no terminal; motivo obligatorio.
- `reasignar` (variante H): `asignado` o `chofer_en_camino` vuelven a
  `asignado` con otro chofer. Lo dispara el worker o
  `POST /viajes/:id/rechazar-continuar`.
- Terminales: `finalizado`, `cancelado_pasajero`, `cancelado_chofer`,
  `sin_choferes`.

La transición se valida en orden: evento conocido → actor correcto → par
(estado, evento) en la tabla → motivo si hace falta. Un actor equivocado da
`ACTOR_NO_AUTORIZADO` y un par inexistente `TRANSICION_INVALIDA`.

## Invariantes y dónde se garantizan

| Invariante | Dónde |
|---|---|
| Un viaje tiene a lo sumo **un chofer** asignado | Índice único parcial `asignaciones_viaje (viaje_id) WHERE hasta IS NULL` + lock del viaje |
| Un chofer tiene a lo sumo **un viaje activo** | Índice único parcial `asignaciones_viaje (chofer_id) WHERE hasta IS NULL` + lock del chofer |
| Un viaje tiene a lo sumo **una oferta aceptada** | Índice único parcial en `ofertas_viaje` (102) |
| Al terminar un viaje, el chofer queda **libre** | `transicionarViaje` cierra la asignación en la misma transacción que el estado terminal |
| Un viaje se **cobra una vez** | `UNIQUE (viaje_id)` en `cobros` |
| El mismo pedido repetido no duplica efectos | `claves_idempotencia` reservada en la transacción del efecto |
| Una ubicación repetida no se duplica | `UNIQUE (chofer_id, timestamp)` en el historial |
| Un chofer no habilitado no queda disponible | Condición `habilitado OR disponible = false` dentro del `UPDATE` |

## Orden de bloqueos

Siempre **viaje → chofer → oferta**, en todas las operaciones que tocan más de
una de esas filas (`aceptarOferta`, `transicionarViaje`, `reasignarViaje`,
`continuarOferta`). Con un orden único, dos transacciones nunca esperan cada
una lo que tiene la otra, y no hay interbloqueos. Las búsquedas que reparten
trabajo usan `FOR UPDATE SKIP LOCKED`. Ver ADR-005 y ADR-006.

## Arquitectura

Hexagonal por módulo (ADR-007): `src/dominio/<modulo>` contiene reglas y casos
de uso que reciben puertos; `src/infra` contiene los adaptadores (PostgreSQL,
HTTP, en memoria para tests); `src/composicion.js` es el único lugar que los
conecta. ESLint impide que el dominio importe infraestructura.
