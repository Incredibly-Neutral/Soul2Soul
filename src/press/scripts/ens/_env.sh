#!/bin/bash
# Shared environment for the ENS ops scripts. Sourced, never executed.
#
# Resolves, in one place:
#   REPO_ROOT     from this file's own location (the tree sits under src/)
#   L1_RPC        MAINNET_RPC_URL, else derived from VITE_DRPC_API_KEY
#   ETHERSCAN_KEY for --verify / verify-contract
#   DEPLOY_KEY    DEPLOYER_PRIVATE_KEY, else PROTOCOL_PRIVATE_KEY
#
# Nothing secret lives in these scripts any more: the root .env is the only
# source, so a rotation is one file and a git history that never held the key.

ENV_SH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$ENV_SH_DIR/../../../.." && pwd)"

set -a
# shellcheck source=/dev/null
. "$REPO_ROOT/.env"
set +a

# Same order as src/shared/src/rpc.ts: the explicit env RPC takes the DRPC slot,
# otherwise the DRPC load balancer is derived from the API key.
L1_RPC="${MAINNET_RPC_URL:-}"
if [ -z "$L1_RPC" ]; then
    : "${VITE_DRPC_API_KEY:?set MAINNET_RPC_URL or VITE_DRPC_API_KEY in $REPO_ROOT/.env}"
    L1_RPC="https://lb.drpc.live/eth/$VITE_DRPC_API_KEY"
fi

: "${ETHERSCAN_API_KEY:?ETHERSCAN_API_KEY missing from $REPO_ROOT/.env}"
ETHERSCAN_KEY="$ETHERSCAN_API_KEY"

# Deployment signs from an EOA. Prefer a dedicated DEPLOYER_PRIVATE_KEY; fall
# back to the protocol owner key so nothing new has to be added to .env.
DEPLOY_KEY="${DEPLOYER_PRIVATE_KEY:-${PROTOCOL_PRIVATE_KEY:?set DEPLOYER_PRIVATE_KEY or PROTOCOL_PRIVATE_KEY in $REPO_ROOT/.env}}"

export REPO_ROOT L1_RPC ETHERSCAN_KEY DEPLOY_KEY
