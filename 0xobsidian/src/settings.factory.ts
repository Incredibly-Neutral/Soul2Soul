import { Setting } from "obsidian";
import { IOXOUser } from "./user/user.js";

export const safeField = (chain: string, author: IOXOUser, containerEl: HTMLElement) => {

    let chain_name = "";
    let url_qualifier = "";

    switch (chain) {
        case "BASE_SEPOLIA":
            url_qualifier = "basesep";
            chain_name = "Base Sepolia";
            break;
        case "GNOSIS_CHAIN":
            url_qualifier  = "gno";
            chain_name = "Gnosis Chain";
            break;
        default:
            url_qualifier = chain.toLowerCase();
            chain_name = chain;
            break;
    }

    const settingContainer = containerEl.createDiv('setting-item');
    settingContainer.addClass('settings-safe');

    const info = settingContainer.createDiv('setting-item-info');
    const name = info.createDiv('setting-item-name');
    name.setText('Safe on: ' + chain_name);
    const desc = info.createDiv('setting-item-description');
    desc.setText(`${author.safe}`);

    const control = settingContainer.createDiv('setting-item-control');
    // const safeAddress = control.createEl('input', {
    //     type: 'text',
    //     value: author.safe || "",
    //     attr: {
    //         readonly: true,
    //         style: 'text-align: right; direction: rtl; width: 100%; margin-right: 8px;'
    //     }
    // });

    const copyButton = control.createEl('button', {
        text: 'Copy',
        cls: 'clickable-icon'
    });
    
    copyButton.addEventListener('click', async () => {
        if (author.safe == undefined) return;
        await navigator.clipboard.writeText(author.safe);
        copyButton.setText('Copied!');
        setTimeout(() => copyButton.setText('Copy'), 2000);
    });

    const button = control.createEl('a', {
        text: 'Open',
        href: `https://app.safe.global/apps?safe=${url_qualifier}:${author.safe}`,
        attr: {
            target: '_blank',
            class: 'clickable-icon',
            style: 'margin-left: 8px;'
        }
    });

    button.innerHTML = '<svg viewBox="0 0 100 100" width="16" height="16" class="svg-icon"><path fill="currentColor" stroke="currentColor" d="M18.8,85.1h56l0,0c2.2,0,4-1.8,4-4v-32h-8v28h-48v-48h28v-8h-32l0,0c-2.2,0-4,1.8-4,4v56C14.8,83.3,16.6,85.1,18.8,85.1z"></path><polygon fill="currentColor" stroke="currentColor" points="45.7,48.7 51.3,54.3 77.2,28.5 77.2,37.2 85.2,37.2 85.2,14.9 62.8,14.9 62.8,22.9 71.5,22.9"></polygon></svg>';
}