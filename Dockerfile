# Provider-neutral, always-on web process with in-process worker lanes.
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
# Prefer IPv4 on hosts without outbound IPv6 routing. No provider API dependency.
ENV NODE_OPTIONS="--dns-result-order=ipv4first"
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
