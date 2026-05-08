# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.13 AS build
ARG BUILD_SOURCEMAPS=false
ARG VITE_GIT_SHA=
ARG APP_COMMIT_SHA=
WORKDIR /workspace
ENV TURBO_TELEMETRY_DISABLED=1
ENV BUILD_SOURCEMAPS=${BUILD_SOURCEMAPS}
ENV VITE_GIT_SHA=${VITE_GIT_SHA}
ENV APP_COMMIT_SHA=${APP_COMMIT_SHA}

# Install dependencies first for better cache reuse.
COPY package.json bun.lock bunfig.toml turbo.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/emails/package.json packages/emails/package.json
COPY packages/env/package.json packages/env/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY tooling/tsconfig/package.json tooling/tsconfig/package.json

RUN bun install --frozen-lockfile

# Build the web app (Nitro output in apps/web/.output).
COPY . .
RUN NITRO_PRESET=bun bun run faviconize --filter=@repo/web
RUN NITRO_PRESET=bun bun run build --filter=@repo/web

FROM oven/bun:1 AS runtime
ARG KEEP_SOURCE_MAPS=false

ARG OCI_CREATED=unknown
ARG OCI_VERSION=dev
ARG OCI_REVISION=unknown
ARG OCI_SOURCE=https://github.com/dsi-icl/vizzy-studio

LABEL org.opencontainers.image.title="vizzy-studio" \
      org.opencontainers.image.description="Collaborative multi-tenant presentation system for large video walls" \
      org.opencontainers.image.url="https://github.com/dsi-icl/vizzy-studio" \
      org.opencontainers.image.source="${OCI_SOURCE}" \
      org.opencontainers.image.documentation="https://github.com/dsi-icl/vizzy-studio#readme" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${OCI_VERSION}" \
      org.opencontainers.image.revision="${OCI_REVISION}" \
      org.opencontainers.image.created="${OCI_CREATED}" \
      org.opencontainers.image.vendor="florian-guitton" \
      org.opencontainers.image.base.name="docker.io/oven/bun:1"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    APP_DATA_DIR=/app/data \
    UPLOAD_DIR=/app/data/uploads \
    TMP_DIR=/app/data/tmp \
    ASSET_DIR=/app/data/assets \
    PLAYWRIGHT_BROWSERS_PATH=/app/data/playwright \
    FFMPEG_PATH=/app/data/bin/ffmpeg \
    FFMPEG_STATIC_URL=https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz \
    FFMPEG_STATIC_SHA256=

WORKDIR /app/apps/web
COPY package.json /app/package.json

# Runtime system packages:
# - tini: proper signal handling / zombie reaping
# - ca-certificates: TLS trust store
# - curl/xz-utils: required to fetch/extract static ffmpeg at boot
# - Playwright browser OS deps (Chromium) so boot-time install can run reliably
RUN set -eux; \
    PW_VERSION="$(bun -e "import pkg from '/app/package.json'; const v = pkg?.workspaces?.catalog?.playwright; if(!v) process.exit(1); process.stdout.write(String(v).replace(/^[~^]/,''));")"; \
    echo "$PW_VERSION" > /app/.playwright-version

# Layer A: keep base OS packages current.
RUN set -eux; \
    apt-get update; \
    apt-get -y upgrade; \
    rm -rf /var/lib/apt/lists/*

# Layer B: minimal process/runtime essentials.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends tini ca-certificates curl xz-utils iputils-ping netcat-openbsd gosu; \
    rm -rf /var/lib/apt/lists/*

# Layer browser shared-library dependencies used by Playwright Chromium.
RUN set -eux; \
    PW_VERSION="$(cat /app/.playwright-version)"; \
    bunx "playwright@$PW_VERSION" install-deps chromium; \
    rm -rf /var/lib/apt/lists/*

# Create dedicated non-root user.
RUN groupadd --system --gid 10001 app && \
    useradd --system --uid 10001 --gid 10001 --home /app --shell /usr/sbin/nologin app

# Only copy Nitro runtime artifacts (not source tree/public dev files).
COPY --from=build --chown=app:app /workspace/apps/web/.output/server ./.output/server
COPY --from=build --chown=app:app /workspace/apps/web/.output/public ./.output/public
COPY --from=build --chown=app:app /workspace/apps/web/.output/nitro.json ./.output/nitro.json

RUN set -eux; \
    PW_VERSION="$(cat /app/.playwright-version)"; \
    mkdir -p /tmp/pw && \
    printf '{"name":"pw","private":true}\n' > /tmp/pw/package.json && \
    cd /tmp/pw && bun add "playwright@${PW_VERSION}" && \
    cp -r /tmp/pw/node_modules/. /app/node_modules/ && \
    rm -rf /tmp/pw

# Source maps are not needed in production runtime image.
RUN if [ "${KEEP_SOURCE_MAPS}" = "true" ] || [ "${KEEP_SOURCE_MAPS}" = "1" ]; then \
      echo "Keeping sourcemaps in runtime image"; \
    else \
      find ./.output -type f -name '*.map' -delete || true; \
    fi

COPY apps/web/container-start.sh /usr/local/bin/container-start.sh
RUN sed -i 's/\r$//' /usr/local/bin/container-start.sh && chmod +x /usr/local/bin/container-start.sh

EXPOSE 3000

ENTRYPOINT ["tini", "--", "/usr/local/bin/container-start.sh"]

