# HEALTH-11 website (Next.js) for production. Build from the frontend folder:
#   docker build -t health11-web frontend
# compose.production.yml does this for you.
#
# The base image is pinned by its digest (checked with docker pull in step 17):
# Node.js 24.20.0, the LTS version the website is tested with.

# 1) Install exactly the locked packages and build the website.
FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# 2) Run it. "output: standalone" (next.config.ts) puts the server and only the
# packages it needs in .next/standalone, so no npm, source or dev tools ship.
FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
# The image's built-in ordinary user, not root.
USER node
EXPOSE 3000
CMD ["node", "server.js"]
