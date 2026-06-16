# syntax=docker/dockerfile:1

FROM node:24-alpine

# Tini for proper signal handling (clean SIGTERM on `docker stop`).
RUN apk add --no-cache tini

WORKDIR /app

# Install production dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# App source.
COPY server.js ./
COPY public ./public

# Persisted data (history, saved images, optional config.json) lives here.
# Mount a volume at /data in production so it survives container restarts.
ENV DATA_DIR=/data \
    PORT=4317 \
    NODE_ENV=production
RUN mkdir -p /data && chown -R node:node /data /app

USER node
EXPOSE 4317

# Container is healthy once the HTTP server answers.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/status" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
