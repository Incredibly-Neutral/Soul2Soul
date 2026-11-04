#!/bin/bash
# Usage: ./namehash.sh <ens-name>
set -euo pipefail

if [ $# -ne 1 ]; then
    echo "usage: ${0##*/} <ens-name>   # e.g. ${0##*/} soul2soul.eth" >&2
    exit 2
fi

cast namehash "$1"
