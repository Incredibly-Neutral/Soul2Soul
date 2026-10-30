// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IProxyAdmin {
    function upgrade(address proxy, address implementation) external;
    function upgradeAndCall(address proxy, address implementation, bytes memory data) external;
}
