#!/bin/bash
cast call --rpc-url https://mainnet.infura.io/v3/5588b2f2645b47bf9d9df736ab328181 \
  0x32D75C02008ABC920D85D9b9058582c7217d1dC3 \
  "getText(bytes32,string)(string)" \
  0x9b8478caf6b6cbd2bc1b944f8219dee954cb7c3de16cff8b4dd0413309632d83 "contenthash"
