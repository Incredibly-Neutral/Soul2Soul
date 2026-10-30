import { IMainController } from "../main.ctrlr";
import { App, Modal } from "obsidian";

export class NewPublicationModal extends Modal {

    main;
	ensName: string;
	onSubmit: (name: string, owners: string[], authors: string[], devRepository: string, commit: string) => void;

	constructor(app: App, main: IMainController, ensName: string, onSubmit: (name: string, owners: string[], authors: string[], devRepository: string, branch: string) => void) {
		super(app);
        this.main = main;
		this.ensName = ensName;
		this.onSubmit = onSubmit;
	}

	onOpen(ensName?: string) {

		this.setTitle("New publication:");

		const {contentEl} = this;

		const containerDiv = contentEl.createEl('div');
		containerDiv.setCssStyles({ "margin": "0 0 1rem 0", "width": "100%", "display": "flex", "flexDirection":"column", "justifyContent": "flex-start", "alignItems" : "flex-start"})

		containerDiv.createEl('label', { text: 'Name' });	
		const name_input = containerDiv.createEl('input', { text: 'name' });
        name_input.setCssStyles({ "margin": "0rem 0rem 1.5rem 0", "width": "100%", "borderRadius": "4px", "padding": "6px 10px", "borderColor": "rgb(171, 171, 171)"});
		name_input.value = this.ensName;

		containerDiv.createEl('label', { text: 'Github repo' });	
		const dev_input = containerDiv.createEl('input', { text: 'dev_folder' });
        dev_input.setCssStyles({ "margin": "0rem 0rem 1.5rem 0", "width": "100%", "borderRadius": "4px", "padding": "6px 10px", "borderColor": "rgb(171, 171, 171)"});
		dev_input.value = "https://github.com/joera/website-starter";

		containerDiv.createEl('label', { text: 'Branch' });	
		const branch_input = containerDiv.createEl('input', { text: 'dev_folder' });
        branch_input.setCssStyles({ "margin": "0rem 0rem 1.5rem 0", "width": "100%", "borderRadius": "4px", "padding": "6px 10px", "borderColor": "rgb(171, 171, 171)"});
		branch_input.value = "main";

		containerDiv.createEl('label', { text: 'Owners' });	
		const owners_input = containerDiv.createEl('input', { text: 'owners' });
        owners_input.setCssStyles({ "margin": "0rem 0rem 1.5rem 0", "width": "100%", "borderRadius": "4px", "padding": "6px 10px", "borderColor": "rgb(171, 171, 171)"});
        owners_input.value = "enter an address that you can use with use walletconnect"

		containerDiv.createEl('label', { text: 'Authors' });	
		const authors_input = containerDiv.createEl('input', { text: 'authors' });
        authors_input.setCssStyles({ "margin": "0rem 0rem 1.5rem 0", "width": "100%", "borderRadius": "4px", "padding": "6px 10px", "borderColor": "rgb(171, 171, 171)"});
        authors_input.value = this.main.oxo.ctrlr.account['ETH_MAINNET'].address;

		const button = containerDiv.createEl('button', { text: 'create' });

        button.addEventListener('click', () => {
			this.onSubmit(name_input.value, [owners_input.value], [authors_input.value], dev_input.value,branch_input.value)
            // this.main.publication.new(name_input.value, [owners_input.value], [authors_input.value], dev_input.value, "latest");
			this.close()
        });
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}