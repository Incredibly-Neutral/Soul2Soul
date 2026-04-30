#!/bin/bash

forge create contracts/ENSSubdomainRegistry.sol:ENSSubdomainRegistry \
    --verify \
    --rpc-url https://mainnet.infura.io/v3/5588b2f2645b47bf9d9df736ab328181 \
    --private-key e6ee8b9f77a89edb7cf9b6d1ca3e03568bf6217ae09a2a011d3e467fd992d941 \
    --etherscan-api-key WIRHP12YN15QTZJAUJWPZ82VKFBPVNQB3Y \
    --constructor-args 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e 0x9b8478caf6b6cbd2bc1b944f8219dee954cb7c3de16cff8b4dd0413309632d83 0x752a31b88f742a894747855b25423fc7164fe5e5 0x2546905e21E9108BD8442eE631e1065C7e55d239
