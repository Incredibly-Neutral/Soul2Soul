#!/bin/bash
set -euo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/_env.sh"

cast call --rpc-url "$L1_RPC" \
  0x32D75C02008ABC920D85D9b9058582c7217d1dC3 \
  "getText(bytes32,string)(string)" \
  0x9b8478caf6b6cbd2bc1b944f8219dee954cb7c3de16cff8b4dd0413309632d83 "contenthash"
