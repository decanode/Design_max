#!/usr/bin/env bash
# One command for local development: database + migrations + API + web. Ctrl+C stops the API and web servers.
set -euo pipefail
cd "$(dirname "$0")/.."
./scripts/dev-up.sh
trap 'kill 0' EXIT
npm run --silent dev:api &
npm run --silent dev:web &
wait
