FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src

# Session files live here. Do not add a Dockerfile VOLUME — Railway Railpack
# rejects it. Attach a Railway Volume at /app/data/baileys-auth instead.
RUN mkdir -p /app/data/baileys-auth

ENV NODE_ENV=production
ENV PORT=4001
ENV BAILEYS_AUTH_DIR=/app/data/baileys-auth
EXPOSE 4001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
