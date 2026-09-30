# app-movilidad-urbana

Plataforma de viajes urbanos en tiempo real (TP Programacion IV - UTN FRRe).

## Arranque previsto

```bash
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
docker compose up -d          # base de datos PostGIS
npm run setup                 # migraciones + datos de prueba
npm run dev                   # API en http://localhost:3000
```