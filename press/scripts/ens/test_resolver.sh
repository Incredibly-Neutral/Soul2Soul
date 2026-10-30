#!/bin/bash

cast call --rpc-url https://mainnet.infura.io/v3/5588b2f2645b47bf9d9df736ab328181 \
  "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e" \
  "resolver(bytes32)(address)" \
  "$(cast namehash blockchain-ethics.soul2soul.eth)"
