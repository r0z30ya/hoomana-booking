# hbook — multi-stage production image
# Build:  docker build -t hbook .
# Run:    docker compose up -d

# ── base ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS base
RUN apk add --no-cache openssl libc6-compat
WORKDIR /app

# ── deps: install + generate prisma client ───────────────────────────
FROM base AS deps
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate

# ── build: compile TypeScript ────────────────────────────────────────
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npx prisma generate \
 && npm install -D typescript@^5 \
 && npx tsc -p tsconfig.json

# ── runtime: minimal, non-root ───────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./
# prisma CLI ships in runtime deps on purpose: `migrate deploy` runs at start
RUN addgroup -S hbook && adduser -S hbook -G hbook && chown -R hbook:hbook /app
USER hbook
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
