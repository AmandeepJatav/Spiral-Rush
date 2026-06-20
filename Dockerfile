# ---- Spiral Rush production image ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:20-alpine AS run
ENV NODE_ENV=production
WORKDIR /app
# copy prod deps + source
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY server.js ./server.js
COPY lib ./lib
COPY public ./public
# writable data dir, run as non-root
RUN mkdir -p /app/data && addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app
EXPOSE 3000
ENV PORT=3000 LOG_JSON=1 LOG_LEVEL=info
# container healthcheck hits the /health probe
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "server.js"]
