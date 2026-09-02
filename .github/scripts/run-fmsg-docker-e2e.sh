#!/usr/bin/env bash
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Keep the fixture pinned to a reproducible stack revision. This revision
# includes the fmsg v0.6 terminal-message column required by FMSG-005 and the
# reaction-enabled fmsg Web API.
FMSG_DOCKER_REF="${FMSG_DOCKER_REF:-e6f06b3a0f8f89a70e9dc0962fb17c62817108c6}"
FMSG_DOCKER_DIR="$(mktemp -d)"

cleanup_plugin_fmsg_e2e() {
  if [ -f "$FMSG_DOCKER_DIR/test/run-tests.sh" ]; then
    bash "$FMSG_DOCKER_DIR/test/run-tests.sh" cleanup || true
  fi
  rm -rf "$FMSG_DOCKER_DIR"
}
trap cleanup_plugin_fmsg_e2e EXIT

git clone --no-checkout --filter=blob:none https://github.com/markmnl/fmsg-docker.git "$FMSG_DOCKER_DIR"
git -C "$FMSG_DOCKER_DIR" checkout "$FMSG_DOCKER_REF"

# The upstream runner provisions two stacks and exports short-lived delegated
# keys. Sourcing it keeps those values available for this plugin's acceptance.
source "$FMSG_DOCKER_DIR/test/run-tests.sh"

cd "$PLUGIN_ROOT"
FMSG_E2E=1 \
FMSG_E2E_AGENT_API_URL="$HAIRPIN_API_URL" \
FMSG_E2E_AGENT_API_KEY="$ALICE_API_KEY" \
FMSG_E2E_PEER_API_URL="$EXAMPLE_API_URL" \
FMSG_E2E_PEER_API_KEY="$BOB_API_KEY" \
  npm run test:e2e
