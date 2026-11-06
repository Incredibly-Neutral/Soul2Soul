# Two stages on the same Alpine base: the only runtime dependency is `viem`, which
# is pure JavaScript, so musl needs nothing compiled and the runtime image is small.
FROM node:22-alpine AS build

WORKDIR /app

# Manifests first: the dependency layer then survives edits to `src/`.
COPY package.json package-lock.json ./

# `npm ci` installs exactly the lockfile, devDependencies included because `tsc`
# is one of them.
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

FROM node:22-alpine

# Same image at run time, but production semantics: the config loader refuses
# AUTH_MODE=none under NODE_ENV=production.
ENV NODE_ENV=production

# `/app` stays owned by root; the `node` user only ever reads it.
WORKDIR /app

COPY package.json package-lock.json ./

# Runtime dependencies only, with the same lockfile; the npm cache is not part of
# the image.
RUN npm ci --omit=dev && npm cache clean --force

# Compiled JavaScript only: no sources, no tests, no `tsx`.
COPY --from=build /app/dist ./dist

# Drop root. The `node` user (uid 1000) ships with the image; nothing here needs
# write access anywhere.
USER node

# Documentation only: the port is chosen by PORT at run time, and Compose publishes
# whatever PORT says. Kept at the default so `docker run -p 2004:2004` is the only
# thing to remember when running the image without Compose.
EXPOSE 8080

# busybox wget is already in Alpine, so no curl. A non-2xx status makes wget exit
# non-zero and prints nothing, and a 200 with anything but `{"ok":true}` fails the
# `grep`: both are unhealthy. The start period covers config load and listen.
# `$PORT` is expanded by the shell at run time, so the check follows the port the
# service was actually told to listen on; 8080 is only the default.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8080}/healthz" | grep -q '"ok":true' || exit 1

# Exec form, so `node` is PID 1 and receives SIGTERM directly: `index.ts` closes
# the server on SIGTERM/SIGINT and force-exits after 20 s. `npm start` would put
# npm in between and swallow the signal.
CMD ["node", "dist/index.js"]
