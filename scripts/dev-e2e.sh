#!/usr/bin/env bash
# End-to-end check of the core↔probe transport (TASKS.md F-09).
#
# Starts a real core and a real probe over mutual TLS, watches the handshake and heartbeats,
# kills the core, and confirms the probe reconnects on its own. Development only.
#
# Prerequisites: npm run build, scripts/dev-certs.sh
set -u

# `|| exit`: this script sets -u but not -e, so a failed cd would otherwise carry on and do
# its work in whatever directory it happened to be in.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
logs="dev/data/e2e"
mkdir -p "${logs}"

cleanup() { kill -TERM ${CORE:-0} ${CORE2:-0} ${PROBE:-0} 2>/dev/null || true; }
trap cleanup EXIT

node packages/core/dist/src/main.js --config dev/core.json > "${logs}/core-1.log" 2>&1 &
CORE=$!
sleep 1
# The probe's thread pool as the shipped unit and launcher set it (`P-426`).
UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-16}" \
  node packages/probe/dist/src/main.js --config dev/probe.json > "${logs}/probe.log" 2>&1 &
PROBE=$!
sleep 5

echo "########## core, first run ##########"
cat "${logs}/core-1.log"
echo "########## probe, after connecting ##########"
cat "${logs}/probe.log"

echo "########## stopping the core ##########"
kill -TERM "${CORE}"; wait "${CORE}" 2>/dev/null
sleep 3

echo "########## restarting the core ##########"
node packages/core/dist/src/main.js --config dev/core.json > "${logs}/core-2.log" 2>&1 &
CORE2=$!
sleep 6

echo "########## core, second run ##########"
cat "${logs}/core-2.log"
echo "########## probe, full log ##########"
cat "${logs}/probe.log"
