import { IMainController } from "../main.ctrlr";
import { App, Modal } from "obsidian";

export class DomainModal extends Modal {

    main;
	publication;

	constructor(app: App, main: IMainController, publication: any) {
		super(app);
        this.main = main
		this.publication = publication
	}

	async onOpen() {

		this.setTitle("add Domain:");

		const {contentEl} = this;

		const containerDiv = contentEl.createEl('div');
		containerDiv.setCssStyles({ "margin": "0 0 1rem 0", "width": "100%", "display": "flex", "flexDirection":"column", "justifyContent": "flex-start", "alignItems" : "flex-start"})

		containerDiv.createEl('label', { text: 'Domain' });	
		const domain_input = containerDiv.createEl('input', { text: 'domain' });
        domain_input.setCssStyles({ "margin": "0.33rem 0rem 1.5rem 0", "width": "100%", "borderRadius": "4px", "padding": "6px 10px", "borderColor": "rgb(171, 171, 171)"});
		const button = containerDiv.createEl('button', { text: 'create' });
		
		button.addEventListener('click', async () => {

			this.publication.domains.push(domain_input.value);
			this.close()
		});
		
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}