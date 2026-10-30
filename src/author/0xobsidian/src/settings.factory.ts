import { Setting } from "obsidian";
import { IOXOUser } from "./user/user.js";

/**
 * Returns the block explorer base URL for a given chain qualifier.
 * Used to link to an account's transaction history.
 */
const explorerUrl = (qualifier: string, address: string): string => {
  switch (qualifier) {
    case "basesep":
      return `https://sepolia.basescan.org/address/${address}`;
    case "gno":
      return `https://gnosisscan.io/address/${address}`;
    case "eth":
      return `https://etherscan.io/address/${address}`;
    case "base":
      return `https://basescan.org/address/${address}`;
    default:
      return `https://etherscan.io/address/${address}`;
  }
};

/**
 * Renders a row for each chain showing the 4337 account address and a link
 * to view transactions on the block explorer (etherscan / basescan / etc.).
 */
export const accountField = (
  chain: string,
  author: IOXOUser,
  containerEl: HTMLElement,
) => {
  let chain_name = "";
  let url_qualifier = "";

  switch (chain) {
    case "BASE_SEPOLIA":
      url_qualifier = "basesep";
      chain_name = "Base Sepolia";
      break;
    case "GNOSIS_CHAIN":
      url_qualifier = "gno";
      chain_name = "Gnosis Chain";
      break;
    case "ETH_MAINNET":
      url_qualifier = "eth";
      chain_name = "Ethereum";
      break;
    case "BASE":
      url_qualifier = "base";
      chain_name = "Base";
      break;
    default:
      url_qualifier = chain.toLowerCase();
      chain_name = chain;
      break;
  }

  const settingContainer = containerEl.createDiv("setting-item");
  settingContainer.addClass("settings-safe");

  const info = settingContainer.createDiv("setting-item-info");
  const name = info.createDiv("setting-item-name");
  name.setText("Transactions on " + chain_name);
  const desc = info.createDiv("setting-item-description");
  desc.setText(author.safe || "—");

  const control = settingContainer.createDiv("setting-item-control");

  const explorerButton = control.createEl("a", {
    text: "Open Explorer",
    href: author.safe
      ? explorerUrl(url_qualifier, author.safe)
      : "#",
    attr: {
      target: "_blank",
      class: "clickable-icon",
      style: "margin-left: 8px;",
    },
  });

  explorerButton.innerHTML =
    '<svg viewBox="0 0 100 100" width="16" height="16" class="svg-icon"><path fill="currentColor" stroke="currentColor" d="M18.8,85.1h56l0,0c2.2,0,4-1.8,4-4v-32h-8v28h-48v-48h28v-8h-32l0,0c-2.2,0-4,1.8-4,4v56C14.8,83.3,16.6,85.1,18.8,85.1z"></path><polygon fill="currentColor" stroke="currentColor" points="45.7,48.7 51.3,54.3 77.2,28.5 77.2,37.2 85.2,37.2 85.2,14.9 62.8,14.9 62.8,22.9 71.5,22.9"></polygon></svg>';
};