#!/usr/bin/env bash
# rebuild-dsh-web.sh — rebuild and restart the office harness in one step.
#
# The unit runs built output from each package's lib/, so a rebuild and a
# restart are one operation: building underneath a running process races the
# files it is still serving. Run this detached if you are talking to the
# harness through the very GUI it is about to restart:
#
#     setsid nohup /root/deepseek-harness/deploy/rebuild-dsh-web.sh \
#       >/root/.dsh/rebuild.log 2>&1 < /dev/null &
#
# The one thing this script will not do is start a build that failed. A failed
# build leaves the service stopped and the log naming the step, which is
# recoverable; starting it would serve a half-written tree, which is not.

set -euo pipefail

REPO="${DSH_REPO:-/root/deepseek-harness}"
UNIT="${DSH_UNIT:-dsh-web}"
HEALTH_URL="${DSH_HEALTH_URL:-http://127.0.0.1:3080/}"

step() { printf '\n=== %s ===\n' "$1"; }

cd "$REPO"

step "pre-flight"
git rev-parse --abbrev-ref HEAD
git rev-parse --short HEAD
git status --porcelain | head -20
echo "node $(node --version) / pnpm $(pnpm --version)"

step "stopping $UNIT"
# Stopping first is the point of this script: it is what makes the rebuild safe.
systemctl stop "$UNIT"
echo "stopped"

step "clean"
# Stale lib/ output is the failure this guards against. A package that moved
# left its old build behind, tsdown resolved the package name to that leftover
# through a hoisted node_modules link, and the build died on a symbol the
# current source no longer exports. Cleaning costs a few minutes and removes
# the whole class of problem; skipping it risks a failed build that strands the
# service, which costs a lot more.
pnpm run clean

step "pnpm install"
# Restores what clean took. It does NOT prune a stale hoisted link in
# node_modules/.pnpm/node_modules for a package that has moved -- that link
# survives and still resolves to the abandoned directory. If a build ever fails
# on a symbol that appears nowhere in src/, look for one first:
#   find . -maxdepth 6 -type l -lname '*<package-dir>*'
pnpm install

step "build:lib"
# tsc is the long pole and the one thing worth a large heap. The harness's own
# script already passes 4096; this box has 8 GB, so leave it alone.
pnpm run build:lib

step "build:web"
pnpm run build:web

step "starting $UNIT"
systemctl start "$UNIT"

step "health check"
for attempt in $(seq 1 30); do
  if code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL"); then
    if [ "$code" = "200" ]; then
      echo "$HEALTH_URL -> 200 after ${attempt}s"
      break
    fi
  fi
  if [ "$attempt" = "30" ]; then
    echo "FAILED: $HEALTH_URL did not answer 200 within 30s" >&2
    systemctl status "$UNIT" --no-pager >&2 || true
    journalctl -u "$UNIT" -n 40 --no-pager >&2 || true
    exit 1
  fi
  sleep 1
done

step "profile loaded the scoping plugin?"
if grep -q "session-scope" /root/.dsh/web.log 2>/dev/null; then
  echo "  session-scope mentioned in web.log"
else
  echo "  no session-scope line in web.log (it logs nothing on a clean load)"
fi

step "done"
systemctl status "$UNIT" --no-pager | head -12
