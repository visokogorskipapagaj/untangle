#!/bin/sh
#
# Deploys the image CI just published. Run by the `deploy` job in .github/workflows/ci.yml
# on the self-hosted runner, which lives on the box behind the tunnel.
#
# Nothing is built here. The image arriving from ghcr.io has already had typecheck and the
# full test suite run against it, so this script's only job is to swap it in without losing
# the pool and without leaving a broken container up.
set -eu

SERVICE=untangle

# ---- the runtime secrets ---------------------------------------------------------------
#
# The PostHog personal key and project id, which compose.prod.yaml substitutes into the
# container's environment. They live in a file on the box rather than in this repository,
# and specifically *outside* the checkout: `actions/checkout` cleans untracked files on
# every run, so a `.env` next to the compose file would be deleted by the next deploy and
# the stats would go quietly idle. `$HOME` survives.
#
# The file is plain `KEY=value` lines — see .env.example for the three names. Create it as
# the user the runner runs as, with no sudo (it is that user's own home directory, and sudo
# leaves it root-owned and unreadable by everything that needs it):
#
#   umask 177 && cat > ~/untangle.env <<'EOF'
#   POSTHOG_PERSONAL_API_KEY=phx_...
#   POSTHOG_PROJECT_ID=...
#   POSTHOG_HOST=https://us.posthog.com
#   EOF
#
# `$HOME` here is the *runner's* home, which is not necessarily the home of whoever set the
# box up. If the runner is a service account, the file goes in its home rather than yours —
# or set UNTANGLE_ENV_FILE to point elsewhere.
#
# Absent, the deploy proceeds without it. That is deliberate and it is the important part:
# analytics is the least important thing this box does, and a missing secrets file must
# never be the reason the game and the pool fail to come back up. /api/stats serves nulls.
ENV_FILE=${UNTANGLE_ENV_FILE:-$HOME/untangle.env}

COMPOSE="docker compose -f compose.prod.yaml"
if [ -f "$ENV_FILE" ]; then
  # Before -f, and both before the subcommand: these are flags to `docker compose` itself.
  # Note $COMPOSE is deliberately unquoted everywhere below, so a path with spaces in it
  # would split — keep this somewhere boring.
  COMPOSE="docker compose --env-file $ENV_FILE -f compose.prod.yaml"
  echo "runtime env from $ENV_FILE"
else
  echo "no $ENV_FILE — deploying without PostHog stats (the game is unaffected)"
fi
HEALTH_URL=${UNTANGLE_HEALTH_URL:-http://127.0.0.1:8000/api/pars}
HEALTH_TIMEOUT=${UNTANGLE_HEALTH_TIMEOUT:-45}
BACKUPS=${UNTANGLE_BACKUPS:-$HOME/untangle-backups}
KEEP=20

# What is running right now, by image id. This is the rollback target, and it has to be
# captured before the pull — afterwards `latest` means the new one.
previous=$($COMPOSE images --quiet "$SERVICE" 2>/dev/null || true)

# ---- the pool, before anything else -------------------------------------------------
#
# Pooled clear times are the only state here and they are not regenerable: they are what
# every stage's deadline is derived from. The volume survives a normal deploy on its own,
# but "on its own" is doing a lot of work in a sentence about the one irreplaceable thing.
mkdir -p "$BACKUPS"
if [ -n "$($COMPOSE ps -q "$SERVICE" 2>/dev/null || true)" ]; then
  stamp=$(date +%Y%m%d-%H%M%S)
  if $COMPOSE cp "$SERVICE:/data/pool.json" "$BACKUPS/pool-$stamp.json" 2>/dev/null; then
    echo "pool backed up to $BACKUPS/pool-$stamp.json"
  else
    echo "no pool to back up yet"
  fi
  # Trimmed rather than kept forever; twenty deploys back is further than anyone would go.
  ls -1t "$BACKUPS"/pool-*.json 2>/dev/null | tail -n "+$((KEEP + 1))" | xargs -r rm -f
fi

# ---- swap the image -----------------------------------------------------------------

echo "pulling"
$COMPOSE pull
$COMPOSE up -d

# ---- prove it actually came up --------------------------------------------------------
#
# `up -d` returns as soon as the container is started, which is not the same as the server
# being able to answer. /api/pars touches the store, so a 200 means the pool loaded too.
echo "waiting for health"
i=0
while [ "$i" -lt "$HEALTH_TIMEOUT" ]; do
  if curl -fsS -o /dev/null "$HEALTH_URL" 2>/dev/null; then
    echo "healthy after ${i}s"
    docker image prune -f >/dev/null 2>&1 || true
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

# ---- it did not ------------------------------------------------------------------------

echo "unhealthy after ${HEALTH_TIMEOUT}s"
$COMPOSE logs --tail 50 "$SERVICE" || true

if [ -n "$previous" ]; then
  echo "rolling back to $previous"
  # By id rather than by tag: `latest` now points at the image that just failed.
  UNTANGLE_IMAGE="$previous" $COMPOSE up -d
  echo "rolled back"
else
  echo "nothing to roll back to — this was the first deploy"
fi

exit 1
