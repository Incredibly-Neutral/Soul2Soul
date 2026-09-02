# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Install ALL dependencies (including dev) for building
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Runtime stage
FROM node:22-alpine AS runtime

RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# Copy built JS and lockfile from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json

# Install only production dependencies
RUN npm ci --omit=dev --ignore-scripts

# Create webcontent directory (bind-mounted in compose)
RUN mkdir -p /app/webcontent && chown -R app:app /app

USER app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/healthz || exit 1

CMD ["node", "dist/index.js"]
