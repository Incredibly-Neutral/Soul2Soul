import { IMainController } from "../main.ctrlr";
import { App, Modal, TFile } from "obsidian";

export class RevokeModal extends Modal {

    main;
	publication;
	onSubmit: () => void;

	constructor(app: App, main: IMainController, publication: any, onSubmit : () => void) {
		super(app);
        this.main = main
		this.publication = publication
		this.onSubmit = onSubmit;
	}

	async onOpen() {

		this.setTitle("Revoke");
		this.setContent(`By clicking the button you will revoke permission to publish and rerender ${this.publication} without this content item`);

		const {contentEl} = this;

		const containerDiv = contentEl.createEl('div');
		containerDiv.setCssStyles({ "margin": "1rem 0 1rem 0", "width": "100%", "display": "flex", "flexDirection":"column", "justifyContent": "flex-start", "alignItems" : "flex-start"})

		const button = containerDiv.createEl('button', { text: 'continue' });
		
		button.addEventListener('click', async () => {
			this.onSubmit()
			this.close()
		});
		
	}

	onClose(publication?: string) {
		
		if (publication) {
			// return tag
		}

		const {contentEl} = this;
		contentEl.empty();
	}
}