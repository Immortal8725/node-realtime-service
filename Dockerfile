FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src

# Session files live here. Railway rejects Dockerfile VOLUME; attach a
# Railway Volume at /app/data/baileys-auth in the service settings to persist them.
RUN mkdir -p /app/data/baileys-auth

ENV NODE_ENV=production
ENV PORT=4001
ENV BAILEYS_AUTH_DIR=/app/data/baileys-auth
EXPOSE 4001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "src/server.js"]
