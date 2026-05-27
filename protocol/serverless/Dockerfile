# serverless / Dockerfile
FROM oven/bun:latest

# Install ca-certificates for HTTPS (IPFS gateways)
RUN apt-get update && apt-get install -y ca-certificates curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install runtime deps
COPY package.json ./
RUN bun install --prod

# Copy source
COPY server.ts ./server.ts

# Expose the HTTP port
EXPOSE 4269

CMD ["bun", "run", "server.ts"]
