# Bitácora de ataque cruzado

Fase de ataque cruzado (enunciado, sección 7): el grupo 8 **ataca al grupo 1**
(variante A, precio dinámico) y **es atacado por el grupo 7** (variante G,
flotas y zonas).

> Pendiente: esta bitácora se completa durante la semana de ataque, con el
> sistema del grupo 1 accesible y el nuestro levantado con
> `docker compose --profile app up -d --build` en una máquina accesible.
> Reglas: prohibidos los ataques de volumen (DoS por saturación); una entrada
> por intento, incluidos los fallidos.

## Parte 1 — Nosotros atacamos al grupo 1

Una entrada por intento:

### Intento N — fecha

- **Hipótesis:**
- **Petición exacta** (método, URL, encabezados, cuerpo; copiable):

  ```
  ```

- **Resultado esperado:**
- **Resultado obtenido:**
- **Veredicto:** hallazgo confirmado / defensa efectiva / no concluyente
- **Severidad:** alta / media / baja (justificación)
- **Impacto:**

## Parte 2 — El grupo 7 nos ataca: respuestas a hallazgos

Por cada hallazgo confirmado:

### Hallazgo N — título

- **Severidad acordada o discutida:**
- **Causa raíz** (qué decisión u olvido lo hizo posible):
- **Commit que lo corrige:**
- **Test que reproduce el ataque** (falla antes del arreglo, pasa después):
- **Si no se corrige:** justificación del riesgo aceptado.
