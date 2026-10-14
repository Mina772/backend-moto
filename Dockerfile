# syntax=docker/dockerfile:1
# Build context is this folder (erp-backend/) — the project is self-contained.
FROM node:22-alpine AS manifests
WORKDIR /repo
COPY package.json package-lock.json* .npmrc* ./
COPY packages/shared/package.json packages/shared/

FROM manifests AS build
RUN npm ci --ignore-scripts
COPY tsconfig.base.json tsconfig.json build.mjs ./
COPY packages packages
COPY src src
RUN npm run build

# Separate install so devDependencies (tsx, esbuild, mongodb-memory-server) never reach the image.
FROM manifests AS prod-deps
RUN npm ci --omit=dev --ignore-scripts
# dist/ already inlines @moto/shared; drop the workspace symlink so it cannot dangle in the runtime image.
RUN rm -rf node_modules/@moto

FROM node:22-alpine AS runtime
ARG APP_VERSION=0.0.0
ENV NODE_ENV=production \
    APP_VERSION=$APP_VERSION \
    UPLOAD_DIR=/app/uploads
WORKDIR /app
RUN addgroup -S moto && adduser -S moto -G moto
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=build /repo/dist ./dist
COPY --from=build /repo/package.json ./package.json
RUN mkdir -p /app/uploads && chown -R moto:moto /app
USER moto
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:4000/api/health/ready || exit 1
CMD ["node", "dist/server.js"]
