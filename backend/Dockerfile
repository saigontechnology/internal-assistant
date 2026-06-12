FROM node:22-alpine AS build
WORKDIR /app
# prisma.config.ts validates POSTGRES_* on load. `prisma generate` doesn't
# need a real DB, but the shared validator fires anyway, so feed it
# placeholders. These never leave the build stage; runtime values come from
# docker-compose at container start.
ENV POSTGRES_HOST=build \
    POSTGRES_PORT=5432 \
    POSTGRES_USER=build \
    POSTGRES_PASSWORD=build \
    POSTGRES_DB=build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
# Generates the Prisma client into node_modules before tsc runs (the imports
# in src/prisma/* won't resolve otherwise).
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Same placeholder rationale as the build stage — `npx prisma generate`
# below loads prisma.config.ts. At container start, docker-compose overrides
# these with the real values from the root .env file.
ENV POSTGRES_HOST=build \
    POSTGRES_PORT=5432 \
    POSTGRES_USER=build \
    POSTGRES_PASSWORD=build \
    POSTGRES_DB=build
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
# Prod-only install — we still need `prisma` (CLI) at runtime for
# `prisma migrate deploy` invoked from the entrypoint, so keep it as a
# dependency rather than dropping --omit=dev's casualty list.
RUN npm ci --omit=dev && npm cache clean --force
# prisma.config.ts imports from `./src/config/database-url.js`. The runtime
# image doesn't ship the TS source, so pull just that one compiled file from
# the build stage to the path the import expects.
COPY --from=build /app/dist/src/config/database-url.js ./src/config/database-url.js
# Re-generate the client against the prod node_modules layout. Cheap, and
# avoids shipping the build stage's node_modules.
RUN npx prisma generate
COPY --from=build /app/dist ./dist
EXPOSE 8000
# Apply any pending migrations on boot, then start the Nest app.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/main.js"]
