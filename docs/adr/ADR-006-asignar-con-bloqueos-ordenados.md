# ADR-006 · Asignar el viaje bloqueando viaje, chofer y oferta en ese orden

**Estado** Implementada para la aceptación de ofertas.

**Fecha** 26/11/2026. **Participantes** Frente A, responsable de Viajes. Pendiente de revisión por el otro integrante.

## Contexto

Dos choferes pueden aceptar ofertas del mismo viaje. También puede pasar que un chofer acepte dos viajes distintos a la vez. En ambos casos tiene que quedar una sola asignación abierta por viaje y por chofer. Un fallo después de aceptar la oferta debe permitir revertir también el cambio de estado del viaje y la apertura de la asignación.

## Opciones consideradas

- **Solo índices únicos parciales y transacción.** PostgreSQL puede impedir ambas duplicaciones y revertir al perdedor. La aplicación descubre el conflicto al escribir y tiene que traducir la restricción que falló. También necesita coordinar la actualización del viaje, el vencimiento de la oferta y la disponibilidad del chofer.
- **Actualización condicional o control optimista.** Una condición sobre el estado o la versión del viaje permite detectar que otro pedido ganó. Tiene bajo costo si hay poca contención. Dos viajes distintos pueden pasar esa condición al mismo tiempo para el mismo chofer, así que hace falta proteger también ese recurso y manejar el conflicto.
- **Bloqueos de fila ordenados e índices únicos parciales.** La segunda transacción espera y revalida el estado confirmado por la primera. Esto agrega espera cuando muchos pedidos compiten por el mismo viaje. Permite dar un rechazo específico y conserva los invariantes aunque otro escritor intente insertar una asignación duplicada.

## Decisión

En una transacción, la aceptación lee el identificador de viaje y chofer de la oferta. Luego toma los bloqueos con `SELECT ... FOR UPDATE` en orden **viaje → chofer → oferta**. Vuelve a verificar la relación entre las tres filas, el dueño de la oferta, su vigencia, el estado del viaje y la disponibilidad del chofer. La asignación abierta se comprueba después de bloquear al chofer.

La transacción actualiza viaje y oferta, cancela las ofertas pendientes restantes, abre la asignación y registra el evento. El seguimiento recibe el nuevo estado después del commit. Los índices únicos parciales de las migraciones 102 y 103 protegen la oferta aceptada por viaje y las asignaciones con `hasta IS NULL` por viaje y por chofer.

## Consecuencias y evidencia

Si dos aceptaciones llegan en el mismo milisegundo, gana la transacción que logra confirmar primero bajo esos bloqueos. El segundo pedido para el mismo viaje encuentra su oferta cancelada. Cuando un chofer compite por dos viajes, ambas transacciones pueden bloquear viajes distintos, pero deben turnarse sobre la fila del chofer. Usar un orden uniforme evita el ciclo en el que una aceptación retiene el chofer esperando el viaje mientras otra retiene el viaje esperando ese chofer.

El test de 50 aceptaciones comprueba un ganador, 49 errores `OFERTA_NO_VIGENTE`, una asignación abierta y un solo evento de aceptación. El segundo escenario comprueba un ganador y un rechazo `CHOFER_OCUPADO`. Se reproduce con:

```powershell
node --env-file=.env --test --test-concurrency=1 tests/concurrencia/aceptacion-simultanea.test.js
```

Implementación en `src/dominio/viajes/casos-de-uso/aceptar-oferta.js` y `src/infra/db/transaccion-pg.js`. Al incorporar cancelación y vencimiento hay que verificar el orden de bloqueo en esas operaciones y probar su carrera con la aceptación. La carrera cancelar/aceptar sigue pendiente de implementación.

## Qué nos haría cambiar de decisión

Si las mediciones muestran que la espera de estos bloqueos impide cumplir el tiempo de asignación acordado, compararíamos una actualización condicional bajo la misma carga. El reemplazo tendría que mantener el rechazo definido para los perdedores y pasar los tests que consultan el estado final en PostgreSQL.
