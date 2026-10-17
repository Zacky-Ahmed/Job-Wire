# Explicit build instead of a buildpack.
#
# Nixpacks mounts its cache at /app/node_modules/.cache, and `npm ci`
# removes node_modules before installing — it cannot rmdir a live mount,
# so the build dies with EBUSY. A Dockerfile has no such mount, and it
# pins the Node version rather than letting the platform choose.
#
# Debian provides the glibc runtime required by curl_cffi ARM64 wheels.

FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
    && python3 -m venv /opt/stealth \
    && /opt/stealth/bin/pip install --no-cache-dir stealth-requests==2.0.6 curl_cffi==0.16.3 \
    && /opt/stealth/bin/python -c "from stealth_requests import StealthSession; StealthSession().close()" \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy manifests first so `npm ci` is cached and only re-runs when
# dependencies actually change, not on every source edit.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY --chown=node:node . .

ENV NODE_ENV=production

# Railway containers have an IPv6 address with no route out, and Node 18+
# resolves "verbatim" — so Gmail's AAAA record wins and SMTP dies with
# ENETUNREACH. server.js sets this too; here it also covers `npm run
# test-mail` and friends inside the container.
ENV NODE_OPTIONS="--dns-result-order=ipv4first"

# Railway injects PORT; this is only the local default.
EXPOSE 3000

# Run as the non-root user that the node image already provides.
USER node

CMD ["node", "src/server.js"]
