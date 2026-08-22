# DOOMCRAFT — the game server.
#
# One image that serves the built client AND hosts the rooms. That is not a
# shortcut: `server/src/index.ts` puts a nonce-based Content-Security-Policy on
# every response and a static host cannot (docs/DEPLOY.md), so the day sponsor
# creative ships, the game has to be served from this origin. Until then the
# static Vercel deploy is still the cheap front door and this image is only the
# rooms; `DOOMCRAFT_STATIC` can point at an empty directory and nothing breaks.
#
# WHY THE SERVER IS BUNDLED RATHER THAN `tsc`-COMPILED
#
# `tsc -b` emits `server/dist/*.js` whose imports of `@doomcraft/shared` are left
# as bare specifiers, and the workspace package resolves those to `shared/src/*.ts`
# — TypeScript that Node cannot execute. Running the compiled output would
# therefore need `tsx` (a 30 MB esbuild dependency) in the runtime image, or a
# second package.json exports map that dev and test would have to keep in step.
# One esbuild bundle avoids both: the whole server, shared code inlined, in a
# single 0.5 MB ESM file whose only runtime dependency is `ws`.
#
# Build:  docker build -t doomcraft .
# Run:    docker run -p 8080:8080 -v doomcraft-data:/data doomcraft
# Env contract: docs/ONLINE.md §"Environment".

# ---------------------------------------------------------------------------
# 1. Dependencies. Its own layer so a source-only change does not re-resolve
#    the tree — the lockfile is the cache key.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY client/package.json client/
COPY server/package.json server/
# `playwright` is a devDependency and would pull ~400 MB of browsers into the
# build cache for nothing; it is only ever used by tools/.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --no-audit --no-fund

# ---------------------------------------------------------------------------
# 2. Build. The client bundle and the server bundle, from the same tree, so the
#    two cannot be built from different commits.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build:server \
 && npx vite build --config client/vite.config.ts

# ---------------------------------------------------------------------------
# 3. Runtime. `ws` and nothing else.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DOOMCRAFT_DATA=/data \
    DOOMCRAFT_STATIC=/app/dist

# `ws` is the one thing the bundle leaves external, because it loads optional
# native accelerators (bufferutil, utf-8-validate) by name at runtime and a
# bundler cannot see those.
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund ws@8 \
 && npm cache clean --force

COPY --from=build /app/server/dist/server.mjs ./server/dist/server.mjs
COPY --from=build /app/dist ./dist
# The authored campaign. `levelLibrary()` reads it at boot and resolves a
# `?level=` that names something not installed onto one that is.
COPY --from=build /app/content ./content

# The saved-profile store. A named volume here is what keeps XP across a deploy;
# without one, every restart is a fresh device table and that is a data loss the
# player notices.
# No `VOLUME` instruction: Railway rejects the Dockerfile outright ("docker VOLUME
# is not supported, use Railway Volumes") and on plain Docker an anonymous volume
# here would only hide a missing `-v`. The mount is the orchestrator's job; this
# line just makes sure the directory exists and node can write it.
RUN mkdir -p /data && chown -R node:node /data

USER node
EXPOSE 8080

# /health answers 200 while the process is taking players and 503 the moment it
# starts draining, which is exactly the readiness signal an orchestrator wants.
# Deliberately NOT a liveness probe: a draining host is unhealthy on purpose and
# killing it early is the one thing the drain exists to prevent.
HEALTHCHECK --interval=15s --timeout=3s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# No init shim and no shell: PID 1 is node, so SIGTERM reaches the drain handler
# in server/src/index.ts directly. Wrapped in `sh -c` it would not, and the
# graceful drain would be a comment rather than a behaviour.
STOPSIGNAL SIGTERM
CMD ["node", "server/dist/server.mjs"]
