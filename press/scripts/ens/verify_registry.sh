#!/bin/bash

forge verify-contract 0x53D8c21465b1a6CAEF85AaC5f73E1D9e1914d8b7 \
     contracts/ENSSubdomainRegistry.sol:ENSSubdomainRegistry \
    --chain-id 1 \
    --compiler-version 0.8.20 \
    --num-of-optimizations 0 \
    --etherscan-api-key WIRHP12YN15QTZJAUJWPZ82VKFBPVNQB3Y \
    --constructor-args $(cast abi-encode "constructor(address,bytes32,address,address)" 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e 0x9b8478caf6b6cbd2bc1b944f8219dee954cb7c3de16cff8b4dd0413309632d83 0x752a31b88f742a894747855b25423fc7164fe5e5 0x2546905e21E9108BD8442eE631e1065C7e55d239)
