FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8 AS tunnel
RUN apk add --no-cache ca-certificates curl unzip
WORKDIR /download
RUN curl -fsSLO https://github.com/openai/tunnel-client/releases/download/v0.0.11/tunnel-client-v0.0.11-linux-amd64.zip \
    && echo "29adfe5c1399dfb9fda9383f230c324355912f50dc36e2e416b1f1322317b3c4  tunnel-client-v0.0.11-linux-amd64.zip" | sha256sum -c - \
    && unzip tunnel-client-v0.0.11-linux-amd64.zip

FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f
LABEL org.opencontainers.image.source="https://github.com/Allmight97/oura-mcp" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.description="Self-hosted read-only Oura MCP for one account per deployment"
RUN addgroup -S -g 10001 tunnel && adduser -S -u 10001 -G tunnel -h /home/tunnel tunnel \
    && mkdir /data && chown node:node /data
COPY --from=tunnel /download/tunnel-client /usr/local/bin/tunnel-client
COPY --from=tunnel /download/cloudflared /usr/local/bin/cloudflared
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "dist/index.js"]
