# Imagen de la API para docker compose (perfil "app").
#   docker compose --profile app up -d --build
#
# node:22-slim (glibc): argon2 trae binarios precompilados para esta base.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY migraciones ./migraciones

# Sin root: si alguien explota la app, no es root dentro del contenedor.
USER node
EXPOSE 3000

# exec: node queda como proceso principal y recibe el SIGTERM de Compose
# directamente (apagado ordenado), en vez de que lo intercepte sh.
CMD ["sh", "-c", "node src/infra/db/migrar.js && exec node src/servidor.js"]
