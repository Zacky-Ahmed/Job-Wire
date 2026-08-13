# Explicit build instead of a buildpack.
#
# Nixpacks mounts its cache at /app/node_modules/.cache, and `npm ci`
# removes node_modules before installing — it cannot rmdir a live mount,
# so the build dies with EBUSY. A Dockerfile has no such mount, and it
# pins the Node version rather than letting the platform choose.
#
# alpine is safe here: every dependency is pure JavaScript (bcryptjs not
# bcrypt, cheerio, the mongodb driver's optional native extras are not
# required), so there is no node-gyp build step to worry about.

FROM node:20-alpine

WORKDIR /app

# Copy manifests first so `npm ci` is cached and only re-runs when
# dependencies actually change, not on every source edit.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

ENV NODE_ENV=production

# Railway injects PORT; this is only the local default.
EXPOSE 3000

# Run as the non-root user that the node image already provides.
USER node

CMD ["node", "src/server.js"]
