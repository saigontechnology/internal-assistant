FROM node:22-alpine AS build
WORKDIR /app
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
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
# Prod-only install — we still need `prisma` (CLI) at runtime for
# `prisma migrate deploy` invoked from the entrypoint, so keep it as a
# dependency rather than dropping --omit=dev's casualty list.
RUN npm ci --omit=dev && npm cache clean --force
# Re-generate the client against the prod node_modules layout. Cheap, and
# avoids shipping the build stage's node_modules.
RUN npx prisma generate
COPY --from=build /app/dist ./dist
EXPOSE 8000
# Apply any pending migrations on boot, then start the Nest app.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/src/main.js"]
