# Deploying FPL Optimizer with Docker

One container runs everything: the web UI, the API server, and the
open-fpl-solver (Python + HiGHS). Data (projections, run history, logs)
persists in a Docker volume across updates.

## What's in the repo

- `Dockerfile` — multi-stage build: compiles the React app and API server,
  then installs the solver's Python environment with `uv`.
- `docker-compose.yml` — runs the container on port **8080** with a
  persistent `fplop-data` volume mounted at `/data`.
- `.dockerignore` — keeps dev artifacts and local data out of the image.

## First deploy on the VPS (Hostinger or any Docker host)

```bash
# 1. Get the code onto the VPS
git clone <your-repo-url> fplop
cd fplop

# 2. (Optional) enable Fantasy Football Hub imports
echo 'FFH_SESSION_COOKIE=<your cookie value>' > .env

# 3. Build and start
docker compose up -d --build

# 4. Check it
docker compose logs -f fplop     # Ctrl-C to stop following
curl http://localhost:8080/api/healthz
```

The app is now at `http://<vps-ip>:8080`. First build takes a few minutes
(installs Node deps, builds the frontend, downloads Python 3.14 + solver deps).

### Putting it behind a domain / HTTPS (optional)

If you already run a reverse proxy (nginx, Caddy, Traefik) on the VPS, point
it at `localhost:8080`. Caddy example (`Caddyfile`):

```
fpl.yourdomain.com {
    reverse_proxy localhost:8080
}
```

Otherwise the raw `http://<vps-ip>:8080` works fine for personal use — just
remember there is no login, so anyone with the URL shares your data.

## Updating to a new version

Whenever you've synced a checkpoint you like to git:

```bash
cd fplop
git pull
docker compose up -d --build
```

Your data is safe: it lives in the `fplop-data` volume, not the image.
Note: rebuilding restarts the server, which kills any solve in progress
(it will show as failed in history) — update between runs.

## Useful commands

```bash
docker compose ps                 # status
docker compose logs -f fplop      # live logs (solver progress included)
docker compose restart fplop      # restart without rebuild
docker compose down               # stop (data volume is kept)
docker volume inspect fplop_fplop-data   # where the data lives
docker run --rm -v fplop_fplop-data:/data -v $PWD:/backup alpine \
  tar czf /backup/fplop-backup.tar.gz -C /data .   # backup the store
```

## Sizing

Works comfortably on 2 CPU cores / 8 GB RAM. The solver uses both cores
during a run; memory stays well under 1 GB. Disk usage is a few hundred MB
for the image plus kilobytes per solve run.

## Environment variables (all optional)

| Variable | Default | Purpose |
| --- | --- | --- |
| `FFH_SESSION_COOKIE` | unset | Fantasy Football Hub session cookie for prediction imports |
| `PORT` | `3000` (in-container) | API/web port inside the container |
| `FPLOP_STORE_DIR` | `/data` | Where projections & run history are stored |
| `SERVE_WEB_DIR` | `/app/web` | Built frontend served by the API server |
