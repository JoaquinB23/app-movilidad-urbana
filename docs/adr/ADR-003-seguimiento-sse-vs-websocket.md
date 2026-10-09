# ADR-003: Seguimiento en tiempo real — SSE frente a WebSocket

- Estado: Aceptada
- Fecha: 2026-10
- Módulo: Ubicaciones (Persona B)

## Contexto

GET /viajes/:id/seguimiento debe entregar, a quien participa del viaje, el
estado y la posición de la contraparte en tiempo real, y soportar reconexión
con `Last-Event-ID` para no perder frames cuando se corta la red.

## Alternativas consideradas

1. **WebSocket** — Comunicación full-duplex. Aporte real (bindireccional) que
   acá no hace falta: el pasajero/chofer NO manda mensajes por este canal, las
   ubicaciones entran por el POST ordinario. Costos concretos:
   - protocolo propio (mensajes, ACK, padding, ping/pong a mano);
   - no tiene control de flujo ni reconexión nativa: hay que escribir un
     heartbeat y un resume manual (rehacer `Last-Event-ID` a mano);
   - requiere biblioteca (ws / socket.io) o mucho código ad-hoc.
   Descartado porque **agrega bidireccionalidad que no usamos**.

2. **Polling corto** — El cliente consulta /estado cada 1 s. Simple, pero con
   N seguidores multiplica requests y latencia; no es "tiempo real" de verdad.
   Se mantiene /estado como SNAPSHOT para reconexión, pero no como canal
   principal. Descartado como canal principal.

3. **SSE (Server-Sent Events)** — Elegido.

## Decisión

El canal es `text/event-stream` nativo de HTTP/1.1:

- Flujo unidireccional servidor→cliente, que es exactamente lo que se necesita.
- Reconexión nativa de los navegadores: el cliente reabre y manda
  `Last-Event-ID`; el estándar define que se envíe la línea `id:` por frame.
- Se apoya en el bus de eventos en memoria, con **log acotado por canal** y
  contador monótono: `eventosDesde(canal, ultimoId)` reenvía lo perdido.
- Heartbeat con comentario (`: ping`) cada 15 s para detectar peers muertos y
  mantener el puerto del reverse-proxy abierto.
- `X-Accel-Buffering: no` para que un proxy intermedio no bufferice el stream.
- Se cierra la conexión con un timeout duro (1 h) para no acumular sockets
  huérfanos dementes; el cliente se reconecta por sí solo.

### Autorización del stream

La autorización es por recurso y se decide ANTES de abrir el stream:
`solo pasajero dueño ve al chofer; solo el chofer asignado ve al pasajero`;
cualquier otro actor recibe 403 (RECURSO_AJENO) antes de escribir el primer
byte. Un stream ya abierto no cambia de autenticación (el actor quedó fijado).

## Consecuencias

- Cero dependencias nuevas: Express 5 soporta escribir un stream HTTP directo.
- Unidireccional: el cliente que quiera mandar datos usa los endpoints
  ordinarios (POST /ubicacion), manteniendo la separación de responsabilidades.
- El log acotado del bus significa que una reconexión muy antigua no recupera
  frames anteriores a la capacidad: el snapshot /estado cubre ese caso.