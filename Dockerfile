FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg gosu passwd \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/config \
    STORAGE_DIR=/storage \
    HLS_DIR=/storage/hls \
    FFMPEG_PATH=

COPY package*.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force

COPY src ./src
COPY public ./public
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

RUN chmod +x /usr/local/bin/entrypoint.sh \
  && mkdir -p /config /storage/hls \
  && chown -R node:node /app /config /storage

VOLUME ["/config", "/storage"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((res) => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["npm", "start"]
