# Runs the server over HTTP, for hosting it on the NAS or another always-on machine.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm ci && npm run compile && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    XDG_CONFIG_HOME=/data \
    XDG_STATE_HOME=/data \
    SYNOLOGY_SECRET_STORE=file \
    SYNOLOGY_MCP_HOST=0.0.0.0
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8765/healthz || exit 1
ENTRYPOINT ["node", "dist/index.js"]
CMD ["serve", "--http"]
