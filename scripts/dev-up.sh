#!/usr/bin/env bash
# Starts the database (repairing a container left stuck by a Codespace restart), waits until it accepts
# connections, and applies any pending migrations. Data lives in the pgdata volume and is never touched.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! docker compose up -d db >/dev/null 2>&1; then
  echo "Database container is stuck; recreating it (your data volume is kept)..."
  docker compose rm -f -s db >/dev/null 2>&1 || true
  docker rm -f design_max-db-1 >/dev/null 2>&1 || true
  docker compose up -d db
fi

printf "Waiting for the database"
for _ in $(seq 1 40); do
  if docker compose exec -T db pg_isready -U antigravity -d antigravity >/dev/null 2>&1; then echo " - ready."; break; fi
  printf "."; sleep 1
done
docker compose exec -T db pg_isready -U antigravity -d antigravity >/dev/null 2>&1 || { echo; echo "The database did not become ready."; exit 1; }

npm run --silent db:migrate
