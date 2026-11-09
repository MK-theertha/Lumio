#!/usr/bin/env bash
# Deploys image digests to a Docker Compose host over SSH, checks health, and restores the previous
# release on failure. The host holds its env file at /opt/lumio/.env.runtime.
# This assumes a VM target; replace when the hosting decision (open question Q17) is made.
set -euo pipefail

: "${DEPLOY_TARGET:?}" "${HEALTH_URL:?}" "${API_IMAGE:?}" "${WORKER_IMAGE:?}" "${FRONTEND_IMAGE:?}"

SSH=(ssh -i "$HOME/.ssh/id_deploy" -o BatchMode=yes "$DEPLOY_TARGET")
scp -i "$HOME/.ssh/id_deploy" docker-compose.prod.yml "$DEPLOY_TARGET:/opt/lumio/docker-compose.prod.yml"

release() {
  "${SSH[@]}" bash -s <<EOF
set -euo pipefail
cd /opt/lumio
cat > .release <<RELEASE
API_IMAGE=$1
WORKER_IMAGE=$2
FRONTEND_IMAGE=$3
LUMIO_ENV_FILE=/opt/lumio/.env.runtime
RELEASE
set -a; . ./.release; . ./.env.migrate; set +a
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d --remove-orphans
EOF
}

healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 5 "$HEALTH_URL/healthz/ready" >/dev/null; then return 0; fi
    sleep 5
  done
  return 1
}

"${SSH[@]}" 'cd /opt/lumio && if [ -f .release ]; then cp .release .release.previous; fi'
release "$API_IMAGE" "$WORKER_IMAGE" "$FRONTEND_IMAGE"

if healthy; then
  echo "Deployment healthy"
  exit 0
fi

echo "Health check failed; rolling back" >&2
previous=$("${SSH[@]}" 'cat /opt/lumio/.release.previous 2>/dev/null || true')
if [ -z "$previous" ]; then
  echo "No previous release to restore" >&2
  exit 1
fi
value() { printf '%s\n' "$previous" | sed -n "s/^$1=//p"; }
release "$(value API_IMAGE)" "$(value WORKER_IMAGE)" "$(value FRONTEND_IMAGE)"
exit 1
