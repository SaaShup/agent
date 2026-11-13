FROM node:24-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-alpine
ENV NODE_ENV=production DATAPATH=/data PORT=1880 HTTP_SECURE=false
WORKDIR /app
RUN apk add --no-cache util-linux openssl
RUN mkdir -p /data && chown node:node /data
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY entrypoint.sh ./entrypoint.sh
USER node
EXPOSE 1880
VOLUME /data
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 CMD ["node", "src/healthcheck.js"]
LABEL prometheus_scrape_agent="true" prometheus_address="agent:1880"
ENTRYPOINT ["./entrypoint.sh"]
