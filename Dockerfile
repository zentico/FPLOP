# ---------------------------------------------------------------------------
# FPL Optimizer — single-container production image
#   web UI (built React app) + API server + open-fpl-solver (Python/HiGHS)
# Build:  docker compose build     Run:  docker compose up -d
# ---------------------------------------------------------------------------

# ---- Stage 1: build the web app and API server -----------------------------
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile

# Vite requires BASE_PATH and PORT at build time; the app is served at "/".
ENV BASE_PATH=/ PORT=3000 NODE_ENV=production
RUN pnpm --filter @workspace/fpl-optimizer run build \
 && pnpm --filter @workspace/api-server run build

# ---- Stage 2: runtime -------------------------------------------------------
FROM node:22-bookworm-slim
# uv manages the solver's Python (3.14) and dependencies.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

WORKDIR /app

# Vendored solver: install its Python environment at build time so the first
# solve doesn't pay the download cost.
COPY solver/open-fpl-solver ./solver/open-fpl-solver
RUN cd solver/open-fpl-solver && uv sync && uv run python -c "import highspy" \
 && mkdir -p data/results

# Bundled server + built web assets.
COPY --from=build /app/artifacts/api-server/dist ./server
COPY --from=build /app/artifacts/fpl-optimizer/dist/public ./web

ENV NODE_ENV=production \
    PORT=3000 \
    SERVE_WEB_DIR=/app/web \
    FPLOP_STORE_DIR=/data

VOLUME /data
EXPOSE 3000

CMD ["node", "--enable-source-maps", "/app/server/index.mjs"]
