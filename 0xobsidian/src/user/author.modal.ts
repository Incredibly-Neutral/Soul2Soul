import { IMainController } from "../main.ctrlr.js";
import { App, Modal } from "obsidian";

export class AuthorModal extends Modal {

	onSubmit;
    main;

	constructor(app: App, main: IMainController, onSubmit: (name: string, type: string, privateKey?: string) => Promise<void>) {
		super(app);
        this.main = main;
		this.onSubmit = onSubmit
	}

	onOpen() {

		this.setTitle("Create your account");

		const {contentEl} = this;

		const containerDiv = contentEl.createEl('div');
		containerDiv.setCssStyles({ "margin": "0 0 1rem 0", "width": "100%", "display": "flex", "flexDirection":"column", "justifyContent": "flex-start", "alignItems" : "flex-start"})

		containerDiv.createEl('label', { text: 'name:' });
		const name_input = containerDiv.createEl('input', { text: 'name' });
        name_input.setCssStyles({ "margin": "0rem 0rem 1.5rem 0", "width": "100%", "borderRadius": "4px", "padding": "6px 10px", "borderColor": "rgb(171, 171, 171)"});
        
		containerDiv.createEl('label', { text: 'private key (optional — leave blank to generate):' });
		const pk_input = containerDiv.createEl('input', { text: '' });
        pk_input.setCssStyles({ "margin": "0rem 0rem 1.5rem 0", "width": "100%", "borderRadius": "4px", "padding": "6px 10px", "borderColor": "rgb(171, 171, 171)"});
		pk_input.type = "password";
		// Placeholder so it's obvious this is a private key field even when masked
		pk_input.placeholder = "0x... or hex (blank = generate new)";

		const button = contentEl.createEl('button', { text: 'Create' });
		button.addEventListener('click', async () => {
            const pk = pk_input.value.trim();
            try {
                await this.onSubmit(name_input.value, "safe", pk || undefined);
                this.close();
            } catch (err: any) {
                console.error("[oxo-core] Failed to create author:", err);
            }
        });
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}