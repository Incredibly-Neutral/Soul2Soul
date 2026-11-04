#!/bin/bash
set -euo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/_env.sh"

cast call --rpc-url "$L1_RPC" \
  "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e" \
  "resolver(bytes32)(address)" \
  "$(cast namehash blockchain-ethics.soul2soul.eth)"
