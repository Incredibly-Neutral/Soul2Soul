import { expect } from "chai";
import { ethers } from "hardhat";
import { Protocol } from "../typechain-types";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("Protocol", function () {
  async function deployFixture() {
    const [owner, otherAccount] = await ethers.getSigners();

    const protocol = await ethers.deployContract("Protocol", [], {
      kind: "uups"
    });
    await protocol.waitForDeployment();
    
    await protocol.initialize(owner.address);

    return { protocol, owner, otherAccount };
  }

  describe("Initialization", function () {
    it("Should set the right owner", async function () {
      const { protocol, owner } = await loadFixture(deployFixture);
      expect(await protocol.owner()).to.equal(owner.address);
    });
  });

  describe("Config Management", function () {
    it("Should allow owner to set config", async function () {
      const { protocol, owner } = await loadFixture(deployFixture);
      await protocol.setConfig("New config");
      expect(await protocol.getConfig()).to.equal("New config");
    });

    it("Should not allow non-owner to set config", async function () {
      const { protocol, otherAccount } = await loadFixture(deployFixture);
      await expect(
        protocol.connect(otherAccount).setConfig("Unauthorized config")
      ).to.be.revertedWithCustomError(protocol, "OwnableUnauthorizedAccount");
    });
  });

  describe("PKP Management", function () {
    const testPKP = {
      tokenId: "test-token-id",
      publicKey: "test-public-key",
      addr: "test-address"
    };

    it("Should allow owner to set PKP", async function () {
      const { protocol, owner } = await loadFixture(deployFixture);
      await protocol.setPKP(testPKP.tokenId, testPKP.publicKey, testPKP.addr);
      const pkp = await protocol.getPKP();
      expect(pkp.tokenId).to.equal(testPKP.tokenId);
      expect(pkp.publicKey).to.equal(testPKP.publicKey);
      expect(pkp.addr).to.equal(testPKP.addr);
    });

    it("Should not allow non-owner to set PKP", async function () {
      const { protocol, otherAccount } = await loadFixture(deployFixture);
      await expect(
        protocol.connect(otherAccount).setPKP(testPKP.tokenId, testPKP.publicKey, testPKP.addr)
      ).to.be.revertedWithCustomError(protocol, "OwnableUnauthorizedAccount");
    });
  });
});
