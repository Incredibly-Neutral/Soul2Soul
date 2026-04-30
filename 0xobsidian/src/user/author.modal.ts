
import { IMainController } from "../main.ctrlr.js";
import { App, Modal } from "obsidian";

export class AuthorModal extends Modal {

	onSubmit;
    main;

	constructor(app: App, main: IMainController, onSubmit: (name: string, type: string) => Promise<void>) {
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
        
		// containerDiv.createEl('label', { text: 'type:' });
		
		// const type_input = containerDiv.createEl('select');
		// type_input.setCssStyles({ "margin": "0rem 0rem 1.5rem 0", "width": "100%", "borderRadius": "4px", "padding": "6px 10px", "borderColor": "rgb(171, 171, 171)"});
		
		// // Add options to the select
		// type_input.createEl('option', { text: 'Safe', value: 'safe' });
		// type_input.createEl('option', { text: 'WAAP', value: 'waap' });

		const button = contentEl.createEl('button', { text: 'Create' });
        button.addEventListener('click', () => {
            this.onSubmit(name_input.value, "safe")
			this.close()
        });
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}