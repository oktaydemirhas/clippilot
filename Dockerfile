FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
# The bundled ffmpeg binary is not needed to compile.
RUN npm ci --ignore-scripts
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
# FFmpeg parses untrusted uploads, so it comes from Debian's security-patched package. The ffmpeg-static and
# ffprobe-static binaries ship old builds (ffprobe-static is from 2018) and are only a fallback for local dev.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
ENV DATA_DIR=/data PORT=3000 HOST=0.0.0.0 FFMPEG_PATH=/usr/bin/ffmpeg FFPROBE_PATH=/usr/bin/ffprobe
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
