# app-movilidad-urbana

Plataforma de viajes urbanos en tiempo real (TP Programacion IV - UTN FRRe).

## Arranque previsto

```bash
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
docker compose up -d          # base de datos PostGIS
npm run setup                 # migraciones + datos de prueba
npm run dev                   # API en http://localhost:3000
```

## Roles y permisos

Autenticación por JWT (`Authorization: Bearer <token>`); contraseñas con
argon2id. Detalle de decisiones en `docs/adr/ADR-004-autenticacion-autorizacion.md`.

| Ruta | pasajero | chofer | operador | administrador |
|---|---|---|---|---|
| `POST /auth/registro/pasajero` | público | público | público | público |
| `POST /auth/registro/chofer` (datos del vehículo; queda **no habilitado**) | público | público | público | público |
| `POST /auth/login` (rate limit propio) | público | público | público | público |
| `GET /me` | ✔ | ✔ | ✔ | ✔ |
| `POST /viajes` y ciclo de vida del viaje | ✔ (propio) | ✔ (asignado) | ✔ | ✔ |
| `PUT /choferes/me/disponibilidad`, `POST /choferes/me/ubicacion` | ✖ | ✔ | ✖ | ✖ |
| `GET /viajes/:id/estado`, `/seguimiento`, `/recorrido` | ✔ (dueño) | ✔ (asignado) | ✔ | ✔ |
| `POST /viajes/:id/rechazar-continuar` (dispara reasignación) | ✖ | ✔ (solo el asignado) | ✖ | ✖ |
| `GET /viajes/:id/asignaciones` (historial de choferes con motivo) | ✔ (dueño) | ✖ | ✔ | ✔ |
| `GET /admin/choferes`, `PATCH /admin/choferes/:id/habilitacion` | ✖ | ✖ | ✖ | ✔ |
| `GET|PUT /admin/tarifas`, `/admin/zonas`, `/admin/parametros` | ✖ | ✖ | ✖ | ✔ |
| `GET /metricas` | ✖ | ✖ | ✖ | ✔ |

- **✔ (dueño/asignado)** = autorización **por recurso**: un id ajeno responde
  `404` (no `403`) para no confirmar su existencia (helper
  `autorizarRecurso`, `src/dominio/identidad/autorizacion.js`).
- `PUT /admin/parametros` administra, entre otros, `tiempo_limite_oferta_s`
  (vigencia de ofertas) y `umbral_reasignacion_s` (variante H: worker de
  reasignación por falta de reporte de ubicación, ver
  `docs/adr/ADR-005-reasignacion-variante-h.md`).