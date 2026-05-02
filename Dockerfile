FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts=false

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/driven.db
RUN mkdir -p /data
COPY --from=build /app/node_modules ./node_modules
COPY server.js package.json ./
COPY public ./public
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
VOLUME ["/data"]
USER node
CMD ["node", "server.js"]
